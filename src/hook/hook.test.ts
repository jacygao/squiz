/**
 * What one firing of the hook comes to: the exit code, and which of the two
 * stderr channels the round's words left on.
 *
 * Every failure the harness controls exits 0, so the failures are arranged here
 * one row at a time and each is asserted to say what failed. A test that only
 * showed the hook not crashing would show nothing: the top-level trap turns any
 * throw into exit 0, and a hook that did no work at all would pass it.
 *
 * The rounds are run as processes. An exit code, the stream a line landed on,
 * and whether a line arrived at all are properties of a process, and none of
 * them is observable from inside this one. The fixtures run the hook without
 * the trap around it, so a throw that escapes the hook fails the test instead
 * of being turned into the exit code the test was expecting.
 *
 * Some of the failures need an environment rather than a value: a GitHub that
 * answers one call and refuses the next, a state file that will not take a write
 * after the review, a posting margin that runs out mid-flight, a reviewer that
 * stops without finishing. A scripted `gh` and a scripted reviewer, earlier on
 * `PATH` than the real ones, produce each of those on demand, and the whole hook
 * runs around them: the gate, the round, the posting, the exit code and stderr.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { Config } from "../config/config.ts";
import type { Finding } from "../findings/finding.ts";
import type { CommentPosting } from "../github/summary.ts";
import type { RoundConfinement } from "../loop/confinement.ts";
import type { StateWrite } from "../loop/episode-state.ts";
import type { Episode } from "../loop/episode.ts";
import type { FindingOutcome } from "../loop/post-findings.ts";
import type { EpisodeSummary } from "../loop/post-summary.ts";
import type { ClosingReason } from "../loop/round-decision.ts";
import type { RoundConclusion, RoundFailure, RoundSetup } from "../loop/round.ts";
import type { AppliedVerdict } from "../loop/verdicts.ts";
import { standIn } from "../testing/stand-in.ts";
import type { MarkWrite } from "../worktree/shared-tree.ts";
import { failureIn, unreviewedIn } from "./hook.ts";
import { failureLine } from "./report.ts";

const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const hookModule = new URL("./hook.ts", import.meta.url).href;
const roundModule = new URL("../loop/round.ts", import.meta.url).href;

const PULL_REQUEST = 142;
const BRANCH = "review/the-round";

/** The subagent's id, in the shape every id the runtime has emitted holds. */
const AGENT_ID = "a1e3196c5ad0f2410";

/** The id of the user turn in the parent session, which is never the key. */
const PROMPT_ID = "59893e32-bf05-4243-8b68-062d0f8767ef";

/** One firing, as the runtime writes it to the hook's stdin. */
function payload(over: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    session_id: "60517e1f-e1dc-49b1-8e39-6fcbe686f3fb",
    cwd: "/work/session-directory",
    prompt_id: PROMPT_ID,
    agent_id: AGENT_ID,
    agent_type: "general-purpose",
    hook_event_name: "SubagentStop",
    stop_hook_active: false,
    last_assistant_message: "The change is on the branch.",
    ...over,
  });
}

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

/** What the round was handed, read back from the process that ran it. */
type HandedOver = {
  readonly episode: Episode;
  readonly config: Config;
  readonly charterFile: string;
  /** The command the adapter the hook chose would start. */
  readonly reviewer: string;
};

type Fired = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** `null` where no round ran, which is what a firing that failed first leaves. */
  readonly handed: HandedOver | null;
};

/** What the round does when the hook calls it. */
type FakeRound =
  | { readonly returns: RoundConclusion }
  /** A defect in the harness, which the round's own contract says cannot happen. */
  | { readonly throws: string };

type Firing = {
  /** The worktree the hook fires in, which a repository has been made in. */
  readonly directory: string;
  readonly payload?: string;
  readonly round?: FakeRound;
};

/**
 * Fire the hook in a child process and collect everything it left behind.
 *
 * The round is handed over rather than run: what a reviewer, GitHub or a state
 * file did to a round is the round's own to report, and the hook is judged on
 * what it does with the report.
 */
async function fire(setup: Firing): Promise<Fired> {
  const root = await mkdtemp(join(tmpdir(), "squiz-firing-"));
  try {
    const handedFile = join(root, "handed.json");
    const source = join(root, "fire.mjs");
    await writeFile(source, fixture(setup, handedFile), "utf8");
    const run = await runInChild(source);
    return {
      ...run,
      handed: existsSync(handedFile)
        ? (JSON.parse(readFileSync(handedFile, "utf8")) as HandedOver)
        : null,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * The module the child runs: the hook, called directly, with the round faked.
 *
 * No trap around it. The trap turns a throw into exit 0, which is the exit half
 * of these tests expect, so running under it would hide a hook that threw.
 */
function fixture(setup: Firing, handedFile: string): string {
  const text = setup.payload ?? payload();
  const round = setup.round ?? { returns: { outcome: "episode-over" } };
  const body =
    "throws" in round
      ? `throw new Error(${JSON.stringify(round.throws)});`
      : `return ${JSON.stringify(round.returns)};`;
  return [
    `import { writeFileSync } from "node:fs";`,
    `import { Readable } from "node:stream";`,
    `import { runHook } from ${JSON.stringify(hookModule)};`,
    ``,
    `const round = async (given) => {`,
    `  const invocation = {`,
    `    directory: given.episode.worktree,`,
    `    charterFile: given.charterFile,`,
    `    prompt: "",`,
    `    sessionDirectory: given.episode.sessionDirectory,`,
    `    scratchDirectory: given.episode.scratchDirectory,`,
    `    depth: given.config.depth,`,
    `    thinking: given.config.thinking,`,
    `  };`,
    `  writeFileSync(${JSON.stringify(handedFile)}, JSON.stringify({`,
    `    episode: given.episode,`,
    `    config: given.config,`,
    `    charterFile: given.charterFile,`,
    `    reviewer: given.adapter.argv(invocation).command,`,
    `  }));`,
    `  ${body}`,
    `};`,
    ``,
    `process.exitCode = await runHook({`,
    `  stdin: Readable.from(${JSON.stringify(text === "" ? [] : [text])}),`,
    `  directory: ${JSON.stringify(setup.directory)},`,
    `  round,`,
    `});`,
    ``,
  ].join("\n");
}

type Run = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

async function runInChild(file: string): Promise<Run> {
  return await new Promise<Run>((resolve, reject) => {
    // Pipes, which is how Claude Code runs the hook, and the case where output
    // written but not flushed is lost.
    const child = spawn(process.execPath, [file]);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

/** A repository with one commit on `BRANCH`, and its path as git resolves it. */
async function withRepository<T>(body: (worktree: string) => Promise<T> | T): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "squiz-hook-"));
  try {
    commitOn(directory, BRANCH);
    return await body(realpathSync(directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function git(directory: string, ...args: readonly string[]): void {
  const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
}

function commitOn(directory: string, branch: string): void {
  git(directory, "init", "--quiet", "--initial-branch", branch);
  git(
    directory,
    "-c",
    "user.email=squiz@example.invalid",
    "-c",
    "user.name=Squiz",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "--allow-empty",
    "--message",
    "the change under review",
  );
}

/** The blocking reason of a round that found something, as the round composes it. */
const REASON = [
  "Squiz reviewed the change on this branch and left 1 comment on PR #142.",
  "",
  "1 thread is open on it:",
  "PRRT_kwDOA src/ui/card.ts:88",
  "",
  "The commands that work them:",
  "  squiz threads",
  "  squiz reply <id> <text>",
  "",
  "Address what applies, reply on anything you disagree with, then finish.",
  "",
].join("\n");

test("a blocked round exits 2 with the blocking reason, and nothing else on stderr", async () => {
  await withRepository(async (worktree) => {
    const fired = await fire({
      directory: worktree,
      round: { returns: blockedRound(REASON) },
    });

    assert.equal(fired.code, 2, "only exit 2 blocks the coding agent's turn");
    assert.equal(fired.stderr, REASON, "the reason left changed, or something left beside it");
    assert.equal(fired.stdout, "", "the runtime reads exit 2 from stderr alone");
  });
});

test("stop_hook_active does not end a round", async () => {
  // It is true from the second firing of an episode onward, which is every
  // firing where the loop means to block. A hook that stopped on it would cap
  // every episode at one round.
  await withRepository(async (worktree) => {
    const fired = await fire({
      directory: worktree,
      payload: payload({ stop_hook_active: true }),
      round: { returns: blockedRound(REASON) },
    });

    assert.equal(fired.code, 2);
    assert.equal(fired.stderr, REASON);
  });
});

test("a closing round exits 0 and says nothing", async () => {
  await withRepository(async (worktree) => {
    const fired = await fire({
      directory: worktree,
      round: { returns: closedRound("round-cap", [threaded("the anchor is off")]) },
    });

    assert.equal(fired.code, 0);
    assert.equal(fired.stderr, "", "an episode that closed at its cap has not failed");
    assert.equal(fired.stdout, "");
  });
});

test("a closing round that carried a failure exits 0 and is not silent", async () => {
  // The exit code was never the bug: a close exits 0 and looks like the end of a
  // healthy episode, so a failure it carried out with it reads as a clean
  // review. Both shapes of that are here.
  const cases = [
    {
      conclusion: closedRound("nothing-open", [], [applied("PRRT_1"), refused("PRRT_2")]),
      pointer:
        "squiz: the round closed the episode on PR #142 having failed to apply 1 of 2 verdicts\n",
    },
    {
      conclusion: closedRound("round-cap", [threaded("one"), unpostable("two")]),
      pointer:
        "squiz: the round closed the episode on PR #142 having failed to post 1 of 2 findings\n",
    },
    {
      conclusion: closedRound("nothing-open", [threaded("one")], [], undefined, SUMMARY_REFUSED),
      pointer:
        "squiz: the round closed the episode on PR #142 having failed to post the episode's " +
        "summary: gh answered HTTP 502 without posting the summary\n",
    },
  ];

  await withRepository(async (worktree) => {
    for (const { conclusion, pointer } of cases) {
      const fired = await fire({ directory: worktree, round: { returns: conclusion } });

      assert.equal(fired.code, 0, "a round that closed must not stop the coding agent finishing");
      assert.equal(fired.stderr, pointer);
      assert.equal(fired.stdout, "");
    }
  });
});

test("a round that failed exits 0 with the pointer on stderr", async () => {
  await withRepository(async (worktree) => {
    const fired = await fire({
      directory: worktree,
      round: { returns: failedRound("timed-out", "the reviewer was killed at its 480-second bound") },
    });

    assert.equal(fired.code, 0, "a failed round must not stop the coding agent finishing");
    assert.equal(
      fired.stderr,
      "squiz: the reviewer was killed at its 480-second bound\n",
      "the failure pointer is one line, prefixed, and alone",
    );
    assert.equal(fired.stdout, "");
  });
});

test("a throw inside a round does not reach the runtime", async () => {
  // The round reports its failures as values, so a throw from it is a defect in
  // the harness. The hook ends the round with it rather than the turn, and the
  // top-level trap is not what catches it here: this fixture runs without one.
  await withRepository(async (worktree) => {
    const fired = await fire({
      directory: worktree,
      round: { throws: "the round read a thread that was not there" },
    });

    assert.equal(fired.code, 0);
    assert.equal(
      fired.stderr,
      "squiz: the round could not be run: the round read a thread that was not there\n",
    );
  });
});

test("every way a round can fail exits 0", async () => {
  // The harness may fail in any way except by preventing the coding agent from
  // finishing, and a round is the only thing here that can fail in many ways.
  const rounds: readonly FakeRound[] = [
    { returns: failedRound("setup", "the reviewer could not run: spawn pi ENOENT") },
    { returns: failedRound("setup", "the reviewer could not run: the model refused the request") },
    { returns: failedRound("unavailable", "the review did not run: pi exited 1: 429 rate limited") },
    { returns: failedRound("unavailable", "the review did not run: the last message was not a review") },
    { returns: failedRound("timed-out", "the reviewer was killed at its 480-second bound") },
    { returns: failedRound("harness", "no review ran: gh exited 1: HTTP 503") },
    { returns: failedRound("harness", "nothing was posted: EACCES: permission denied") },
    { returns: closedRound("round-cap", [threaded("the anchor is off")]) },
    { returns: closedRound("token-bound") },
    { returns: closedRound("nothing-open", [unpostable("the anchor is off")]) },
    { returns: closedRound("nothing-open", [threaded("one"), unpostable("two")]) },
    { returns: closedRound("nothing-open", [], [refused("PRRT_1")]) },
    { returns: closedRound("nothing-open", [noted("one")], [], new Error("no hunk header")) },
    { returns: closedRound("nothing-open", [], [], undefined, SUMMARY_REFUSED) },
    { returns: closedBeforeTheReview("round-cap", NO_SUMMARY) },
    { returns: { outcome: "episode-over" } },
    {
      returns: closedRound("nothing-open", [], [], undefined, { outcome: "posted" }, {
        outcome: "failed",
        reason: "state.json could not be written: ENOSPC: no space left on device",
      }),
    },
    { throws: "the round read a thread that was not there" },
  ];

  await withRepository(async (worktree) => {
    for (const round of rounds) {
      const fired = await fire({ directory: worktree, round });

      assert.equal(fired.code, 0, `exit for ${JSON.stringify(round)}`);
      assert.equal(fired.stdout, "");
      if (fired.stderr !== "") assertOneLine(fired.stderr);
    }
  });
});

test("the episode the round is handed is keyed on the subagent's id", async () => {
  await withRepository(async (worktree) => {
    const fired = await fire({ directory: worktree });
    const handed = fired.handed;

    assert.notEqual(handed, null, "no round ran");
    assert.equal(handed?.episode.id, AGENT_ID);
    assert.equal(handed?.episode.directory, join(worktree, ".squiz", AGENT_ID));
    assert.equal(
      JSON.stringify(handed?.episode).includes(PROMPT_ID),
      false,
      "prompt_id reached the episode, and it is one string for every subagent in a session",
    );
  });
});

test("the worktree is resolved rather than read off the directory the hook fired in", async () => {
  // The hook fires in the subagent's working directory, which is somewhere
  // inside the worktree and not necessarily its root.
  await withRepository(async (worktree) => {
    const inside = join(worktree, "src", "deep");
    await mkdir(inside, { recursive: true });

    const fired = await fire({ directory: inside });

    assert.equal(fired.handed?.episode.worktree, worktree);
  });
});

test("an id that would traverse out of the worktree does not", async () => {
  // The id is read from a payload rather than generated, and the episode's
  // directory is named after it.
  await withRepository(async (worktree) => {
    const fired = await fire({
      directory: worktree,
      payload: payload({ agent_id: "../../elsewhere" }),
    });

    assert.equal(fired.handed?.episode.directory.startsWith(join(worktree, ".squiz")), true);
  });
});

test("an id no directory name can be made of runs no round", async () => {
  await withRepository(async (worktree) => {
    const fired = await fire({ directory: worktree, payload: payload({ agent_id: "../.." }) });

    assert.equal(fired.code, 0);
    assert.equal(fired.handed, null, "a round ran against an episode with no key");
    assert.match(fired.stderr, /^squiz: no review ran: the subagent's id /u);
    assertOneLine(fired.stderr);
  });
});

test("a payload that cannot be read is not a round that found nothing", async () => {
  await withRepository(async (worktree) => {
    for (const text of ["", "{ not json", '{"prompt_id":"59893e32"}']) {
      const fired = await fire({ directory: worktree, payload: text });

      assert.equal(fired.code, 0, `exit for ${JSON.stringify(text)}`);
      assert.equal(fired.handed, null, `a round ran on ${JSON.stringify(text)}`);
      assert.match(fired.stderr, /^squiz: no review ran: /u);
      assertOneLine(fired.stderr);
    }
  });
});

test("a block with nothing to say does not block", async () => {
  // Exit 2 hands the coding agent whatever is on stderr as its next
  // instruction, and an empty one spends a round of the cap on nothing.
  await withRepository(async (worktree) => {
    const fired = await fire({ directory: worktree, round: { returns: blockedRound("  \n ") } });

    assert.equal(fired.code, 0);
    assert.equal(fired.stderr, "squiz: the round blocked on PR #142 with nothing to say\n");
  });
});

test("the project's settings and the charter that ships reach the round", async () => {
  await withRepository(async (worktree) => {
    await writeFile(join(worktree, ".squiz.json"), JSON.stringify({ rounds: 1 }), "utf8");

    const fired = await fire({ directory: worktree });

    assert.equal(fired.handed?.config.rounds, 1);
    assert.equal(fired.handed?.reviewer, "pi", "the round was handed an adapter for another CLI");
    assert.equal(existsSync(fired.handed?.charterFile ?? ""), true, "the charter was not found");
  });
});

test("a .squiz.json that cannot be read runs no round", async () => {
  await withRepository(async (worktree) => {
    await writeFile(join(worktree, ".squiz.json"), '{"rounds": 99}', "utf8");

    const fired = await fire({ directory: worktree });

    assert.equal(fired.code, 0);
    assert.equal(fired.handed, null, "a round ran on settings nothing could read");
    assert.match(fired.stderr, /^squiz: no review ran: .*rounds/u);
    assertOneLine(fired.stderr);
  });
});

/** Which call to `gh` the fake was asked for, and what it answers with. */
type Answers = {
  readonly pullRequests?: string;
  readonly diff?: string;
  /** The threads listing every round makes. One naming none by default. */
  readonly threads?: string;
  readonly status?: number;
  readonly stderr?: string;
};

/**
 * One answer from `gh api --include`: the status line, the headers, a blank
 * line, then the body.
 *
 * The line endings are the fixture. The status line ends in a bare newline and
 * the headers in CRLF, which is what the reader has to split on either way.
 */
function response(status: string, body: unknown): string {
  return [
    `HTTP/2.0 ${status}`,
    "Content-Type: application/json; charset=utf-8\r",
    "",
    JSON.stringify(body),
  ].join("\n");
}

/** A threads listing that names no thread. */
const NO_THREADS = response("200 OK", {
  data: {
    node: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
  },
});

type Tools = {
  /** A `PATH` holding git, and the fake `gh` where there is one. */
  readonly path: string;
  readonly ghWasRun: () => boolean;
  readonly ghArguments: () => readonly string[];
};

/**
 * A `PATH` carrying git and ps and nothing else that matters.
 *
 * The system's own `PATH` is left out so that a reviewer installed on the
 * machine running the tests cannot be started by one of them. ps stays, because
 * a round without it cannot mark itself as running and says so.
 */
async function toolsIn(directory: string, gh: Answers | null): Promise<Tools> {
  const path = join(directory, "tools");
  const argumentLog = join(directory, "gh-arguments");
  mkdirSync(path);
  symlinkSync(onSystemPath("git"), join(path, "git"));
  symlinkSync(onSystemPath("ps"), join(path, "ps"));

  if (gh !== null) {
    standIn(
      path,
      "gh",
      [
        "#!/bin/sh",
        'for argument in "$@"; do',
        `  printf '%s\\n' "$argument" >> ${quote(argumentLog)}`,
        "done",
        // Every call reads its stdin, or a call carrying a body signals the
        // writer instead of answering it. A call carrying none sees an empty
        // stdin, so there is nothing to tell the two apart for. `read` does it
        // because it is a builtin: `PATH` here holds git, ps and gh alone.
        "while read -r line; do :; done",
        "case $1 in",
        `  pr) printf '%s' ${quote(gh.pullRequests ?? "")} ;;`,
        `  api) if [ "$2" = graphql ]; then printf '%s' ${quote(gh.threads ?? NO_THREADS)}; else printf '%s' ${quote(gh.diff ?? "")}; fi ;;`,
        "esac",
        `printf '%s' ${quote(gh.stderr ?? "")} >&2`,
        `exit ${gh.status ?? 0}`,
        "",
      ].join("\n"),
    );
  }

  return {
    path,
    ghWasRun: () => existsSync(argumentLog),
    ghArguments: () =>
      existsSync(argumentLog)
        ? readFileSync(argumentLog, "utf8")
            .split("\n")
            .filter((line) => line !== "")
        : [],
  };
}

function onSystemPath(name: string): string {
  for (const entry of (process.env["PATH"] ?? "").split(":")) {
    if (entry === "") continue;
    const candidate = join(entry, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not this entry. The next one, or none at all.
    }
  }
  return assert.fail(`${name} is not on PATH, and every fixture here needs it`);
}

function quote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** Run `squiz hook` as the registration does, with `text` on its stdin. */
function squizHook(directory: string, path: string, text: string): Run {
  const result = spawnSync(process.execPath, [cli, "hook"], {
    cwd: directory,
    encoding: "utf8",
    input: text,
    env: { ...process.env, PATH: path },
  });
  assert.equal(result.error, undefined, `the hook could not be run: ${String(result.error)}`);
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The shares of a round's window a test lowers so as not to wait the real ones out. */
type Lowered = Pick<RoundSetup, "marginMs" | "preReviewMs">;

/**
 * Run the hook as `squizHook` does, with the round's shares lowered.
 *
 * Through the hook's own seam for the round, so the gate, the posting, the exit
 * code and stderr are the real ones and only the shares are the test's. No trap
 * around it, as in `fire`.
 */
function squizHookLowered(fixture: Fixture, path: string, text: string, lowered: Lowered): Run {
  const source = join(fixture.beside, "lowered-hook.mjs");
  writeFileSync(
    source,
    [
      `import { runHook } from ${JSON.stringify(hookModule)};`,
      `import { runRound } from ${JSON.stringify(roundModule)};`,
      ``,
      `const lowered = ${JSON.stringify(lowered)};`,
      `process.exitCode = await runHook({`,
      `  stdin: process.stdin,`,
      `  directory: process.cwd(),`,
      `  round: (setup) => runRound({ ...setup, ...lowered }),`,
      `});`,
      ``,
    ].join("\n"),
    "utf8",
  );
  const result = spawnSync(process.execPath, [source], {
    cwd: fixture.worktree,
    encoding: "utf8",
    input: text,
    env: { ...process.env, PATH: path },
  });
  assert.equal(result.error, undefined, `the hook could not be run: ${String(result.error)}`);
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The pointer is one line, whatever it had to say. */
function assertOneLine(stderr: string): void {
  assert.equal(stderr.split("\n").length, 2, `the pointer is not one line: ${stderr}`);
}

const LISTING = JSON.stringify([
  {
    number: PULL_REQUEST,
    id: "PR_kwDOUEd2qM8AAAABDNPXSA",
    baseRefName: "main",
    headRefName: BRANCH,
    headRefOid: "3a1937e729dbab0f618ef761c833a7e2d3675b80",
    body: "",
  },
]);

/** The file the change under review touches, as the host project spells it. */
const REVIEWED_FILE = "src/ui/card.ts";

/**
 * The change under review.
 *
 * Lines 86 and 87 are the two it added, so they are the only two a finding can
 * be anchored to and the only two the router places inline.
 */
const DIFF = [
  `diff --git a/${REVIEWED_FILE} b/${REVIEWED_FILE}`,
  "index d3d0cb2..6db135b 100644",
  `--- a/${REVIEWED_FILE}`,
  `+++ b/${REVIEWED_FILE}`,
  "@@ -85,2 +85,4 @@",
  " // the card's header",
  "+// the reason is dropped here",
  "+// and the outcome returned alone",
  " // the card's footer",
  "",
].join("\n");

test("a reviewer that is not installed ends the round at exit 0, saying so", async () => {
  // The whole hook, end to end: the payload on stdin, git and `gh` as the
  // registration gives them, and a reviewer nothing can start.
  await withRepository(async (worktree) => {
    const tools = await toolsIn(worktree, { pullRequests: LISTING, diff: DIFF });

    const result = squizHook(worktree, tools.path, payload());

    assert.equal(result.code, 0, "a reviewer that is missing must not stop the turn");
    assert.equal(result.stdout, "");
    const [failure, announced, ...rest] = result.stderr.split("\n");
    assert.match(failure ?? "", /^squiz: the reviewer could not run: /u);
    assert.match(announced ?? "", /^squiz: the failure (is|could not be) posted on PR #142/u);
    assert.deepEqual(rest, [""], "one line for the failure and one for its comment");
  });
});

test("a branch with no pull request posts nothing, runs nothing, and says which branch and where", async () => {
  await withRepository(async (worktree) => {
    const tools = await toolsIn(worktree, { pullRequests: "[]\n" });

    const result = squizHook(worktree, tools.path, payload());

    assert.equal(result.code, 0, "only exit 2 blocks a turn, and no round ran");
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      `squiz: no review ran: no open pull request has "${BRANCH}" as its head, in ${JSON.stringify(worktree)}\n`,
      "a pass for want of a pull request must not read like a subagent reviewed against the wrong tree",
    );
    assert.ok(tools.ghWasRun(), "the branch was never asked about");
  });
});

test("the directory a pass names keeps every space in its path", async () => {
  const root = await mkdtemp(join(tmpdir(), "squiz-hook-"));
  try {
    const worktree = join(realpathSync(root), "two  spaces");
    mkdirSync(worktree);
    commitOn(worktree, BRANCH);
    const tools = await toolsIn(worktree, { pullRequests: "[]\n" });

    const result = squizHook(worktree, tools.path, payload());

    assert.equal(
      result.stderr,
      `squiz: no review ran: no open pull request has "${BRANCH}" as its head, in ${JSON.stringify(worktree)}\n`,
      "a path with its spaces collapsed names a directory that does not exist",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a gh that failed says so, where a branch with no pull request would say nothing", async () => {
  await withRepository(async (worktree) => {
    // It prints an empty list as well as failing, so nothing but the exit
    // status stands between a broken install and a silent round.
    const tools = await toolsIn(worktree, {
      pullRequests: "[]\n",
      status: 1,
      stderr: "HTTP 401: Bad credentials\nTry authenticating with: gh auth login\n",
    });

    const result = squizHook(worktree, tools.path, payload());

    assert.equal(result.code, 0, "a broken gh must not stop the coding agent finishing its turn");
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      `squiz: no review ran: the pull request for "${BRANCH}" could not be looked up: ` +
        "gh exited 1: HTTP 401: Bad credentials\n",
    );
  });
});

test("a gh that is not installed says so", async () => {
  await withRepository(async (worktree) => {
    const tools = await toolsIn(worktree, null);

    const result = squizHook(worktree, tools.path, payload());

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^squiz: no review ran: .*gh could not be run/u);
    assertOneLine(result.stderr);
  });
});

test("a detached HEAD asks gh nothing, and says it was detached and where", async () => {
  await withRepository(async (worktree) => {
    git(worktree, "checkout", "--quiet", "--detach");
    const tools = await toolsIn(worktree, { pullRequests: LISTING });

    const result = squizHook(worktree, tools.path, payload());

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      `squiz: no review ran: HEAD is detached in ${JSON.stringify(worktree)}, so no pull request has it as its head\n`,
    );
    assert.equal(tools.ghWasRun(), false, "a detached HEAD is not a branch to ask GitHub about");
  });
});

test("a directory that is no repository says so, and asks gh nothing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "squiz-hook-"));
  try {
    const tools = await toolsIn(directory, { pullRequests: LISTING });

    const result = squizHook(directory, tools.path, payload());

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      /^squiz: no review ran: the worktree could not be resolved: git exited 128: fatal: not a git repository/u,
    );
    assertOneLine(result.stderr);
    assert.equal(tools.ghWasRun(), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a hook fired with no payload runs no round", async () => {
  await withRepository(async (worktree) => {
    const tools = await toolsIn(worktree, { pullRequests: LISTING, diff: DIFF });

    const result = squizHook(worktree, tools.path, "");

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^squiz: no review ran: the hook was given no payload/u);
    assertOneLine(result.stderr);
    assert.equal(tools.ghWasRun(), false, "a round ran on a firing nothing is known about");
  });
});

test("nothing in a branch name reaches a shell", async () => {
  // `>pwned` writes a file if any of this is ever parsed by one, and the whole
  // name arriving as one argument is what says it was not.
  const directory = await mkdtemp(join(tmpdir(), "squiz-hook-"));
  try {
    const branch = "evil/$(id);>pwned";
    const worktree = realpathSync(directory);
    commitOn(worktree, branch);
    const tools = await toolsIn(worktree, { pullRequests: "[]\n" });

    const result = squizHook(worktree, tools.path, payload());

    assert.equal(result.code, 0);
    assert.deepEqual(tools.ghArguments().slice(-2), ["--head", branch]);
    assert.equal(existsSync(join(worktree, "pwned")), false, "the branch name reached a shell");
    assert.equal(
      result.stderr,
      `squiz: no review ran: no open pull request has ${JSON.stringify(branch)} as its head, in ${JSON.stringify(worktree)}\n`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * A call to the fake `gh`, named for what the harness was doing when it made it.
 *
 * The arguments do not tell these apart on their own: the threads listing, the
 * read-back a create makes, one thread's later comments and a verdict's mutation
 * are all `gh api graphql --include --input -`, and they differ only in the query
 * on stdin. Naming the call is what lets a plan land one create and refuse the
 * next.
 */
type GhCallKind =
  | "pull-request"
  | "threads"
  | "diff"
  | "create"
  | "read-back"
  | "thread-comments"
  | "verdict"
  | "summary";

/** What the fake `gh` does for one call. */
type Answer = {
  /**
   * How long it takes to answer.
   *
   * Slept after the request has been read and before anything is written, so the
   * call spends the share it was made in having done what was asked of it.
   */
  readonly sleepMs?: number;
  readonly status?: number;
  readonly stdout?: string;
  readonly stderr?: string;
};

/**
 * What the fake `gh` answers, per kind of call.
 *
 * A kind's answers are taken in order and the last one repeats, so two entries
 * are one create that lands and every create after it refused. A kind with no
 * entry at all is a call the test did not plan for, and the fake fails loudly
 * rather than answering it.
 */
type GhPlan = Readonly<Partial<Record<GhCallKind, readonly Answer[]>>>;

/** What the fake reviewer reports, and whether it says the review is done. */
type ReviewerPlan = {
  /** The prose of its one assistant message. */
  readonly said: string;
  /** What that message stopped for. `stop` is a reviewer that answered and stopped. */
  readonly stopReason: string;
  readonly findings: readonly Finding[];
  /** Whether it calls the reporting tool that declares the review complete. */
  readonly finish: boolean;
};

/** One call the fake `gh` made, as it recorded it. */
type GhCallRecord = {
  readonly kind: GhCallKind | "other";
  readonly argv: readonly string[];
  /** The request body, which arrived on stdin and was read whole before answering. */
  readonly body: string;
};

/** The `PATH` the hook is given, and what the two fakes recorded on it. */
type Harness = {
  readonly path: string;
  /** Every call to `gh`, in the order they were made. */
  readonly ghCalls: () => readonly GhCallRecord[];
  /** How many times the reviewer was started, which a retry moves to 2. */
  readonly reviewerRuns: () => number;
};

/** A worktree on `BRANCH`, and a directory beside it that the round never reads. */
type Fixture = {
  readonly worktree: string;
  readonly beside: string;
};

/**
 * A repository with one commit on `BRANCH`, and a sibling directory for the
 * fakes and their logs.
 *
 * Beside the worktree rather than inside it: what a fake writes must not land in
 * the tree under review, and one of these tests seals the episode's own
 * directory against writing.
 */
async function withWorktree<T>(body: (fixture: Fixture) => Promise<T>): Promise<T> {
  const under = await mkdtemp(join(tmpdir(), "squiz-forced-"));
  try {
    const worktree = join(under, "tree");
    mkdirSync(worktree);
    commitOn(worktree, BRANCH);
    return await body({ worktree: realpathSync(worktree), beside: under });
  } finally {
    await rm(under, { recursive: true, force: true });
  }
}

/**
 * A `PATH` carrying git, ps, a fake `gh` and a fake reviewer, and the logs the
 * two fakes write.
 *
 * The system's own `PATH` is left out so that a `gh` or a reviewer installed on
 * the machine running the tests cannot be reached by one of them. ps stays,
 * because a round without it cannot mark itself as running and says so.
 */
async function harnessIn(
  beside: string,
  plan: { readonly gh: GhPlan; readonly reviewer: ReviewerPlan },
): Promise<Harness> {
  const path = join(beside, "tools");
  const ghLog = join(beside, "gh-calls");
  const reviewerLog = join(beside, "reviewer-runs");
  mkdirSync(path);
  symlinkSync(onSystemPath("git"), join(path, "git"));
  symlinkSync(onSystemPath("ps"), join(path, "ps"));
  await writeFile(ghLog, "", "utf8");
  await writeFile(reviewerLog, "", "utf8");
  standIn(path, "gh", ghScript(plan.gh, ghLog), "node");
  standIn(path, "pi", reviewerScript(plan.reviewer, reviewerLog), "node");

  return {
    path,
    ghCalls: () => recorded(ghLog).map((line) => JSON.parse(line) as GhCallRecord),
    reviewerRuns: () => recorded(reviewerLog).length,
  };
}

function recorded(file: string): readonly string[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

/**
 * The fake `gh`: it names the call it was asked for, records it, and answers what
 * the plan says.
 *
 * **It reads the whole of its stdin before it answers anything.** A `gh` that
 * exits 0 on a request it had not finished reading is reported as never having
 * reached GitHub, whatever it printed, so a fake that raced the write would
 * sometimes answer with that instead of what the plan says. Draining first is
 * what makes every answer here the plan's.
 *
 * Plain CommonJS, because it is written to a file and run by a fresh process
 * rather than type-stripped and imported.
 */
function ghScript(plan: GhPlan, log: string): string {
  return `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");

const plan = ${JSON.stringify(plan)};
const log = ${JSON.stringify(log)};
const argv = process.argv.slice(2);

function kindOf(body) {
  if (argv[0] === "pr") return "pull-request";
  if (argv[0] !== "api") return "other";
  if (argv[1] === "graphql") {
    if (body.indexOf("mutation(") !== -1) return "verdict";
    if (body.indexOf("$pullRequest") !== -1) return "threads";
    if (body.indexOf("$comment") !== -1) return "read-back";
    if (body.indexOf("$thread") !== -1) return "thread-comments";
    return "other";
  }
  let path = "";
  for (const argument of argv) {
    if (argument.indexOf("repos/") === 0) path = argument;
  }
  if (path.indexOf("/issues/") !== -1) return "summary";
  if (path.indexOf("/pulls/") === -1) return "other";
  return path.slice(-9) === "/comments" ? "create" : "diff";
}

function answer(body) {
  const kind = kindOf(body);
  const before = fs.readFileSync(log, "utf8").split("\\n").filter((line) => line !== "");
  const made = before.filter((line) => JSON.parse(line).kind === kind).length;
  fs.appendFileSync(log, JSON.stringify({ kind: kind, argv: argv, body: body }) + "\\n");

  const answers = plan[kind];
  if (answers === undefined || answers.length === 0) {
    fs.writeSync(2, "fake gh: nothing was planned for a " + kind + " call\\n");
    process.exit(97);
  }
  const given = answers[Math.min(made, answers.length - 1)];
  setTimeout(() => {
    if (given.stdout !== undefined) fs.writeSync(1, given.stdout);
    if (given.stderr !== undefined) fs.writeSync(2, given.stderr);
    process.exit(given.status === undefined ? 0 : given.status);
  }, given.sleepMs === undefined ? 0 : given.sleepMs);
}

const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("error", () => answer(Buffer.concat(chunks).toString("utf8")));
process.stdin.on("end", () => answer(Buffer.concat(chunks).toString("utf8")));
`;
}

/**
 * The fake reviewer: one assistant message, then the reporting calls the plan
 * gives it.
 *
 * It records that it ran, which is how a retry is read back. Nothing about the
 * command line it was handed is checked here; what reaches the reviewer is
 * established where the reviewer is.
 */
function reviewerScript(plan: ReviewerPlan, log: string): string {
  return `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");

const plan = ${JSON.stringify(plan)};
fs.appendFileSync(${JSON.stringify(log)}, "ran\\n");

const say = (event) => fs.writeSync(1, JSON.stringify(event) + "\\n");
const answered = (id, toolName, details) =>
  say({
    type: "tool_execution_end",
    toolCallId: String(id),
    toolName: toolName,
    isError: false,
    result: { content: [{ type: "text", text: "Reported" }], details: details },
  });

say({
  type: "message_end",
  message: {
    role: "assistant",
    model: "stand-in",
    stopReason: plan.stopReason,
    content: [{ type: "text", text: plan.said }],
    usage: {
      input: 1000,
      output: 200,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1200,
      cost: { input: 0.0008, output: 0.0002, cacheRead: 0, cacheWrite: 0, total: 0.001 },
    },
  },
});

let call = 1;
for (const finding of plan.findings) answered(call++, "report_finding", finding);
if (plan.finish) answered(call++, "finish_review", {});
process.exit(0);
`;
}

/** A finding the fake reviewer confirms, anchored to a line the change added. */
function confirmed(line: number, severity: Finding["severity"], headline: string): Finding {
  return {
    scope: "line",
    file: REVIEWED_FILE,
    line,
    severity,
    headline,
    reasoning: ["the caller has no way to tell the two apart"],
    suggestedFix: "return the reason beside the outcome",
  };
}

/** A reviewer that reports `findings` and declares its review complete. */
function reviews(findings: readonly Finding[]): ReviewerPlan {
  return {
    said: "Read the change and reported what it found.",
    stopReason: "toolUse",
    findings,
    finish: true,
  };
}

/** The comment GitHub creates, and the thread the read-back then matches to it. */
const COMMENT_ID = 9001;
const THREAD_ID = "PRRT_kwDOA1";

const CREATED = response("201 Created", {
  id: COMMENT_ID,
  node_id: "PRRC_kwDOA1",
  html_url: `https://github.com/squiz/squiz/pull/${PULL_REQUEST}#discussion_r${COMMENT_ID}`,
});

/** The read-back finding the thread the created comment opened. */
const THREAD_READ_BACK = response("200 OK", {
  data: {
    node: {
      pullRequest: {
        reviewThreads: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{ id: THREAD_ID, comments: { nodes: [{ databaseId: COMMENT_ID }] } }],
        },
      },
    },
  },
});

const SUMMARY_UP = response("201 Created", { id: 7001 });

/** A call GitHub refused, which `gh` reports by its exit status and its stderr. */
const GATEWAY_REFUSED: Answer = {
  status: 1,
  stdout: response("502 Bad Gateway", { message: "Bad gateway" }),
  stderr: "gh: HTTP 502: Bad gateway\n",
};

/** The one line the harness reports a call GitHub refused as. */
const GATEWAY_REASON = "gh exited 1 on HTTP 502: gh: HTTP 502: Bad gateway";

/**
 * A page of the read-back that names no thread and claims another page follows.
 *
 * It is what makes a create's read-back page: one create is a create and up to
 * twenty pages of read-back, so the posting margin is split for two calls and
 * spent by however many the walk takes.
 */
function readBackPageBefore(cursor: string): string {
  return response("200 OK", {
    data: {
      node: {
        pullRequest: {
          reviewThreads: { pageInfo: { hasNextPage: true, endCursor: cursor }, nodes: [] },
        },
      },
    },
  });
}

/** A page of the threads listing carrying one thread, with another page to come. */
function threadsPageBefore(cursor: string): string {
  return response("200 OK", {
    data: {
      node: {
        reviewThreads: {
          pageInfo: { hasNextPage: true, endCursor: cursor },
          nodes: [
            {
              id: "PRRT_kwDOEarlier",
              isResolved: false,
              isOutdated: false,
              path: REVIEWED_FILE,
              line: 86,
              originalLine: 86,
              subjectType: "LINE",
              comments: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ databaseId: 11, author: { login: "squiz" }, body: "an earlier finding" }],
              },
            },
          ],
        },
      },
    },
  });
}

/** The pre-review calls of a round that gets as far as reviewing. */
const REACHES_THE_REVIEW: GhPlan = {
  "pull-request": [{ stdout: LISTING }],
  threads: [{ stdout: NO_THREADS }],
  diff: [{ stdout: DIFF }],
};

/** What each call to `gh` was, in order, which is the whole of what reached GitHub. */
function callKinds(harness: Harness): readonly string[] {
  return harness.ghCalls().map((call) => call.kind);
}

/** The request body of `call`, parsed as the JSON it was sent as. */
function sentBy(call: GhCallRecord): Readonly<Record<string, unknown>> {
  return JSON.parse(call.body) as Readonly<Record<string, unknown>>;
}

const LANDED = "the reason is dropped and the outcome returned alone";
const LOST = "the retry runs on a bound that is already spent";

test("a create GitHub refuses leaves the comment that landed where it is", async () => {
  // The round closes rather than blocks, so what it could not post is on its
  // stderr and in its summary comment. A blocked round says neither, and a later
  // round makes the missing comment again.
  await withWorktree(async ({ worktree, beside }) => {
    await writeFile(join(worktree, ".squiz.json"), JSON.stringify({ rounds: 1 }), "utf8");
    const harness = await harnessIn(beside, {
      gh: {
        ...REACHES_THE_REVIEW,
        create: [{ stdout: CREATED }, GATEWAY_REFUSED],
        "read-back": [{ stdout: THREAD_READ_BACK }],
        summary: [{ stdout: SUMMARY_UP }],
      },
      reviewer: reviews([confirmed(86, "high", LANDED), confirmed(87, "medium", LOST)]),
    });

    const result = squizHook(worktree, harness.path, payload());

    assert.equal(result.code, 0, "a round that lost a comment must not stop the turn");
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      "squiz: the round closed the episode on PR #142 having failed to post 1 of 2 findings\n",
    );

    assert.deepEqual(
      callKinds(harness),
      ["pull-request", "threads", "diff", "create", "read-back", "create", "summary"],
      "the comment that landed was re-read, re-posted or taken down",
    );

    const creates = harness.ghCalls().filter((call) => call.kind === "create");
    assert.equal(sentBy(creates[0] as GhCallRecord)["line"], 86);
    assert.equal(sentBy(creates[1] as GhCallRecord)["line"], 87);

    const summary = harness.ghCalls().find((call) => call.kind === "summary");
    const body = String(sentBy(summary as GhCallRecord)["body"]);
    assert.ok(
      body.includes(`\`${REVIEWED_FILE}:86\` — ${LANDED} (open)`),
      `the summary does not report the comment that landed as a thread: ${body}`,
    );
    assert.ok(
      body.includes(`\`${REVIEWED_FILE}:87\` — ${LOST} (raised, and its comment could not be posted)`),
      `the summary does not report the finding nothing on the pull request holds: ${body}`,
    );
  });
});

test("a state file that will not take the round after the review posts nothing", async () => {
  // The write happens after the review, and it stops what the round found from
  // being posted. The reviewer's own directories are made before the episode's
  // directory is sealed, so the round reaches the review and fails on the write
  // that follows it rather than on the read that precedes it.
  await withWorktree(async ({ worktree, beside }) => {
    const episode = join(worktree, ".squiz", AGENT_ID);
    await mkdir(join(episode, "session"), { recursive: true });
    await mkdir(join(episode, "scratch"), { recursive: true });
    const harness = await harnessIn(beside, {
      gh: { ...REACHES_THE_REVIEW, summary: [{ stdout: SUMMARY_UP }] },
      reviewer: reviews([confirmed(86, "high", LANDED)]),
    });
    await chmod(episode, 0o555);

    try {
      const result = squizHook(worktree, harness.path, payload());

      assert.equal(result.code, 0, "a state file nothing can write must not stop the turn");
      assert.equal(result.stdout, "");
      assert.match(
        result.stderr,
        /^squiz: nothing the reviewer found was posted: .*state\.json could not be written: [A-Z]+: /u,
        "the pointer must carry the filesystem's own error rather than the word failed",
      );
      assert.match(result.stderr, /\nsquiz: the failure is posted on PR #142\n$/u);

      assert.equal(harness.reviewerRuns(), 1, "the review has to have run for this to be the write");
      assert.deepEqual(
        callKinds(harness),
        ["pull-request", "threads", "diff", "summary"],
        "a finding reached the pull request on a round that recorded nothing",
      );
    } finally {
      // Sealed against writing, so it cannot be removed while it stays that way.
      await chmod(episode, 0o755);
    }
  });
});

/** A round that reviews, finds nothing, and closes the episode with its summary up. */
const CLOSES_CLEAN: GhPlan = { ...REACHES_THE_REVIEW, summary: [{ stdout: SUMMARY_UP }] };

test("a marker the round could not write is named on stderr and nowhere on the pull request", async () => {
  // A directory where the marker goes: the rename that would put it there fails,
  // and nothing else the round writes is in its way.
  await withWorktree(async ({ worktree, beside }) => {
    const marker = join(worktree, ".squiz", AGENT_ID, "running.json");
    await mkdir(join(marker, "occupied"), { recursive: true });
    const harness = await harnessIn(beside, { gh: CLOSES_CLEAN, reviewer: reviews([]) });

    const result = squizHook(worktree, harness.path, payload());

    assert.equal(result.code, 0, "a round no other episode can find must not stop the turn");
    assert.equal(result.stdout, "");
    assert.ok(
      result.stderr.startsWith(
        "squiz: the round closed the episode on PR #142 having failed to mark itself as " +
          `running for the other episodes of the worktree: ${marker} could not be written: `,
      ),
      `the pointer does not name the marker and why it was not written: ${result.stderr}`,
    );
    assertOneLine(result.stderr);

    const summary = harness.ghCalls().find((call) => call.kind === "summary");
    const body = String(sentBy(summary as GhCallRecord)["body"]);
    assert.ok(!body.includes("running.json"), `the marker reached the summary: ${body}`);
  });
});

test("a marker the round wrote is not mentioned anywhere", async () => {
  await withWorktree(async ({ worktree, beside }) => {
    const harness = await harnessIn(beside, { gh: CLOSES_CLEAN, reviewer: reviews([]) });

    const result = squizHook(worktree, harness.path, payload());

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "", "a round that marked itself reported a marker anyway");
    assert.deepEqual(callKinds(harness), ["pull-request", "threads", "diff", "summary"]);
  });
});

test("a posting margin spent by one read-back leaves the rest unposted and unattempted", async () => {
  // The margin is split for one create and one read-back per finding, and the
  // read-back walks as many pages as GitHub claims. Four pages that answer slowly
  // and a fifth killed by what is left of the margin spend the whole of it, and
  // every call after that is one the round does not make at all.
  //
  // A tenth of the real margin and of each page, so a page still answers inside
  // its share of the margin and the fifth is still killed by what is left.
  const slow = 2_500;
  await withWorktree(async (fixture) => {
    const { worktree, beside } = fixture;
    await writeFile(join(worktree, ".squiz.json"), JSON.stringify({ rounds: 1 }), "utf8");
    const harness = await harnessIn(beside, {
      gh: {
        ...REACHES_THE_REVIEW,
        create: [{ stdout: CREATED }],
        "read-back": [
          { sleepMs: slow, stdout: readBackPageBefore("page-2") },
          { sleepMs: slow, stdout: readBackPageBefore("page-3") },
          { sleepMs: slow, stdout: readBackPageBefore("page-4") },
          { sleepMs: slow, stdout: readBackPageBefore("page-5") },
          { sleepMs: slow, stdout: readBackPageBefore("page-6") },
        ],
      },
      reviewer: reviews([confirmed(86, "high", LANDED), confirmed(87, "medium", LOST)]),
    });

    const result = squizHookLowered(fixture, harness.path, payload(), { marginMs: 12_000 });

    assert.equal(result.code, 0, "a window that closed must not stop the turn");
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      "squiz: the round closed the episode on PR #142 having failed to post 1 of 2 findings " +
        "and to post the episode's summary: " +
        "the time left for GitHub ran out before this call was made\n",
    );

    assert.deepEqual(
      callKinds(harness),
      [
        "pull-request",
        "threads",
        "diff",
        "create",
        "read-back",
        "read-back",
        "read-back",
        "read-back",
        "read-back",
      ],
      "a call was made past the end of the window, where the runtime kills the hook",
    );
  });
});

test("a threads listing that cannot be finished runs no reviewer and posts nothing", async () => {
  // The page that arrived is dropped with the rest. A reviewer handed a subset of
  // the threads rules on a subset, and the round would then apply verdicts that
  // close nothing while reading as a round that settled everything.
  await withWorktree(async ({ worktree, beside }) => {
    const harness = await harnessIn(beside, {
      gh: {
        "pull-request": [{ stdout: LISTING }],
        threads: [{ stdout: threadsPageBefore("page-2") }, GATEWAY_REFUSED],
        summary: [{ stdout: SUMMARY_UP }],
      },
      reviewer: reviews([confirmed(86, "high", LANDED)]),
    });

    const result = squizHook(worktree, harness.path, payload());

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      `squiz: no review ran: the threads on PR #142 could not be listed: ${GATEWAY_REASON}\n` +
        "squiz: the failure is posted on PR #142\n",
    );

    assert.equal(harness.reviewerRuns(), 0, "a reviewer ran on a subset of the threads");
    assert.deepEqual(callKinds(harness), ["pull-request", "threads", "threads", "summary"]);
  });
});

test("the calls before the review spending their share leave the last of them nothing", async () => {
  // One deadline over the whole phase, not a bound on each of its calls. The
  // lookup and the listing answer slowly enough that the diff is bounded by what
  // they left rather than by the ceiling on a single call, which is what says the
  // phase ran out rather than one call hanging.
  //
  // A tenth of the real share and of each call, so the first two still answer
  // and the diff is still left less than it needs.
  const slow = 2_500;
  await withWorktree(async (fixture) => {
    const harness = await harnessIn(fixture.beside, {
      gh: {
        "pull-request": [{ sleepMs: slow, stdout: LISTING }],
        threads: [{ sleepMs: slow, stdout: NO_THREADS }],
        diff: [{ sleepMs: slow, stdout: DIFF }],
        summary: [{ stdout: SUMMARY_UP }],
      },
      reviewer: reviews([confirmed(86, "high", LANDED)]),
    });

    const result = squizHookLowered(fixture, harness.path, payload(), { preReviewMs: 6_000 });

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    const spent =
      /^squiz: no review ran: the diff of PR #142 could not be fetched: gh did not answer within (\d+(?:\.\d+)?) seconds, so GitHub could not be reached\nsquiz: the failure is posted on PR #142\n$/u.exec(
        result.stderr,
      );
    assert.notEqual(spent, null, `the pointer does not name the call that ran out: ${result.stderr}`);
    assert.ok(
      Number(spent?.[1]) * 1_000 < slow,
      `the diff was bounded by something other than what the phase left it: ${result.stderr}`,
    );

    assert.equal(harness.reviewerRuns(), 0);
    assert.deepEqual(
      callKinds(harness),
      ["pull-request", "threads", "diff", "summary"],
      "the posting reserve is the round's own, so the failure goes up after the phase before it ran out",
    );
  });
});

test("a reviewer that writes prose and stops is retried once and reported as no review", async () => {
  // Nothing declares a review complete but the reviewer, so prose and a clean
  // exit is a review that did not finish rather than one that found nothing. The
  // round runs a fresh process once before it reports it.
  await withWorktree(async ({ worktree, beside }) => {
    const harness = await harnessIn(beside, {
      gh: { ...REACHES_THE_REVIEW, summary: [{ stdout: SUMMARY_UP }] },
      reviewer: {
        said: "Nothing here looks wrong to me.",
        stopReason: "stop",
        findings: [],
        finish: false,
      },
    });

    const result = squizHook(worktree, harness.path, payload());

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      "squiz: the review did not run: the reviewer reported nothing and did not finish its review\n" +
        "squiz: the failure is posted on PR #142\n",
    );

    assert.equal(harness.reviewerRuns(), 2, "the round is allowed one retry and has to take it");
    assert.deepEqual(callKinds(harness), ["pull-request", "threads", "diff", "summary"]);
  });
});
