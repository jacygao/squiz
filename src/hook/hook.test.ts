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
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { Config } from "../config/config.ts";
import type { Finding } from "../findings/finding.ts";
import type { Episode } from "../loop/episode.ts";
import type { FindingOutcome } from "../loop/post-findings.ts";
import type { ClosingReason } from "../loop/round-decision.ts";
import type { RoundConclusion, RoundFailure } from "../loop/round.ts";
import type { AppliedVerdict } from "../loop/verdicts.ts";
import { failureIn } from "./hook.ts";
import { failureLine } from "./report.ts";

const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const hookModule = new URL("./hook.ts", import.meta.url).href;

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
        reopened: ruled.filter((thread) => thread.outcome === "reopened").length,
      },
    },
  };
}

function closedRound(
  because: ClosingReason,
  outcomes: readonly FindingOutcome[] = [],
  ruled: readonly AppliedVerdict[] = [],
  unreadableDiff?: Error,
): RoundConclusion {
  return {
    outcome: "close",
    because,
    pullRequest: PULL_REQUEST,
    posted: [],
    findings: unreadableDiff === undefined ? { outcomes } : { outcomes, unreadableDiff },
    verdicts: {
      threads: ruled,
      unapplied: [],
      reopened: ruled.filter((thread) => thread.outcome === "reopened").length,
    },
  };
}

function blockedRound(reason: string): RoundConclusion {
  return {
    outcome: "block",
    reason,
    pullRequest: PULL_REQUEST,
    posted: ["PRRT_kwDOA"],
    findings: { outcomes: [] },
    verdicts: { threads: [], unapplied: [], reopened: 0 },
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

/** The pointer for `conclusion`, or the assertion that it composed none. */
function pointerFor(conclusion: RoundConclusion): string {
  const failure = failureIn(conclusion);
  assert.notEqual(failure, null, `nothing was reported for ${JSON.stringify(conclusion)}`);
  return failure ?? "";
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
  assert.equal(failureIn(closedRound("round-cap")), null);
  assert.equal(failureIn(closedRound("token-bound")), null);
  assert.equal(failureIn(closedRound("nothing-open")), null);
});

test("a branch with no pull request says nothing", () => {
  assert.equal(failureIn({ outcome: "no-pull-request" }), null);
});

test("a blocked round composes no pointer", () => {
  // Its stderr is the blocking reason and nothing beside it.
  assert.equal(failureIn(blockedRound("Squiz reviewed the change on this branch.")), null);
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
  assert.equal(failureIn(closedRound("nothing-open", [noted("the change needs a test")])), null);
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

test("a round that posted everything it found and applied every verdict says nothing", () => {
  const conclusion = closedRound("nothing-open", [threaded("the anchor is off")], [applied("PRRT_1")]);

  assert.equal(failureIn(conclusion), null);
});

/** The reason a killed round that salvaged two findings gives for itself. */
const KILLED =
  "the reviewer was killed at its 480-second bound, and the round kept the 2 findings the reviewer had reported";

test("a salvaged round that could not post what it kept says so on the failure's line", () => {
  // A salvaged finding that reached no thread is as lost as any other, and the
  // round that failed is the only thing that will ever have held it.
  const conclusion = salvagedRound("timed-out", KILLED, [
    threaded("the caller cannot tell the two apart"),
    unpostable("the retry runs on a spent bound"),
  ]);

  assert.equal(
    pointerFor(conclusion),
    `${KILLED}; it failed to post 1 of 2 findings on PR #142`,
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
    `${reason}; it failed to apply 1 of 2 verdicts on PR #142`,
  );
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
  ];

  for (const conclusion of conclusions) {
    const line = failureLine(pointerFor(conclusion));
    assert.equal(line.indexOf("\n"), line.length - 1, `not one line: ${JSON.stringify(line)}`);
    assert.ok(line.startsWith("squiz: "), `no prefix: ${JSON.stringify(line)}`);
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
  const round = setup.round ?? { returns: { outcome: "no-pull-request" } };
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
  // The hook is given the session's directory, which is somewhere inside the
  // worktree and not necessarily its root.
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
  readonly status?: number;
  readonly stderr?: string;
};

type Tools = {
  /** A `PATH` holding git, and the fake `gh` where there is one. */
  readonly path: string;
  readonly ghWasRun: () => boolean;
  readonly ghArguments: () => readonly string[];
};

/**
 * A `PATH` carrying git and nothing else that matters.
 *
 * The system's own `PATH` is left out so that a reviewer installed on the
 * machine running the tests cannot be started by one of them.
 */
async function toolsIn(directory: string, gh: Answers | null): Promise<Tools> {
  const path = join(directory, "tools");
  const argumentLog = join(directory, "gh-arguments");
  mkdirSync(path);
  symlinkSync(whichGit(), join(path, "git"));

  if (gh !== null) {
    const binary = join(path, "gh");
    await writeFile(
      binary,
      [
        "#!/bin/sh",
        'for argument in "$@"; do',
        `  printf '%s\\n' "$argument" >> ${quote(argumentLog)}`,
        "done",
        "case $1 in",
        `  pr) printf '%s' ${quote(gh.pullRequests ?? "")} ;;`,
        `  api) printf '%s' ${quote(gh.diff ?? "")} ;;`,
        "esac",
        `printf '%s' ${quote(gh.stderr ?? "")} >&2`,
        `exit ${gh.status ?? 0}`,
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(binary, 0o755);
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

function whichGit(): string {
  for (const entry of (process.env["PATH"] ?? "").split(":")) {
    if (entry === "") continue;
    const candidate = join(entry, "git");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not this entry. The next one, or none at all.
    }
  }
  return assert.fail("git is not on PATH, and every fixture here needs it");
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

const DIFF = [
  "diff --git a/src/ui/card.ts b/src/ui/card.ts",
  "index d3d0cb2..6db135b 100644",
  "--- a/src/ui/card.ts",
  "+++ b/src/ui/card.ts",
  "@@ -85,7 +85,7 @@",
  "-// line 88",
  "+// line 88 CHANGED",
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
    assert.match(result.stderr, /^squiz: the reviewer could not run: /u);
    assertOneLine(result.stderr);
  });
});

test("a branch with no pull request posts nothing, runs nothing and says nothing", async () => {
  await withRepository(async (worktree) => {
    const tools = await toolsIn(worktree, { pullRequests: "[]\n" });

    const result = squizHook(worktree, tools.path, payload());

    assert.equal(result.code, 0, "only exit 2 blocks a turn, and no round ran");
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "", "silence is what a branch with no pull request looks like");
    assert.ok(tools.ghWasRun(), "the branch was never asked about");
  });
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

test("a detached HEAD asks gh nothing and says nothing", async () => {
  await withRepository(async (worktree) => {
    git(worktree, "checkout", "--quiet", "--detach");
    const tools = await toolsIn(worktree, { pullRequests: LISTING });

    const result = squizHook(worktree, tools.path, payload());

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
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
    assert.equal(result.stderr, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
