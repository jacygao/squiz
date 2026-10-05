/**
 * What a round's conclusion is reported as, and what one firing of the hook
 * does.
 *
 * A firing runs as a process. An exit code, the stream a line landed on, and
 * whether the process ended while the host it started still runs are properties
 * of a process, and none of them is observable from inside this one. The
 * fixtures run the hook without the top-level trap, so a throw that escapes the
 * hook fails the test instead of being turned into the exit 0 it expects.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import type { Finding } from "../findings/finding.ts";
import type { CommentPosting } from "../github/summary.ts";
import type { RoundConfinement } from "../loop/confinement.ts";
import { readState, type StateWrite } from "../loop/episode-state.ts";
import { episodeAt } from "../loop/episode.ts";
import type { FindingOutcome } from "../loop/post-findings.ts";
import type { EpisodeSummary } from "../loop/post-summary.ts";
import type { ClosingReason } from "../loop/round-decision.ts";
import type { RoundConclusion, RoundFailure } from "../loop/round.ts";
import type { AppliedVerdict } from "../loop/verdicts.ts";
import { standIn } from "../testing/stand-in.ts";
import type { MarkWrite } from "../worktree/shared-tree.ts";
import { failureIn, unreviewedIn } from "./hook.ts";
import { failureLine } from "./report.ts";

const PULL_REQUEST = 142;

// § 7's rows arrive here as conclusions, because the round reports every one of
// them as a value rather than by throwing.

function failedRound(failure: RoundFailure, reason: string): RoundConclusion {
  return { outcome: "failed", failure, reason };
}

/** A round the reviewer failed, carrying what it put on the pull request anyway. */
function salvagedRound(
  failure: RoundFailure,
  reason: string,
  outcomes: readonly FindingOutcome[] = [],
  ruled: readonly AppliedVerdict[] = [],
): RoundConclusion {
  return {
    outcome: "failed",
    failure,
    reason,
    salvaged: {
      pullRequest: PULL_REQUEST,
      posted: [],
      findings: { outcomes },
      verdicts: {
        threads: ruled,
        unapplied: [],
      },
    },
  };
}

/**
 * A round that closed the episode. Its summary went up unless a test says
 * otherwise, which is the shape a healthy episode ends in.
 */
function closedRound(
  because: ClosingReason,
  outcomes: readonly FindingOutcome[] = [],
  ruled: readonly AppliedVerdict[] = [],
  unreadableDiff?: Error,
  summary: CommentPosting = { outcome: "posted" },
  recorded: StateWrite = { outcome: "written" },
): RoundConclusion {
  return {
    outcome: "close",
    because,
    summary,
    recorded,
    pullRequest: PULL_REQUEST,
    posted: [],
    findings: unreadableDiff === undefined ? { outcomes } : { outcomes, unreadableDiff },
    verdicts: {
      threads: ruled,
      unapplied: [],
    },
  };
}

/**
 * A close the round reached before the review: the bound was already spent, so no
 * reviewer ran and no comment was composed.
 */
function closedBeforeTheReview(because: ClosingReason, summary: EpisodeSummary): RoundConclusion {
  return {
    outcome: "close",
    because,
    summary,
    recorded: { outcome: "written" },
    pullRequest: PULL_REQUEST,
    posted: [],
    findings: { outcomes: [] },
    verdicts: { threads: [], unapplied: [] },
  };
}

/** The summary of an episode no firing of which ever composed one. */
const NO_SUMMARY: EpisodeSummary = {
  outcome: "never-composed",
  reason: "the bound was spent before this firing listed the episode's threads, and nothing reports the 2 rounds it ran",
};

/** A summary GitHub refused, which leaves the episode no record of itself. */
const SUMMARY_REFUSED: CommentPosting = {
  outcome: "failed",
  reason: "gh answered HTTP 502 without posting the summary",
};

function blockedRound(reason: string): RoundConclusion {
  return {
    outcome: "block",
    reason,
    pullRequest: PULL_REQUEST,
    posted: ["PRRT_kwDOA"],
    findings: { outcomes: [] },
    verdicts: { threads: [], unapplied: [] },
  };
}

function finding(headline: string): Finding {
  return {
    scope: "line",
    file: "src/ui/card.ts",
    line: 88,
    severity: "high",
    headline,
    reasoning: ["the caller has no way to tell the two apart"],
    suggestedFix: "return the reason beside the outcome",
  };
}

function threaded(headline: string): FindingOutcome {
  return {
    outcome: "threaded",
    finding: finding(headline),
    placement: "inline",
    url: "https://github.com/squiz/squiz/pull/142#discussion_r1",
    threadId: "PRRT_kwDOA",
  };
}

function unpostable(headline: string): FindingOutcome {
  return {
    outcome: "failed",
    finding: finding(headline),
    reason: "gh exited 1: HTTP 502: Bad gateway",
  };
}

function noted(headline: string): FindingOutcome {
  return { outcome: "noted", finding: finding(headline), location: "src/ui/card.ts:88" };
}

/** A thread the reviewer ruled settled, closed as it ruled. */
function applied(thread: string): AppliedVerdict {
  return { thread, ruled: "fixed", outcome: "closed" };
}

/** A thread the reviewer ruled still wrong, which GitHub would not re-open. */
function refused(thread: string): AppliedVerdict {
  return {
    thread,
    ruled: "open",
    outcome: "failed",
    reason: "gh exited 1: HTTP 502: Bad gateway",
  };
}

/** The pointer's lines for `conclusion`, joined, or the assertion that it composed none. */
function pointerFor(conclusion: RoundConclusion): string {
  const lines = failureIn(conclusion);
  assert.notEqual(lines.length, 0, `nothing was reported for ${JSON.stringify(conclusion)}`);
  return lines.join("\n");
}

test("a reviewer that is not installed is reported as what failed", () => {
  const reason = "the reviewer could not run: pi could not be started: spawn pi ENOENT";

  assert.equal(pointerFor(failedRound("setup", reason)), reason);
});

test("a reviewer that completed no message carries the reason it gave", () => {
  const reason = "the reviewer could not run: the model refused the request";

  assert.equal(pointerFor(failedRound("setup", reason)), reason);
});

test("a model API that is not answering says the review did not run", () => {
  const reason = "the review did not run: pi exited 1: 429 rate limited";

  assert.equal(pointerFor(failedRound("unavailable", reason)), reason);
});

test("output the adapter could not read is reported after the round's retry", () => {
  // The round retries once and then reports it as an API that is not
  // answering, so what reaches here is that outcome and not a third one.
  const reason = "the review did not run: the last message was not a review";

  assert.equal(pointerFor(failedRound("unavailable", reason)), reason);
});

test("a reviewer killed at its time bound is reported as a round that found nothing posted", () => {
  const reason = "the reviewer was killed at its 480-second bound, and the round recorded no findings";

  assert.equal(pointerFor(failedRound("timed-out", reason)), reason);
});

test("a GitHub that could not be reached is reported", () => {
  const reason =
    'no review ran: the pull request for "review/the-round" could not be looked up: gh exited 1: HTTP 503';

  assert.equal(pointerFor(failedRound("harness", reason)), reason);
});

test("a state file that will not take the round surfaces the underlying error", () => {
  // § 7 asks for the error rather than the word "failed", because a state file
  // nothing can write fails the same way every round until someone reads why.
  const reason =
    "nothing was posted: the episode's state could not be written: EACCES: permission denied, open '/work/.squiz/a1e/state.json'";

  const pointer = pointerFor(failedRound("harness", reason));

  assert.match(pointer, /EACCES: permission denied/u);
});

test("the round cap and the token bound are not failures", () => {
  // Both close the episode with what they have, and the summary comment is
  // where they are reported. A pointer would read as a round that broke.
  assert.deepEqual(failureIn(closedRound("round-cap")), []);
  assert.deepEqual(failureIn(closedRound("token-bound")), []);
  assert.deepEqual(failureIn(closedRound("nothing-open")), []);
});

test("a branch with no pull request is no failure", () => {
  const conclusion = { outcome: "no-pull-request", branch: "main", directory: "/work" } as const;

  assert.deepEqual(failureIn(conclusion), []);
});

test("a branch with no pull request is named, with the directory the gate looked in", () => {
  assert.equal(
    unreviewedIn({ outcome: "no-pull-request", branch: "main", directory: "/work/tree" }),
    'no review ran: no open pull request has "main" as its head, in "/work/tree"',
  );
});

test("a detached HEAD is named as one, with the directory the gate looked in", () => {
  assert.equal(
    unreviewedIn({ outcome: "no-pull-request", branch: null, directory: "/work/tree" }),
    'no review ran: HEAD is detached in "/work/tree", so no pull request has it as its head',
  );
});

test("a line separator in the directory survives the pointer as an escape", () => {
  // JSON quoting leaves these three raw, and the pointer flattens each to a space.
  const separators = [0x85, 0x2028, 0x2029].map((code) => String.fromCharCode(code));
  const directory = `/work/${separators.join("x")}`;

  const line = failureLine(
    unreviewedIn({ outcome: "no-pull-request", branch: null, directory }) ?? "",
  );

  assert.equal(
    line,
    String.raw`squiz: no review ran: HEAD is detached in "/work/\u0085x\u2028x\u2029", so no pull request has it as its head` + "\n",
  );
});
test("a blocked round composes no pointer", () => {
  // Its stderr is the blocking reason and nothing beside it.
  assert.deepEqual(failureIn(blockedRound("Squiz reviewed the change on this branch.")), []);
});

test("a round that could post none of its findings says so", () => {
  const conclusion = closedRound("nothing-open", [
    unpostable("the two failures are indistinguishable"),
    unpostable("the retry runs on a spent bound"),
    unpostable("the thread id is never read back"),
  ]);

  assert.equal(
    pointerFor(conclusion),
    "the round closed the episode on PR #142 having failed to post 3 of 3 findings",
  );
});

test("a finding the summary carries is not a finding that failed to post", () => {
  // A finding routed to the summary was never going to open a thread, so a
  // round holding only those has posted everything it could.
  assert.deepEqual(failureIn(closedRound("nothing-open", [noted("the change needs a test")])), []);
});

test("a diff nothing could be anchored against is announced", () => {
  // Every finding that named a place went to the summary rather than to a
  // thread, so none of them failed to post and the round posted nothing.
  const conclusion = closedRound(
    "nothing-open",
    [noted("the caller cannot tell the two apart")],
    [],
    new Error("the diff carries no hunk header"),
  );

  assert.equal(
    pointerFor(conclusion),
    "the round closed the episode on PR #142 having failed to read the diff its comments anchor to",
  );
});

test("a closing round that posted some of its findings still says so", () => {
  // A comment that landed stays, and on a closing round there is no later round
  // to make the missing one again. Silence would leave a defect nobody was told
  // about behind an episode that looks like it ended healthy.
  const conclusion = closedRound("round-cap", [
    threaded("the caller cannot tell the two apart"),
    unpostable("the retry runs on a spent bound"),
  ]);

  assert.equal(
    pointerFor(conclusion),
    "the round closed the episode on PR #142 having failed to post 1 of 2 findings",
  );
});

test("a verdict that did not reach its thread is said, where the close reads clean", () => {
  // A re-open GitHub refused leaves the thread closed over a defect that still
  // stands, and the round then closes because it counts nothing open.
  const conclusion = closedRound("nothing-open", [], [applied("PRRT_1"), refused("PRRT_2")]);

  assert.equal(
    pointerFor(conclusion),
    "the round closed the episode on PR #142 having failed to apply 1 of 2 verdicts",
  );
});

test("an episode that closed without its summary says so", () => {
  // The summary is the episode's whole record on the pull request: the counts,
  // the cost and what needs a person are in it and nowhere else. Nothing posts it
  // a second time, so this line is all a person gets.
  const conclusion = closedRound("nothing-open", [], [], undefined, SUMMARY_REFUSED);

  assert.equal(
    pointerFor(conclusion),
    "the round closed the episode on PR #142 having failed to post the episode's summary: " +
      "gh answered HTTP 502 without posting the summary",
  );
});

test("a summary the window left no time to send carries that as its reason", () => {
  // Which failure it was decides whether anything can be done about it, so the
  // pointer carries the reason and not the fact alone.
  const conclusion = closedRound("round-cap", [], [], undefined, {
    outcome: "failed",
    reason: "the time left for GitHub ran out before this call was made",
  });

  assert.equal(
    pointerFor(conclusion),
    "the round closed the episode on PR #142 having failed to post the episode's summary: " +
      "the time left for GitHub ran out before this call was made",
  );
});

test("a firing of an episode that is over composes no pointer", () => {
  // The comment went up when the episode closed, or the firing that could not
  // post it said so then. A second line would report a failure twice.
  assert.deepEqual(failureIn({ outcome: "episode-over" }), []);
});

test("a close the harness could not record says so", () => {
  // The record is what tells a later firing that the episode is over. Without it
  // that firing reviews this pull request again and posts a second comment, and
  // this line is the only warning of it.
  const conclusion = closedRound("nothing-open", [], [], undefined, { outcome: "posted" }, {
    outcome: "failed",
    reason:
      "/work/.squiz/a1e3196c5ad0f2410/state.json could not be written: EACCES: permission denied",
  });

  assert.equal(
    pointerFor(conclusion),
    "the round closed the episode on PR #142 having failed to record the episode's close: " +
      "/work/.squiz/a1e3196c5ad0f2410/state.json could not be written: EACCES: permission denied",
  );
});

test("a close that ends an episode no comment ever reported says so", () => {
  // A bound lowered between firings closes an episode whose rounds ran and whose
  // findings are on the pull request with nothing reporting them. Exit 0 and
  // silence here is a review that reads as clean.
  assert.equal(
    pointerFor(closedBeforeTheReview("round-cap", NO_SUMMARY)),
    "the round closed the episode on PR #142 having failed to post the episode's summary: " +
      "the bound was spent before this firing listed the episode's threads, and nothing " +
      "reports the 2 rounds it ran",
  );
});

test("a close that ends an episode which never reviewed says that instead", () => {
  const conclusion = closedBeforeTheReview("token-bound", {
    outcome: "never-composed",
    reason: "no round of the episode ever ran",
  });

  assert.equal(
    pointerFor(conclusion),
    "the round closed the episode on PR #142 having failed to post the episode's summary: " +
      "no round of the episode ever ran",
  );
});

test("both kinds of failure share the one line", () => {
  const conclusion = closedRound(
    "round-cap",
    [threaded("the caller cannot tell the two apart"), unpostable("the anchor is off")],
    [refused("PRRT_1"), applied("PRRT_2")],
  );

  assert.equal(
    pointerFor(conclusion),
    "the round closed the episode on PR #142 having failed to post 1 of 2 findings " +
      "and to apply 1 of 2 verdicts",
  );
});

test("everything a close failed at shares the one line, the summary last", () => {
  const conclusion = closedRound(
    "round-cap",
    [unpostable("the anchor is off")],
    [refused("PRRT_1")],
    undefined,
    SUMMARY_REFUSED,
  );

  assert.equal(
    pointerFor(conclusion),
    "the round closed the episode on PR #142 having failed to post 1 of 1 findings " +
      "and to apply 1 of 1 verdicts and to post the episode's summary: " +
      "gh answered HTTP 502 without posting the summary",
  );
});

test("a round that posted everything it found and applied every verdict says nothing", () => {
  const conclusion = closedRound("nothing-open", [threaded("the anchor is off")], [applied("PRRT_1")]);

  assert.deepEqual(failureIn(conclusion), []);
});

/** The reason a killed round that salvaged two findings gives for itself. */
const KILLED =
  "the reviewer was killed at its 480-second bound, and the round kept the 2 findings the reviewer had reported";

test("a salvaged round that could not post what it kept says so on the line after the failure", () => {
  // A salvaged finding that reached no thread is as lost as any other, and the
  // round that failed is the only thing that will ever have held it.
  const conclusion = salvagedRound("timed-out", KILLED, [
    threaded("the caller cannot tell the two apart"),
    unpostable("the retry runs on a spent bound"),
  ]);

  assert.equal(
    pointerFor(conclusion),
    `${KILLED}\nthe round failed to post 1 of 2 findings on PR #142`,
  );
});

test("a salvaged round that posted everything it kept reports the reviewer's failure alone", () => {
  const conclusion = salvagedRound("timed-out", KILLED, [
    threaded("the caller cannot tell the two apart"),
    threaded("the retry runs on a spent bound"),
  ]);

  assert.equal(pointerFor(conclusion), KILLED);
});

test("a salvaged round that could not apply a verdict says that too", () => {
  const reason = "the review did not run: the last message was not a review";
  const conclusion = salvagedRound("unavailable", reason, [], [applied("PRRT_1"), refused("PRRT_2")]);

  assert.equal(
    pointerFor(conclusion),
    `${reason}\nthe round failed to apply 1 of 2 verdicts on PR #142`,
  );
});

/** Where a round's marker goes, and the error its write ended on. */
const UNMARKED_REASON =
  "/work/tree/.squiz/a1e3196c5ad0f2410/running.json could not be written: EISDIR: illegal operation on a directory";
const UNMARKED: MarkWrite = { outcome: "failed", reason: UNMARKED_REASON };

/** `conclusion`, around a reviewer whose round wrote its marker or failed to. */
function around(conclusion: RoundConclusion, marked: MarkWrite): RoundConclusion {
  const confinement: RoundConfinement = {
    trackedFiles: { outcome: "unchanged" },
    otherEpisodes: { outcome: "alone" },
    marked,
  };
  return { ...conclusion, confinement } as RoundConclusion;
}

test("a close whose marker could not be written names the path and the reason", () => {
  const conclusion = around(closedRound("nothing-open"), UNMARKED);

  assert.equal(
    pointerFor(conclusion),
    "the round closed the episode on PR #142 having failed to mark itself as running for " +
      `the other episodes of the worktree: ${UNMARKED_REASON}`,
  );
});

test("a marker that could not be written follows everything a close failed at", () => {
  const conclusion = around(
    closedRound("round-cap", [unpostable("the anchor is off")], [], undefined, SUMMARY_REFUSED),
    UNMARKED,
  );

  assert.match(
    pointerFor(conclusion),
    /^the round closed the episode on PR #142 having failed to post 1 of 1 findings and to post the episode's summary: .* and to mark itself as running for the other episodes of the worktree: .*running\.json could not be written: EISDIR: /u,
  );
});

test("a failed round whose marker could not be written says so after the failure", () => {
  const reason = "the reviewer was killed at its 480-second bound";
  const conclusion = around(failedRound("timed-out", reason), UNMARKED);

  assert.match(
    pointerFor(conclusion),
    /^the reviewer was killed at its 480-second bound\nthe round failed to mark itself as running for the other episodes of the worktree: .*running\.json could not be written: /u,
  );
});

test("a round whose marker was written says nothing of it", () => {
  const written: MarkWrite = { outcome: "written" };

  assert.deepEqual(failureIn(around(closedRound("nothing-open"), written)), []);
  assert.equal(
    pointerFor(around(failedRound("timed-out", "the reviewer was killed"), written)),
    "the reviewer was killed",
  );
});

/** `conclusion`, with what became of its failure comment on PR #142. */
function announced(conclusion: RoundConclusion, posting: CommentPosting): RoundConclusion {
  return { ...conclusion, failureComment: { pullRequest: PULL_REQUEST, posting } } as RoundConclusion;
}

test("a failure comment that went up is named after the failure", () => {
  const conclusion = announced(failedRound("timed-out", KILLED), { outcome: "posted" });

  assert.deepEqual(failureIn(conclusion), [KILLED, "the failure is posted on PR #142"]);
});

test("a failure comment that could not be posted says why, and the failure stands", () => {
  const conclusion = announced(failedRound("timed-out", KILLED), {
    outcome: "failed",
    reason: "gh answered HTTP 502 without posting the failure",
  });

  assert.deepEqual(failureIn(conclusion), [
    KILLED,
    "the failure could not be posted on PR #142: gh answered HTTP 502 without posting the failure",
  ]);
});

test("what the failed round established is a line each, between the failure and the comment", () => {
  const confinement: RoundConfinement = {
    trackedFiles: { outcome: "changed", paths: ["src/ui/card.ts"] },
    otherEpisodes: { outcome: "alone" },
    marked: { outcome: "written" },
  };
  const conclusion = announced(
    { ...salvagedRound("timed-out", KILLED, [unpostable("the anchor is off")]), confinement } as RoundConclusion,
    { outcome: "posted" },
  );

  assert.deepEqual(failureIn(conclusion), [
    KILLED,
    "A file changed in the worktree while the reviewer ran: `src/ui/card.ts`",
    "the round failed to post 1 of 1 findings on PR #142",
    "the failure is posted on PR #142",
  ]);
});

test("a blocked round's marker is not reported, because its stderr is the coding agent's", () => {
  assert.deepEqual(failureIn(around(blockedRound("Address the open threads.\n"), UNMARKED)), []);
});

test("every pointer the hook composes is one line", () => {
  // The pointer is a pointer rather than a report, and one place composes all
  // of them so that none can grow into a second output format.
  const conclusions = [
    failedRound("setup", "the reviewer could not run:\nspawn pi ENOENT\n"),
    failedRound("timed-out", "the reviewer was killed at its 480-second bound"),
    failedRound("unavailable", "the review did not run: 429\nrate limited"),
    failedRound("harness", "nothing was posted: EACCES: permission denied"),
    salvagedRound("timed-out", KILLED, [threaded("one"), unpostable("two")], [refused("PRRT_1")]),
    closedRound("nothing-open", [unpostable("one"), unpostable("two")]),
    closedRound("round-cap", [threaded("one"), unpostable("two")], [refused("PRRT_1")]),
    closedRound("nothing-open", [noted("one")], [], new Error("the diff carries no hunk header")),
    closedRound("nothing-open", [], [], undefined, {
      outcome: "failed",
      reason: "gh exited 1 on HTTP 502:\ngh: Bad gateway\n",
    }),
    closedBeforeTheReview("round-cap", NO_SUMMARY),
  ];

  for (const conclusion of conclusions) {
    for (const reason of failureIn(conclusion)) {
      const line = failureLine(reason);
      assert.equal(line.indexOf("\n"), line.length - 1, `not one line: ${JSON.stringify(line)}`);
      assert.ok(line.startsWith("squiz: "), `no prefix: ${JSON.stringify(line)}`);
    }
  }
});

const hookModule = new URL("./hook.ts", import.meta.url).href;
const triggerModule = new URL("../host/trigger.ts", import.meta.url).href;
const episodeModule = new URL("../loop/episode.ts", import.meta.url).href;
const standInHost = fileURLToPath(new URL("../host/host-stand-in.ts", import.meta.url));

const NUMBER = 41;
const BRANCH = "feature-a";
const HEAD = "3f9c2e0a1b2c3d4e5f60718293a4b5c6d7e8f901";
const SESSION_ID = "60517e1f-e1dc-49b1-8e39-6fcbe686f3fb";
const AGENT_ID = "a1e3196c5ad0f2410";
const SOCKET = "/tmp/claude-code-messaging.sock";
const BOUND_MS = 10_000;

/** A firing as the runtime writes it to the hook's stdin. */
function stopPayload(over: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    session_id: SESSION_ID,
    cwd: "/work/session-directory",
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: "The change is on the branch.",
    ...over,
  });
}

function subagentStopPayload(over: Readonly<Record<string, unknown>> = {}): string {
  return stopPayload({ hook_event_name: "SubagentStop", agent_id: AGENT_ID, agent_type: "general-purpose", ...over });
}

/** A worktree on `BRANCH`, a `gh` answering for it, and a file for whatever reports back. */
type Place = {
  readonly worktree: string;
  readonly bin: string;
  /** Where the stand-in hosts write `took <pid>`, and a recording trigger its request. */
  readonly log: string;
};

/**
 * The fake `gh`. `gh pr list` prints `list.out` and exits with `list.status`.
 * Every GraphQL call is a threads listing with no threads.
 */
function fakeGh(directory: string): string {
  const at = `'${directory.replaceAll("'", `'\\''`)}'`;
  const noThreads = JSON.stringify({
    data: { node: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } },
  });
  return [
    "#!/bin/sh",
    "cat > /dev/null",
    'for arg in "$@"; do',
    '  if [ "$arg" = graphql ]; then',
    `    printf 'HTTP/2.0 200 OK\\nContent-Type: application/json; charset=utf-8\\r\\n\\r\\n%s' '${noThreads}'`,
    "    exit 0",
    "  fi",
    "done",
    `cat ${at}/list.out`,
    `exit "$(cat ${at}/list.status 2>/dev/null || echo 0)"`,
    "",
  ].join("\n");
}

function git(directory: string, ...args: readonly string[]): void {
  const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
}

async function withPlace(body: (place: Place) => Promise<void>): Promise<void> {
  // Real paths, because git answers the toplevel with symlinks resolved.
  const worktree = realpathSync(await mkdtemp(join(tmpdir(), "squiz-hook-")));
  const bin = await mkdtemp(join(tmpdir(), "squiz-hook-gh-"));
  const place: Place = { worktree, bin, log: join(bin, "reported.log") };
  try {
    git(worktree, "init", "--quiet", "--initial-branch", BRANCH);
    git(worktree, "-c", "user.email=squiz@example.invalid", "-c", "user.name=Squiz", "-c", "commit.gpgsign=false",
      "commit", "--quiet", "--allow-empty", "--message", "a commit to hang a branch off");
    const row = { number: NUMBER, id: "PR_kwDOUEd2qM8AAAABDNPXSA", baseRefName: "main", headRefName: BRANCH, headRefOid: HEAD, body: "" };
    writeFileSync(join(bin, "list.out"), JSON.stringify([row]), "utf8");
    standIn(bin, "gh", fakeGh(bin));
    await body(place);
  } finally {
    for (const pid of hostsThatTook(place)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await rm(worktree, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
  }
}

function reported(place: Place): string {
  return existsSync(place.log) ? readFileSync(place.log, "utf8") : "";
}

function hostsThatTook(place: Place): number[] {
  return reported(place).split("\n").filter((line) => line.startsWith("took ")).map((line) => Number(line.slice(5)));
}

/** Which trigger the firing calls, as source the child evaluates. */
type TriggerAs =
  /** The real one, with the stand-in host in place of `squiz host`. */
  | { readonly as: "real" }
  /** The real one, starting `command` as the host. */
  | { readonly as: "real"; readonly hostCommand: string }
  /** One that writes the request it was given to the log, and found no pull request. */
  | { readonly as: "recording" }
  | { readonly as: "throwing"; readonly message: string };

type HookFiring = {
  readonly payload: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly trigger?: TriggerAs;
};

type Fired = { readonly code: number | null; readonly stderr: string; readonly elapsedMs: number };

function triggerSource(place: Place, trigger: TriggerAs): string {
  const log = JSON.stringify(place.log);
  switch (trigger.as) {
    case "real": {
      const host =
        "hostCommand" in trigger
          ? `() => ({ command: ${JSON.stringify(trigger.hostCommand)}, args: [] })`
          : `(number) => ({ command: process.execPath, args: [${JSON.stringify(standInHost)}, episodeAt(${JSON.stringify(place.worktree)}, number).directory, ${log}] })`;
      return `(request) => trigger({ ...request, host: ${host} })`;
    }
    case "recording":
      return [
        "(request) => {",
        `  writeFileSync(${log}, JSON.stringify({ ...request, remainingMs: request.until.remaining() }));`,
        '  return { outcome: "no review", reason: "the recording trigger looked for nothing" };',
        "}",
      ].join("\n");
    case "throwing":
      return `() => { throw new Error(${JSON.stringify(trigger.message)}); }`;
  }
}

/** Fire the hook in `place` as a process of its own, and collect what it left behind. */
async function fire(place: Place, firing: HookFiring): Promise<Fired> {
  const source = join(place.bin, "fire.mjs");
  await writeFile(
    source,
    [
      `import { writeFileSync } from "node:fs";`,
      `import { Readable } from "node:stream";`,
      `import { runHook } from ${JSON.stringify(hookModule)};`,
      `import { trigger } from ${JSON.stringify(triggerModule)};`,
      `import { episodeAt } from ${JSON.stringify(episodeModule)};`,
      ``,
      `process.exitCode = await runHook({`,
      `  stdin: Readable.from([${JSON.stringify(firing.payload)}]),`,
      `  directory: ${JSON.stringify(place.worktree)},`,
      `  environment: ${JSON.stringify(firing.environment ?? {})},`,
      `  trigger: ${triggerSource(place, firing.trigger ?? { as: "real" })},`,
      `});`,
      ``,
    ].join("\n"),
    "utf8",
  );
  const started = Date.now();
  return await new Promise<Fired>((resolve, reject) => {
    // Pipes, which is how Claude Code runs the hook. A host that kept either
    // open would hold this until it exited.
    const child = spawn(process.execPath, [source], {
      env: { ...process.env, PATH: `${place.bin}:${process.env["PATH"] ?? ""}` },
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.resume();
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stderr, elapsedMs: Date.now() - started });
    });
  });
}

async function eventually(done: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + BOUND_MS;
  while (!done()) {
    if (Date.now() > deadline) assert.fail(`${what} did not happen within ${BOUND_MS}ms`);
    await sleep(50);
  }
}

function recordsIn(place: Place): readonly unknown[] {
  const read = readState(episodeAt(place.worktree, NUMBER));
  assert.equal(read.outcome, "read", `state read as ${JSON.stringify(read)}`);
  return read.outcome === "read" ? (read.state.records ?? []) : [];
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a Stop firing queues the state, owned by the session and its socket, and says nothing", async () => {
  await withPlace(async (place) => {
    const fired = await fire(place, {
      payload: stopPayload(),
      environment: { CLAUDE_CODE_MESSAGING_SOCKET: SOCKET, HERDR_WORKSPACE_ID: "w2" },
    });

    assert.deepEqual(fired, { code: 0, stderr: "", elapsedMs: fired.elapsedMs });
    assert.deepEqual(recordsIn(place), [
      {
        head: HEAD,
        activity: null,
        owner: { sessionId: SESSION_ID, messagingSocket: SOCKET },
        herdrWorkspace: "w2",
        status: "queued",
      },
    ]);
  });
});

test("a SubagentStop firing queues the state, owned by the parent session, its socket and the subagent", async () => {
  await withPlace(async (place) => {
    const fired = await fire(place, {
      payload: subagentStopPayload(),
      environment: { CLAUDE_CODE_MESSAGING_SOCKET: SOCKET },
    });

    assert.deepEqual(fired, { code: 0, stderr: "", elapsedMs: fired.elapsedMs });
    assert.deepEqual(recordsIn(place), [
      {
        head: HEAD,
        activity: null,
        owner: { sessionId: SESSION_ID, subagent: AGENT_ID, messagingSocket: SOCKET },
        status: "queued",
      },
    ]);
  });
});

test("the hook returns while the host it started is still running", async () => {
  await withPlace(async (place) => {
    // The stand-in host holds the lock for a minute, as a host running a round would.
    const fired = await fire(place, { payload: stopPayload() });

    assert.equal(fired.code, 0);
    assert.ok(fired.elapsedMs < 30_000, `the hook took ${fired.elapsedMs}ms`);
    await eventually(() => hostsThatTook(place).length === 1, "a host taking the episode");
    const [host = 0] = hostsThatTook(place);
    assert.ok(alive(host), "the host had exited by the time the hook returned");
  });
});

test("the trigger is asked as a hook, from the directory the hook fired in, with its environment", async () => {
  await withPlace(async (place) => {
    const environment = { CLAUDE_CODE_MESSAGING_SOCKET: SOCKET, HERDR_WORKSPACE_ID: "w2" };
    await fire(place, { payload: subagentStopPayload(), environment, trigger: { as: "recording" } });

    const request = JSON.parse(reported(place)) as Record<string, unknown>;
    assert.equal(request["trigger"], "hook");
    assert.equal(request["directory"], place.worktree);
    assert.deepEqual(request["environment"], environment);
    assert.equal(request["pullRequest"], undefined, "a hook names no pull request, and reviews the branch's");
    assert.ok(Number(request["remainingMs"]) > 0, "the trigger was given no time");
  });
});

test("a trigger that throws exits 0 with one line naming what it threw", async () => {
  await withPlace(async (place) => {
    const fired = await fire(place, { payload: stopPayload(), trigger: { as: "throwing", message: "the trigger exploded" } });

    assert.equal(fired.code, 0);
    assert.match(fired.stderr, /^squiz: [^\n]*the trigger exploded\n$/u);
  });
});

test("a SubagentStop with an empty agent_type asks the trigger nothing and says nothing", async () => {
  await withPlace(async (place) => {
    const fired = await fire(place, { payload: subagentStopPayload({ agent_type: "" }), trigger: { as: "recording" } });

    assert.deepEqual(fired, { code: 0, stderr: "", elapsedMs: fired.elapsedMs });
    assert.equal(reported(place), "", "the trigger was asked");
  });
});

test("a payload that cannot be read asks the trigger nothing, exits 0, and says why in one line", async () => {
  await withPlace(async (place) => {
    for (const payload of ["", "{not json", subagentStopPayload({ agent_id: "" })]) {
      const fired = await fire(place, { payload, trigger: { as: "recording" } });

      assert.equal(fired.code, 0);
      assert.match(fired.stderr, /^squiz: [^\n]+\n$/u, `for ${JSON.stringify(payload)}`);
      assert.equal(reported(place), "", `the trigger was asked for ${JSON.stringify(payload)}`);
    }
  });
});

test("a branch with no pull request writes the line naming the branch and the directory, and nothing else", async () => {
  await withPlace(async (place) => {
    writeFileSync(join(place.bin, "list.out"), "[]", "utf8");

    const fired = await fire(place, { payload: stopPayload() });

    assert.equal(fired.code, 0);
    assert.equal(
      fired.stderr,
      `squiz: no review ran: no open pull request has "${BRANCH}" as its head, in ${JSON.stringify(place.worktree)}\n`,
    );
    assert.equal(existsSync(join(place.worktree, ".squiz")), false, "a firing with no pull request wrote state");
  });
});

test("a trigger that could not read what it decides from says so in one line", async () => {
  await withPlace(async (place) => {
    writeFileSync(join(place.bin, "list.status"), "1", "utf8");

    const fired = await fire(place, { payload: stopPayload() });

    assert.equal(fired.code, 0);
    assert.match(fired.stderr, /^squiz: nothing was queued: the pull request for "feature-a" could not be looked up: [^\n]*\n$/u);
  });
});

test("a host that could not be started says so in one line, the state queued", async () => {
  await withPlace(async (place) => {
    const fired = await fire(place, {
      payload: stopPayload(),
      trigger: { as: "real", hostCommand: join(place.bin, "no-such-host") },
    });

    assert.equal(fired.code, 0);
    assert.match(fired.stderr, new RegExp(`^squiz: the round host for PR #${NUMBER} could not be started: [^\\n]*\\n$`, "u"));
    assert.equal(recordsIn(place).length, 1);
  });
});
