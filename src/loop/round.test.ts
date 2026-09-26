/**
 * A round is driven end to end, against a real git work tree, a `gh` on `PATH`
 * and a reviewer process the round starts itself.
 *
 * The failure these are arranged around is a round the reviewer failed reading
 * as a round that found nothing, so every reviewer outcome is exercised beside
 * an honest empty review and the two are asserted to be different conclusions.
 *
 * Which calls a round makes is part of what it does: round 1 hands over no
 * threads and must not list them, and a round that ended before the review must
 * post nothing. The fake `gh` records the kind of every call for that reason.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { defaultConfig, type Config } from "../config/config.ts";
import type { Finding } from "../findings/finding.ts";
import {
  unspent,
  type Adapter,
  type Invocation,
  type ParsedRun,
  type RoundCost,
  type RoundOutput,
  type ThreadVerdict,
} from "../reviewers/adapter.ts";
import { writeState, type EpisodeState } from "./episode-state.ts";
import { episodeAt } from "./episode.ts";
import { runRound, type RoundConclusion } from "./round.ts";

const BRANCH = "review-me";
const PULL_REQUEST = 142;
const HEAD_SHA = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";

/** The subagent id the episode keys on, which is hexadecimal as every real one is. */
const AGENT_ID = "ab12cd34";

/**
 * `git diff` of one changed line, which is the one line a comment can be
 * anchored to. A finding on line 88 of it threads inline; one anywhere else does
 * not.
 */
const DIFF = `
diff --git a/src/ui/card.ts b/src/ui/card.ts
index d3d0cb2..6db135b 100644
--- a/src/ui/card.ts
+++ b/src/ui/card.ts
@@ -85,7 +85,7 @@
 // line 85
 // line 86
 // line 87
-// line 88
+// line 88 CHANGED
 // line 89
 // line 90
 // line 91
`.slice(1);

/** Which call to `gh` the fake was asked for. */
type Kind = "prlist" | "diff" | "threads" | "create" | "lookup" | "resolve" | "unresolve";

/** What the fake answers each kind of call with. A kind with no answer exits 1. */
type Answers = Partial<Record<Kind, string>>;

/** A reviewer the round starts and reads, standing in for a CLI. */
type Reviewer = {
  /** The process the round starts. One that exits at once by default. */
  readonly command?: string;
  readonly args?: readonly string[];
  /** What reading its output establishes. */
  readonly parse: Adapter["parse"];
};

type Setup = {
  readonly answers: Answers;
  /**
   * Answers served in order for one kind, the first call taking the first entry.
   * A call past the end falls back to that kind's single answer.
   */
  readonly sequences?: Partial<Record<Kind, readonly string[]>>;
  /** Seconds a kind of call takes before it answers, for a call that has to be slow. */
  readonly delays?: Partial<Record<Kind, string>>;
  readonly reviewer: Reviewer;
  readonly config?: Partial<Config>;
  /** Rounds already recorded, which is what makes the round a later one. */
  readonly rounds?: readonly RoundCost[];
  /** What the episode already spent on attempts that were no round. */
  readonly outsideRounds?: RoundCost;
  /** A state file written as it stands, for a file the round cannot read. */
  readonly stateSource?: string;
  readonly marginMs?: number;
  readonly windowMs?: number;
  readonly detached?: boolean;
};

/** Everything the round left behind, read before the fixture is removed. */
type Ran = {
  readonly conclusion: RoundConclusion;
  /** The kind of each `gh` call, in the order the round made them. */
  readonly kinds: readonly Kind[];
  /** What the reviewer was handed, one entry per process the round started. */
  readonly invocations: readonly Invocation[];
  /** Whether both directories the reviewer writes into existed when it started. */
  readonly directoriesReady: readonly boolean[];
  readonly state: EpisodeState | null;
  /** The state file exactly as it stands, `null` where there is no file at all. */
  readonly stateSource: string | null;
  /** How long the round itself took, with the fixture's own setup left out. */
  readonly elapsedMs: number;
};

const ANSWER_COST: RoundCost = { dollars: 0.04, tokens: 1200, messages: 3 };

/**
 * A reviewer that returns a review.
 *
 * Empty findings and empty verdicts are what an honest empty review is, and it
 * goes through here rather than through any of the failures below.
 */
function reviews(output: {
  readonly findings?: readonly Finding[];
  readonly verdicts?: readonly ThreadVerdict[];
  readonly cost?: RoundCost;
}): Reviewer {
  return {
    parse: async (stdout): Promise<ParsedRun> => {
      await drain(stdout);
      return {
        cost: output.cost ?? ANSWER_COST,
        result: {
          kind: "reviewed",
          findings: output.findings ?? [],
          verdicts: output.verdicts ?? [],
        },
      };
    },
  };
}

/**
 * A reviewer that reports a cost and whatever `reported` carries, and then never
 * finishes, so the bound kills it.
 */
function hangs(cost: RoundCost, reported: Partial<RoundOutput> = {}): Reviewer {
  return {
    command: "/bin/sh",
    args: ["-c", "sleep 30"],
    parse: async (_stdout, progressSoFar): Promise<ParsedRun> => {
      // The round keeps what the reviewer reported before the bound fired, and
      // records the cost it had by then.
      progressSoFar?.({
        cost,
        ...nothingReported,
        ...reported,
        finished: false,
        broken: undefined,
      });
      // The round races the bound against this, and stops the process instead.
      await new Promise<never>(() => {});
      throw new Error("the round read a parse that never finished");
    },
  };
}

/** What a reviewer that reported nothing has reported. */
const nothingReported: RoundOutput = { findings: [], verdicts: [] };

/**
 * A reviewer that answers inside its bound and then holds on through the round's
 * cleanup.
 *
 * Its output closes at once, so the review is read and the round is left with
 * findings to post. It then ignores the signal that would stop it, so the round
 * spends the grace and the kill after the moment the review had to be over by.
 */
function answersThenHolds(findings: readonly Finding[]): Reviewer {
  return {
    command: "/bin/sh",
    // The wait is short and repeated, because a shell blocked in one long sleep
    // reaches its trap only once that sleep is over.
    args: ["-c", "trap '' TERM; exec 1>&-; while :; do sleep 0.2; done"],
    parse: reviews({ findings }).parse,
  };
}

/**
 * A reviewer that reports findings and then ignores both its bound and the signal
 * that would stop it.
 *
 * The round spends the grace and the kill after the moment the review had to be
 * over by, so it reaches the posting with the window already gone.
 */
function reportsThenHolds(cost: RoundCost, findings: readonly Finding[]): Reviewer {
  return {
    command: "/bin/sh",
    // The wait is short and repeated, because a shell blocked in one long sleep
    // reaches its trap only once that sleep is over.
    args: ["-c", "trap '' TERM; while :; do sleep 0.2; done"],
    parse: hangs(cost, { findings }).parse,
  };
}

/** A reviewer whose output cannot be read as a review, however often it is run. */
function unreadable(cost: RoundCost, findings: readonly Finding[] = []): Reviewer {
  return {
    parse: async (stdout, progressSoFar): Promise<ParsedRun> => {
      progressSoFar?.({ cost, findings, verdicts: [], finished: false, broken: undefined });
      await drain(stdout);
      return { cost, result: { kind: "unparsed", reason: "the last message was not a review" } };
    },
  };
}

/** A reviewer that ran, exited cleanly and completed no message. */
function completesNothing(cost: RoundCost, findings: readonly Finding[] = []): Reviewer {
  return {
    parse: async (stdout, progressSoFar): Promise<ParsedRun> => {
      progressSoFar?.({ cost, findings, verdicts: [], finished: false, broken: undefined });
      await drain(stdout);
      return { cost, result: { kind: "incomplete", reason: "the model refused the request" } };
    },
  };
}

/**
 * A reviewer whose attempts answer differently, in order.
 *
 * The round's own retry is what this is for: a first attempt that completed a
 * paid response the adapter could not read, and a second that failed before
 * completing one, come back as a setup problem carrying the first one's cost.
 */
function attempts(...runs: readonly ParsedRun[]): Reviewer {
  let at = 0;
  return {
    parse: async (stdout): Promise<ParsedRun> => {
      await drain(stdout);
      const run = runs[Math.min(at, runs.length - 1)];
      at += 1;
      if (run === undefined) throw new Error("the fixture ran out of attempts to answer with");
      return run;
    },
  };
}

/** A reviewer that is not installed, which is the setup problem a round cannot fix. */
const notInstalled: Reviewer = {
  command: "/nonexistent/squiz-reviewer",
  parse: async (stdout): Promise<ParsedRun> => {
    await drain(stdout);
    return { cost: { dollars: 0, tokens: 0, messages: 0 }, result: { kind: "reviewed", findings: [], verdicts: [] } };
  },
};

async function drain(stdout: AsyncIterable<string | Uint8Array>): Promise<void> {
  for await (const chunk of stdout) void chunk;
}

/**
 * Run one round against a fixture, and hand back everything it left behind.
 *
 * A real git work tree and a real `gh` on `PATH`: the gate asks git which branch
 * is checked out and `gh` which pull request has it as a head, and a round that
 * reached neither would still pass against injected answers.
 */
async function runInFixture(setup: Setup): Promise<Ran> {
  const root = await mkdtemp(join(tmpdir(), "squiz-round-"));
  const worktree = join(root, "tree");
  const binaries = join(root, "bin");
  const previous = process.env["PATH"];

  try {
    await mkdir(worktree);
    await mkdir(binaries);
    git(worktree, ["init", "--quiet", "--initial-branch", BRANCH]);
    git(worktree, ["config", "user.email", "squiz@example.invalid"]);
    git(worktree, ["config", "user.name", "Squiz"]);
    git(worktree, ["commit", "--quiet", "--allow-empty", "--message", "the change under review"]);
    if (setup.detached === true) git(worktree, ["checkout", "--quiet", "--detach", "HEAD"]);

    const charterFile = join(root, "charter.md");
    await writeFile(charterFile, "What a good review is.\n", "utf8");
    await writeFake(binaries, setup.answers, setup.sequences ?? {}, setup.delays ?? {});
    warm(binaries);
    process.env["PATH"] = `${binaries}:${previous ?? ""}`;

    const episode = episodeAt(worktree, AGENT_ID);
    if (setup.rounds !== undefined) {
      const written = writeState(episode, {
        pullRequest: PULL_REQUEST,
        rounds: setup.rounds,
        spentOutsideRounds: setup.outsideRounds ?? unspent,
      });
      assert.equal(written.outcome, "written", "the fixture's own state file must be written");
    }
    if (setup.stateSource !== undefined) {
      mkdirSync(episode.directory, { recursive: true });
      writeFileSync(episode.stateFile, setup.stateSource, "utf8");
    }

    const invocations: Invocation[] = [];
    const directoriesReady: boolean[] = [];
    const adapter: Adapter = {
      argv: (invocation) => {
        invocations.push(invocation);
        // Read here rather than after the round: the reviewer is told to write
        // into both, and both have to be there before its process starts.
        directoriesReady.push(
          existsSync(invocation.sessionDirectory) && existsSync(invocation.scratchDirectory),
        );
        return {
          command: setup.reviewer.command ?? "/bin/sh",
          args: [...(setup.reviewer.args ?? ["-c", "exit 0"])],
          directory: invocation.directory,
        };
      },
      parse: setup.reviewer.parse,
      grants: { read: ["read"], deep: ["read", "bash"] },
    };

    const started = Date.now();
    const conclusion = await runRound({
      episode,
      config: { ...defaultConfig, timeout: 5, ...setup.config },
      adapter,
      charterFile,
      ...(setup.marginMs === undefined ? {} : { marginMs: setup.marginMs }),
      ...(setup.windowMs === undefined ? {} : { windowMs: setup.windowMs }),
    });
    const elapsedMs = Date.now() - started;

    const stateSource = existsSync(episode.stateFile)
      ? readFileSync(episode.stateFile, "utf8")
      : null;
    return {
      conclusion,
      kinds: lines(join(binaries, "kinds")) as readonly Kind[],
      invocations,
      directoriesReady,
      state: stateIn(stateSource),
      stateSource,
      elapsedMs,
    };
  } finally {
    if (previous === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previous;
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Run the fake once, and forget that it ran.
 *
 * The system looks a newly written executable over the first time it is run, and
 * that look costs the best part of a second. A test that times what the round
 * spends would be timing the look, so it is paid for here instead.
 */
function warm(directory: string): void {
  try {
    execFileSync(join(directory, "gh"), ["--warm"], { stdio: "ignore" });
  } catch {
    // The fake has no answer for this, so it exits 1. Running it is the point.
  }
  for (const name of ["count", "kinds", "count-unknown", "stdin-1"]) {
    rmSync(join(directory, name), { force: true });
  }
}

/** The state file read back, or `null` where there is no state a test can read. */
function stateIn(source: string | null): EpisodeState | null {
  if (source === null) return null;
  try {
    return JSON.parse(source) as EpisodeState;
  } catch {
    // A file the fixture wrote that the round could not read either.
    return null;
  }
}

function git(directory: string, args: readonly string[]): void {
  execFileSync("git", [...args], { cwd: directory, stdio: "ignore" });
}

/**
 * A `gh` that answers by which call it was asked for, and records every one.
 *
 * A kind with no answer exits 1, so a test whose fixture does not cover a call
 * fails on that call rather than on one answer standing in for another.
 */
async function writeFake(
  directory: string,
  answers: Answers,
  sequences: Partial<Record<Kind, readonly string[]>>,
  delays: Partial<Record<Kind, string>>,
): Promise<void> {
  const script = [
    "#!/bin/sh",
    `dir=${quote(directory)}`,
    'n=$(cat "$dir/count" 2>/dev/null || echo 0)',
    "n=$((n + 1))",
    'printf %s "$n" > "$dir/count"',
    // Read stdin only where gh was told to, or a call that sends no body hangs.
    'case " $* " in *" --input "*) cat > "$dir/stdin-$n" ;; *) : > "$dir/stdin-$n" ;; esac',
    'request="$* $(cat "$dir/stdin-$n")"',
    "kind=unknown",
    'case "$request" in',
    // Before the resolve: one spelling is inside the other.
    "  *'unresolveReviewThread'*) kind=unresolve ;;",
    "  *'resolveReviewThread'*) kind=resolve ;;",
    // The read-back that follows a create reaches the threads from the comment.
    "  *'PullRequestReviewComment'*) kind=lookup ;;",
    "  *'reviewThreads(first:100'*) kind=threads ;;",
    "  *'--method POST'*) kind=create ;;",
    "  *'pr list'*) kind=prlist ;;",
    "  *'v3.diff'*) kind=diff ;;",
    "esac",
    'printf \'%s\\n\' "$kind" >> "$dir/kinds"',
    // Which call of this kind it is, so that a paging read-back can answer
    // differently each time.
    'k=$(cat "$dir/count-$kind" 2>/dev/null || echo 0)',
    "k=$((k + 1))",
    'printf %s "$k" > "$dir/count-$kind"',
    'if [ -f "$dir/delay-$kind" ]; then sleep "$(cat "$dir/delay-$kind")"; fi',
    'answer="$dir/answer-$kind-$k"',
    '[ -f "$answer" ] || answer="$dir/answer-$kind"',
    'if [ ! -f "$answer" ]; then',
    '  printf \'no answer fixtured for %s\\n\' "$kind" >&2',
    "  exit 1",
    "fi",
    'cat "$answer"',
    "exit 0",
    "",
  ].join("\n");

  await writeFile(join(directory, "gh"), script, "utf8");
  await chmod(join(directory, "gh"), 0o755);
  for (const [kind, answer] of Object.entries(answers)) {
    await writeFile(join(directory, `answer-${kind}`), answer, "utf8");
  }
  for (const [kind, ordered] of Object.entries(sequences)) {
    for (const [index, answer] of ordered.entries()) {
      await writeFile(join(directory, `answer-${kind}-${index + 1}`), answer, "utf8");
    }
  }
  for (const [kind, seconds] of Object.entries(delays)) {
    await writeFile(join(directory, `delay-${kind}`), seconds, "utf8");
  }
}

/** `text` as one shell word, so a fixture can hold whatever it needs to. */
function quote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

function lines(path: string): readonly string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

/** The pull request row `gh pr list --json` prints for the branch. */
const PR_LIST = JSON.stringify([
  {
    number: PULL_REQUEST,
    id: "PR_pull",
    baseRefName: "main",
    headRefName: BRANCH,
    headRefOid: HEAD_SHA,
    body: "What this changes.",
  },
]);

/** A response as `gh api --include` writes one: status line, headers, body. */
function included(status: string, body: string): string {
  return `HTTP/2.0 ${status}\nContent-Type: application/json; charset=utf-8\r\n\r\n${body}`;
}

/** The comment GitHub created, and the thread the read-back finds it in. */
const CREATED = included("201 Created", JSON.stringify({
  id: 9001,
  node_id: "PRRC_9001",
  html_url: `https://github.com/o/r/pull/${PULL_REQUEST}#discussion_r9001`,
}));

const LOOKUP = included("200 OK", JSON.stringify({
  data: {
    node: {
      pullRequest: {
        reviewThreads: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{ id: "PRRT_new", comments: { nodes: [{ databaseId: 9001 }] } }],
        },
      },
    },
  },
}));

const RESOLVED = included(
  "200 OK",
  JSON.stringify({ data: { resolveReviewThread: { thread: { isResolved: true } } } }),
);

const REOPENED = included(
  "200 OK",
  JSON.stringify({ data: { unresolveReviewThread: { thread: { isResolved: false } } } }),
);

/** One thread already on the pull request, as the listing reads it back. */
function listed(threads: readonly { readonly id: string; readonly isResolved: boolean }[]): string {
  return included(
    "200 OK",
    JSON.stringify({
      data: {
        node: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: threads.map((thread) => ({
              id: thread.id,
              isResolved: thread.isResolved,
              isOutdated: false,
              path: "src/ui/card.ts",
              line: 88,
              originalLine: 88,
              subjectType: "LINE",
              comments: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  { databaseId: 51, author: { login: "squiz" }, body: "The name says nothing." },
                ],
              },
            })),
          },
        },
      },
    }),
  );
}

/**
 * One page of the threads listing that names no thread and claims another
 * follows, for a listing that goes on paging until something stops it.
 */
function listedPage(cursor: string): string {
  return included(
    "200 OK",
    JSON.stringify({
      data: {
        node: {
          reviewThreads: { pageInfo: { hasNextPage: true, endCursor: cursor }, nodes: [] },
        },
      },
    }),
  );
}

/** A finding on the one line the diff carries, which threads inline. */
function finding(headline: string): Finding {
  return {
    scope: "line",
    file: "src/ui/card.ts",
    line: 88,
    severity: "high",
    headline,
    reasoning: ["The caller reads the old value."],
    suggestedFix: "Rename it.",
  };
}

/** Everything a round that posts one finding needs answering. */
const POSTING: Answers = { prlist: PR_LIST, diff: DIFF, create: CREATED, lookup: LOOKUP };

test("round 1 posts its finding, hands over no threads, and blocks", async () => {
  const ran = await runInFixture({
    answers: POSTING,
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.deepEqual(
    ran.kinds,
    ["prlist", "diff", "create", "lookup"],
    "round 1 must not list threads: there are none to rule on, and asking for them would have the reviewer rule on an empty list",
  );
  assert.equal(ran.conclusion.outcome, "block");
  assert.ok(ran.conclusion.outcome === "block");
  assert.deepEqual(ran.conclusion.posted, ["PRRT_new"]);
  assert.match(ran.conclusion.reason, /PRRT_new src\/ui\/card\.ts:88/u);
  assert.match(ran.conclusion.reason, new RegExp(`PR #${PULL_REQUEST}`, "u"));
  assert.equal(ran.invocations.length, 1);
  assert.equal(
    ran.invocations[0]?.prompt.includes("## Threads already on this pull request"),
    false,
    "a round-1 prompt that carried a threads section would ask for a verdict on nothing",
  );
});

test("the round's cost is recorded in the episode state with its token count", async () => {
  const ran = await runInFixture({
    answers: POSTING,
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.deepEqual(ran.state, {
    pullRequest: PULL_REQUEST,
    rounds: [ANSWER_COST],
    spentOutsideRounds: unspent,
  });
  assert.match(ran.stateSource ?? "", /"tokens": 1200/u);
});

test("the reviewer's session directory and scratch space exist before it starts", async () => {
  const ran = await runInFixture({
    answers: POSTING,
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.deepEqual(
    ran.directoriesReady,
    [true],
    "a scratch space that does not exist yet leaves the reviewer's temporary files in the tree under review",
  );
});

test("round 2 hands over every thread with its state and applies the verdicts", async () => {
  const ran = await runInFixture({
    rounds: [ANSWER_COST],
    answers: {
      prlist: PR_LIST,
      diff: DIFF,
      threads: listed([
        { id: "PRRT_one", isResolved: false },
        { id: "PRRT_two", isResolved: true },
      ]),
      resolve: RESOLVED,
      unresolve: REOPENED,
    },
    reviewer: reviews({
      verdicts: [
        { thread: "PRRT_one", verdict: "fixed" },
        { thread: "PRRT_two", verdict: "open" },
      ],
    }),
  });

  assert.deepEqual(ran.kinds, ["prlist", "threads", "diff", "resolve", "unresolve"]);
  const prompt = ran.invocations[0]?.prompt ?? "";
  assert.match(prompt, /### PRRT_one\n\nNot resolved\./u);
  assert.match(prompt, /### PRRT_two\n\nResolved\./u);
  assert.match(prompt, /The name says nothing\./u);

  assert.ok(ran.conclusion.outcome === "block");
  assert.deepEqual(ran.conclusion.posted, []);
  assert.match(
    ran.conclusion.reason,
    /left no new comments/u,
    "a round that found nothing new still blocks over what an earlier round left open, and must not claim it raised it",
  );
  assert.match(ran.conclusion.reason, /1 thread is open on it:\nPRRT_two/u);
});

test("a round that leaves nothing open closes the episode", async () => {
  const ran = await runInFixture({
    rounds: [ANSWER_COST],
    answers: {
      prlist: PR_LIST,
      diff: DIFF,
      threads: listed([{ id: "PRRT_one", isResolved: false }]),
      resolve: RESOLVED,
    },
    reviewer: reviews({ verdicts: [{ thread: "PRRT_one", verdict: "fixed" }] }),
  });

  assert.ok(ran.conclusion.outcome === "close");
  assert.equal(ran.conclusion.because, "nothing-open");
});

test("an honest empty review is a clean round and not a failure", async () => {
  const ran = await runInFixture({
    answers: { prlist: PR_LIST, diff: DIFF },
    reviewer: reviews({}),
  });

  assert.ok(ran.conclusion.outcome === "close");
  assert.equal(ran.conclusion.because, "nothing-open");
  assert.deepEqual(ran.conclusion.findings.outcomes, []);
  assert.equal(
    ran.state?.rounds.length,
    1,
    "a review that found nothing did the work, so it is a round and it spends one of the cap",
  );
});

test("a cap of 1 reviews once and closes rather than blocking", async () => {
  const ran = await runInFixture({
    config: { rounds: 1 },
    answers: POSTING,
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.ok(ran.conclusion.outcome === "close");
  assert.equal(ran.conclusion.because, "round-cap");
  assert.deepEqual(ran.conclusion.posted, ["PRRT_new"], "the round still posts what it found");
});

test("a round that reached the token bound closes the episode", async () => {
  const wide: RoundCost = { dollars: 0.41, tokens: 400_000, messages: 60 };
  const ran = await runInFixture({
    config: { rounds: 8, tokens: 400_000 },
    // A round under the bound already recorded, so the round that reaches it is
    // the one just run rather than the one the state file held.
    rounds: [ANSWER_COST],
    answers: {
      prlist: PR_LIST,
      diff: DIFF,
      threads: listed([{ id: "PRRT_one", isResolved: false }]),
      unresolve: REOPENED,
    },
    reviewer: reviews({ cost: wide, verdicts: [{ thread: "PRRT_one", verdict: "open" }] }),
  });

  assert.ok(ran.conclusion.outcome === "close");
  assert.equal(
    ran.conclusion.because,
    "token-bound",
    "a round the bound closed must not read as the reviewer having failed",
  );
  assert.deepEqual(
    ran.state?.rounds.at(-1),
    wide,
    "the dollars are still recorded beside the tokens the bound was read from",
  );
});

test("a reviewer killed at its bound is a failed round and not an empty review", async () => {
  const floor: RoundCost = { dollars: 0.02, tokens: 700, messages: 1 };
  const ran = await runInFixture({
    config: { timeout: 1 },
    answers: POSTING,
    reviewer: hangs(floor),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.equal(ran.conclusion.failure, "timed-out");
  assert.match(ran.conclusion.reason, /killed at its 1-second bound/u);
  assert.deepEqual(ran.kinds, ["prlist", "diff"], "a round with no review posts nothing");
  assert.deepEqual(
    ran.state,
    { pullRequest: PULL_REQUEST, rounds: [floor], spentOutsideRounds: unspent },
    "a killed round's floor is what it reported before it was stopped, and it counts against the cap",
  );
});

test("a reviewer nothing can be read from is reported unavailable", async () => {
  const each: RoundCost = { dollars: 0.01, tokens: 300, messages: 1 };
  const ran = await runInFixture({
    answers: POSTING,
    reviewer: unreadable(each),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.equal(ran.conclusion.failure, "unavailable");
  assert.deepEqual(ran.kinds, ["prlist", "diff"]);
  assert.deepEqual(
    ran.state?.rounds,
    [{ dollars: 0.02, tokens: 600, messages: 2 }],
    "the retry is a second process on the same round, and the round records what both spent",
  );
});

/**
 * A reviewer that would not start and one that ran and completed no message are
 * a setup problem rather than a bad round, and neither spends one of the cap.
 * Both fail the same way every firing until someone fixes the install or the
 * credential, and a cap charged for them leaves a project no rounds once it has.
 * Neither can run the loop away: a setup problem never blocks, so the coding
 * agent's turn ends and no further round fires.
 *
 * Asserted for a reviewer that reported a cost as well as for one that reported
 * none, because what decides is the outcome and not the figure.
 */
test("a reviewer that ran and completed no message spends no round of the cap", async () => {
  for (const cost of [
    { dollars: 0.005, tokens: 90, messages: 1 },
    { dollars: 0, tokens: 0, messages: 0 },
  ] satisfies readonly RoundCost[]) {
    const ran = await runInFixture({ answers: POSTING, reviewer: completesNothing(cost) });

    assert.ok(ran.conclusion.outcome === "failed");
    assert.equal(ran.conclusion.failure, "setup");
    assert.match(ran.conclusion.reason, /the model refused the request/u);
    assert.deepEqual(
      ran.state?.rounds ?? [],
      [],
      `a setup problem reporting ${cost.dollars} dollars was recorded as a round, and the cap it spends is one the project does not get back once the credential is fixed`,
    );
  }
});

test("a reviewer that is not installed spends no round of the cap", async () => {
  const ran = await runInFixture({
    answers: POSTING,
    reviewer: notInstalled,
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.equal(ran.conclusion.failure, "setup");
  assert.equal(
    ran.stateSource,
    null,
    "the same failure recurs every firing, and a cap spent on it would leave the episode no rounds once someone fixed the install",
  );
});

/**
 * Every outcome that is not a finished review carries what the reviewer had
 * reported before it failed, and each of them puts it on the pull request.
 *
 * The cost is asserted beside it, because posting something must not turn a
 * failed round into a clean one: a killed round and a round nothing could be read
 * from each record their floor, and a setup problem still spends no round of the
 * cap however much it salvaged.
 */
test("a round posts the findings the reviewer reported before it failed, whatever failed", async () => {
  const floor: RoundCost = { dollars: 0.02, tokens: 700, messages: 1 };
  const found = [finding("The flag is never read")];
  const failures = [
    {
      failure: "timed-out",
      reviewer: hangs(floor, { findings: found }),
      config: { timeout: 1 },
      rounds: [floor],
    },
    {
      failure: "unavailable",
      reviewer: unreadable(floor, found),
      config: {},
      // The retry is a second process on the same round, and both spent the floor.
      rounds: [{ dollars: 0.04, tokens: 1400, messages: 2 }],
    },
    {
      failure: "setup",
      reviewer: completesNothing(floor, found),
      config: {},
      rounds: [],
    },
  ] as const;

  for (const { failure, reviewer, config, rounds } of failures) {
    const ran = await runInFixture({ answers: POSTING, config, reviewer });

    assert.ok(ran.conclusion.outcome === "failed", `${failure} was not reported as a failed round`);
    assert.equal(ran.conclusion.failure, failure);
    assert.deepEqual(
      ran.conclusion.salvaged?.posted,
      ["PRRT_new"],
      `${failure} discarded the finding the reviewer had already confirmed`,
    );
    assert.deepEqual(ran.kinds, ["prlist", "diff", "create", "lookup"]);
    assert.match(ran.conclusion.reason, /kept the 1 finding the reviewer had reported/u);
    assert.deepEqual(
      ran.state?.rounds ?? [],
      rounds,
      `${failure} recorded a cost that is not what the round had when it failed`,
    );
  }
});

/**
 * A round that salvaged something is still a failed round, and the decision that
 * would block or close is never asked.
 *
 * The cap is 1 here, so a clean round of this shape would close the episode and
 * read as a review that ended healthy.
 */
test("a round that posted what it salvaged is still a failed round", async () => {
  const ran = await runInFixture({
    config: { timeout: 1, rounds: 1 },
    answers: POSTING,
    reviewer: hangs(ANSWER_COST, { findings: [finding("The flag is never read")] }),
  });

  assert.equal(
    ran.conclusion.outcome,
    "failed",
    "a round that posted its findings and reported itself reviewed is worse than one that posted none",
  );
  assert.ok(ran.conclusion.outcome === "failed");
  assert.equal(ran.conclusion.failure, "timed-out");
});

test("the verdicts a failed round reported are applied, and no other thread is touched", async () => {
  const ran = await runInFixture({
    config: { timeout: 1 },
    rounds: [ANSWER_COST],
    answers: {
      prlist: PR_LIST,
      diff: DIFF,
      threads: listed([
        { id: "PRRT_one", isResolved: false },
        { id: "PRRT_two", isResolved: true },
      ]),
      resolve: RESOLVED,
      unresolve: REOPENED,
    },
    reviewer: hangs(ANSWER_COST, { verdicts: [{ thread: "PRRT_one", verdict: "fixed" }] }),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.equal(ran.conclusion.failure, "timed-out");
  assert.deepEqual(
    ran.kinds,
    ["prlist", "threads", "diff", "resolve"],
    "the closed thread the reviewer never ruled on was re-opened, which reads a review that stopped early as a ruling that it is still wrong",
  );
  assert.deepEqual(
    ran.conclusion.salvaged?.verdicts.threads.map((applied) => applied.thread),
    ["PRRT_one"],
  );
});

test("a round that reported nothing before it failed posts nothing and makes no call", async () => {
  const ran = await runInFixture({
    config: { timeout: 1 },
    // Round 2, so a thread was handed over for a verdict the reviewer never gave.
    rounds: [ANSWER_COST],
    answers: {
      ...POSTING,
      threads: listed([{ id: "PRRT_two", isResolved: true }]),
      unresolve: REOPENED,
    },
    reviewer: hangs(ANSWER_COST),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.equal(ran.conclusion.failure, "timed-out");
  assert.equal(ran.conclusion.salvaged, undefined, "there was nothing for the round to salvage");
  assert.deepEqual(ran.kinds, ["prlist", "threads", "diff"]);
});

/**
 * The posting a failed round does runs on what is left of the one window, exactly
 * as a finished review's does.
 *
 * The reviewer here reports a finding, runs past its bound, and then ignores the
 * signal that would stop it, so the round spends the grace and the kill on the
 * far side of the moment the review had to be over by. A fresh margin taken here
 * would spend two more minutes past the end of the window, and what lies past the
 * window is the runtime killing the hook with nothing reported at all.
 */
test("a salvaged round posts on what is left of the window, not on a fresh margin", async () => {
  const ran = await runInFixture({
    windowMs: 3_000,
    marginMs: 500,
    config: { timeout: 2 },
    answers: POSTING,
    reviewer: reportsThenHolds(ANSWER_COST, [finding("The flag is never read")]),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.equal(ran.conclusion.failure, "timed-out");
  assert.deepEqual(
    ran.kinds.filter((kind) => kind === "create"),
    [],
    "a call made past the end of the window is one the runtime kills the hook during",
  );
  const outcome = ran.conclusion.salvaged?.findings.outcomes[0];
  assert.equal(outcome?.outcome, "failed", "a round that could not post is never a clean round");
  assert.match(
    outcome?.outcome === "failed" ? outcome.reason : "",
    /ran out before this call was made/u,
    "the window was gone before the posting started, and the round says so rather than reporting a comment it never wrote",
  );
});

test("a branch with no pull request runs nothing and says nothing", async () => {
  const ran = await runInFixture({
    answers: { prlist: "[]" },
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.deepEqual(ran.conclusion, { outcome: "no-pull-request" });
  assert.deepEqual(ran.kinds, ["prlist"]);
  assert.equal(ran.invocations.length, 0);
  assert.equal(ran.stateSource, null);
});

test("a detached HEAD is no branch, so the round ends before gh is asked", async () => {
  const ran = await runInFixture({
    detached: true,
    answers: { prlist: PR_LIST },
    reviewer: reviews({}),
  });

  assert.deepEqual(ran.conclusion, { outcome: "no-pull-request" });
  assert.deepEqual(ran.kinds, []);
});

test("a gh that could not answer the gate is a failure the round names", async () => {
  const ran = await runInFixture({
    answers: {},
    reviewer: reviews({}),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.equal(ran.conclusion.failure, "harness");
  assert.match(ran.conclusion.reason, /the pull request for "review-me" could not be looked up/u);
  assert.equal(ran.invocations.length, 0);
});

test("a state file that will not read back stops the round before the reviewer runs", async () => {
  const ran = await runInFixture({
    stateSource: "{ this is not json",
    answers: POSTING,
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.equal(ran.conclusion.failure, "harness");
  assert.match(ran.conclusion.reason, /is not valid JSON/u);
  assert.equal(
    ran.invocations.length,
    0,
    "the round count is what bounds the loop, and a round that reviewed on a count it could not read would start the count again every firing",
  );
});

test("threads that could not be listed end the round with nothing posted", async () => {
  const ran = await runInFixture({
    rounds: [ANSWER_COST],
    answers: { prlist: PR_LIST, diff: DIFF, create: CREATED, lookup: LOOKUP },
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.equal(ran.conclusion.failure, "harness");
  assert.match(ran.conclusion.reason, /the threads on PR #142 could not be listed/u);
  assert.deepEqual(ran.kinds, ["prlist", "threads"]);
  assert.equal(ran.invocations.length, 0);
});

test("a diff that could not be fetched ends the round before the reviewer runs", async () => {
  const ran = await runInFixture({
    answers: { prlist: PR_LIST },
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.equal(ran.conclusion.failure, "harness");
  assert.match(ran.conclusion.reason, /the diff of PR #142 could not be fetched/u);
  assert.equal(ran.invocations.length, 0);
});

test("a finding that could not be posted is reported and does not read as clean", async () => {
  const ran = await runInFixture({
    answers: { prlist: PR_LIST, diff: DIFF },
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.ok(ran.conclusion.outcome === "close");
  assert.deepEqual(ran.conclusion.posted, []);
  assert.equal(ran.conclusion.findings.outcomes.length, 1);
  assert.equal(ran.conclusion.findings.outcomes[0]?.outcome, "failed");
});

test("the posting margin bounds every call the round makes after the review", async () => {
  const ran = await runInFixture({
    marginMs: 2,
    answers: POSTING,
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.ok(ran.conclusion.outcome === "close");
  const outcome = ran.conclusion.findings.outcomes[0];
  assert.equal(outcome?.outcome, "failed");
  assert.match(
    outcome?.outcome === "failed" ? outcome.reason : "",
    /did not answer within/u,
    "a round that kept posting past the margin would be killed by the runtime with nothing reported at all",
  );
});

/**
 * The window is one moment the whole round is measured against, not an allowance
 * each phase is handed when it starts.
 *
 * The reviewer answers inside its bound and the round then spends the grace and
 * the kill stopping it, which lands past the moment the review had to be over by.
 * A posting margin that began afresh there would spend those two minutes on the
 * far side of the window, and what lies on the far side of the window is the
 * runtime killing the hook with nothing posted and the subagent recorded failed.
 */
test("a review that returned late leaves the posting what is left of the window, not a fresh margin", async () => {
  const ran = await runInFixture({
    // A window the reviewer's own cleanup is longer than what is left of, so the
    // round reaches the posting with the window already gone.
    windowMs: 2_000,
    marginMs: 500,
    answers: POSTING,
    reviewer: answersThenHolds([finding("The flag is never read")]),
  });

  assert.ok(ran.conclusion.outcome === "close");
  const outcome = ran.conclusion.findings.outcomes[0];
  assert.equal(outcome?.outcome, "failed", "a round that could not post is never a clean round");
  assert.match(
    outcome?.outcome === "failed" ? outcome.reason : "",
    /ran out before this call was made/u,
    "the window was gone before the posting started, and the round says so rather than reporting a comment it never wrote",
  );
  assert.deepEqual(
    ran.kinds.filter((kind) => kind === "create"),
    [],
    "a call made past the end of the window is one the runtime kills the hook during",
  );
});

/** How many pages the threads listing is offered before it must stop itself. */
const OFFERED_PAGES = 30;

/**
 * The calls before the review are bounded as a phase rather than one at a time.
 *
 * The listing pages, so the phase makes a number of calls nobody knows in
 * advance, and a bound per call lets every one of them have the whole of one. A
 * phase that spends the window leaves nothing for the review it exists to set up.
 */
test("the calls before the review share one deadline, and the phase ends inside it", async () => {
  const ran = await runInFixture({
    windowMs: 1_000,
    marginMs: 1,
    delays: { prlist: "0.2", threads: "0.5", diff: "0.5" },
    // A round the listing runs for, which is every round after the first.
    rounds: [ANSWER_COST],
    answers: { ...POSTING, threads: listed([]) },
    sequences: {
      threads: Array.from({ length: OFFERED_PAGES }, (_, at) => listedPage(`cursor-${at + 1}`)),
    },
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.equal(ran.conclusion.failure, "harness");
  assert.match(ran.conclusion.reason, /^no review ran:/u);
  assert.match(ran.conclusion.reason, /could not be reached|ran out/u);
  assert.equal(ran.invocations.length, 0, "a phase that ran out of time starts no reviewer");
  assert.deepEqual(
    ran.kinds.filter((kind) => kind === "diff"),
    [],
    "a call with nothing left on the deadline is not made at all",
  );
  const pages = ran.kinds.filter((kind) => kind === "threads").length;
  assert.ok(
    pages < OFFERED_PAGES,
    `the listing took all ${pages} pages it was offered, so each call was bounded and none of them together`,
  );
  // Far above the deadline and far below what the same calls cost bounded one at
  // a time, which is 15 seconds of listing alone. A tight wall-clock budget here
  // passes alone and fails under a suite running its files at once.
  assert.ok(
    ran.elapsedMs < 8_000,
    `the round took ${ran.elapsedMs}ms, which is a phase spending its calls' bounds one after another`,
  );
});

/**
 * The gate is the round's quietest exit: no pull request means exit 0 with
 * nothing posted and nothing said. A lookup the deadline stopped must not reach
 * it, or a round decides in silence that there was nothing to review.
 */
test("a pull request lookup that ran out of time fails the round rather than reading as no pull request", async () => {
  const ran = await runInFixture({
    windowMs: 1,
    answers: POSTING,
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.equal(ran.conclusion.failure, "harness");
  assert.match(ran.conclusion.reason, /the pull request for "review-me" could not be looked up/u);
  assert.equal(ran.invocations.length, 0);
});

test("what the calls before the review spend comes off the reviewer's own bound", async () => {
  // The three shares add up to the ceiling only if the review gives back what
  // the calls before it took. A reviewer still running at the ceiling is killed
  // by the runtime, which posts nothing and fails the coding agent's subagent.
  const ran = await runInFixture({
    windowMs: 3_000,
    marginMs: 1_000,
    config: { timeout: 5 },
    answers: POSTING,
    reviewer: hangs(ANSWER_COST),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.equal(ran.conclusion.failure, "timed-out");
  const bound = /killed at its (\d+)-second bound/u.exec(ran.conclusion.reason)?.[1];
  assert.ok(
    bound !== undefined && Number(bound) < 5,
    `the reviewer was given ${bound ?? "no"} seconds, which is the whole of what the project configured`,
  );
});

/**
 * One page of the read-back after a create, naming a thread this comment did not
 * open and claiming another page follows.
 */
function paging(cursor: string): string {
  return included(
    "200 OK",
    JSON.stringify({
      data: {
        node: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: true, endCursor: cursor },
              nodes: [{ id: "PRRT_other", comments: { nodes: [{ databaseId: 7 }] } }],
            },
          },
        },
      },
    }),
  );
}

test("a cap already spent closes the episode before a reviewer is started", async () => {
  const ran = await runInFixture({
    config: { rounds: 3 },
    // Three rounds recorded and the episode firing again, which is what an
    // interruption after a round recorded its cost leaves behind.
    rounds: [ANSWER_COST, ANSWER_COST, ANSWER_COST],
    answers: POSTING,
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.ok(ran.conclusion.outcome === "close");
  assert.equal(ran.conclusion.because, "round-cap");
  assert.equal(
    ran.invocations.length,
    0,
    "a cap read only after the reviewer has run is not a bound: it bills for the round it was there to stop",
  );
  assert.deepEqual(ran.kinds, ["prlist"]);
  assert.equal(ran.state?.rounds.length, 3, "and no fourth round is appended to the count");
});

test("an exhausted cap whose last recorded round failed closes the episode too", async () => {
  const killed: RoundCost = { dollars: 0, tokens: 0, messages: 0 };
  const ran = await runInFixture({
    config: { rounds: 2 },
    rounds: [ANSWER_COST, killed],
    answers: POSTING,
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.ok(ran.conclusion.outcome === "close");
  assert.equal(ran.conclusion.because, "round-cap");
  assert.equal(
    ran.invocations.length,
    0,
    "a round the reviewer failed is a round that ran, and it counts against the cap like any other",
  );
});

test("a recorded round that reached the token bound closes the episode before a reviewer is started", async () => {
  const ran = await runInFixture({
    config: { rounds: 8, tokens: 400_000 },
    rounds: [ANSWER_COST, { dollars: 0.5, tokens: 400_000, messages: 40 }],
    answers: POSTING,
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.ok(ran.conclusion.outcome === "close");
  assert.equal(ran.conclusion.because, "token-bound");
  assert.equal(ran.invocations.length, 0, "the bound stops the next round, so it is read before it");
});

// A model no price catalogue covers reports its tokens against no dollars, which
// is the configuration a dollar bound could not see at all.
test("a round priced at nothing is bounded by its tokens all the same", async () => {
  const unpriced: RoundCost = { dollars: 0, tokens: 400_000, messages: 40 };
  const ran = await runInFixture({
    config: { rounds: 8, tokens: 400_000 },
    rounds: [unpriced],
    answers: POSTING,
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.ok(ran.conclusion.outcome === "close");
  assert.equal(ran.conclusion.because, "token-bound");
  assert.equal(ran.invocations.length, 0);
});

test("a read-back that pages is stopped by the margin, not by its own page limit", async () => {
  const ran = await runInFixture({
    marginMs: 500,
    delays: { lookup: "0.1" },
    answers: { ...POSTING, lookup: paging("cursor-spare") },
    // Nineteen pages that name no thread, and a twentieth that names it. A
    // read-back that runs to its own page limit reaches the twentieth.
    sequences: {
      lookup: [...Array.from({ length: 19 }, (_, at) => paging(`cursor-${at + 1}`)), LOOKUP],
    },
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  const lookups = ran.kinds.filter((kind) => kind === "lookup").length;
  assert.ok(
    lookups < 20,
    `the read-back made all ${lookups} of its pages, so the margin bounded each request and none of them together`,
  );
  assert.ok(ran.conclusion.outcome === "close");
  const outcome = ran.conclusion.findings.outcomes[0];
  assert.equal(
    outcome?.outcome,
    "threaded",
    "the create completed, and an outcome already completed is kept when the margin runs out",
  );
  assert.equal(
    outcome?.outcome === "threaded" ? outcome.threadId : "unread",
    null,
    "the pages that would have named the thread were past the margin, so nothing can be addressed to it",
  );
});


/**
 * A paid attempt whose round ended as a setup problem: what it spent is kept
 * even though the round is not, and the next invocation is refused by the bound
 * those tokens reach.
 *
 * The exemption is about the round cap, which a setup problem must not spend. It
 * is not about the tokens, which are spent whatever the attempt came to.
 */
test("a paid attempt that ended as a setup problem is what stops the next round", async () => {
  const paid: RoundCost = { dollars: 0.04, tokens: 410_000, messages: 1 };
  const bounds = { rounds: 8, tokens: 400_000 };

  const first = await runInFixture({
    config: bounds,
    answers: { prlist: PR_LIST, diff: DIFF, threads: listed([]) },
    reviewer: attempts(
      { cost: paid, result: { kind: "unparsed", reason: "the last message was not a review" } },
      { cost: unspent, result: { kind: "incomplete", reason: "503 from the provider" } },
    ),
  });

  assert.ok(first.conclusion.outcome === "failed");
  assert.equal(first.conclusion.failure, "setup");
  assert.deepEqual(first.state?.rounds, [], "the setup problem spends no round");
  assert.deepEqual(
    first.state?.spentOutsideRounds,
    paid,
    "the attempt completed a paid response before it failed, and those tokens are spent",
  );

  // The next firing of the same episode, against the state the first one left.
  const next = await runInFixture({
    config: bounds,
    rounds: first.state?.rounds ?? [],
    ...(first.state === null ? {} : { outsideRounds: first.state.spentOutsideRounds }),
    answers: POSTING,
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.ok(next.conclusion.outcome === "close");
  assert.equal(next.conclusion.because, "token-bound");
  assert.equal(
    next.invocations.length,
    0,
    "410,000 tokens against a 400,000-token bound buys no further reviewer, and forgetting them is what buys a reviewer that burned the bound and reported nothing another try at it",
  );
});
