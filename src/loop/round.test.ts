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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { defaultConfig, type Config } from "../config/config.ts";
import type { Finding } from "../findings/finding.ts";
import type {
  Adapter,
  Invocation,
  ParsedRun,
  RoundCost,
  ThreadVerdict,
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
  readonly reviewer: Reviewer;
  readonly config?: Partial<Config>;
  /** Rounds already recorded, which is what makes the round a later one. */
  readonly rounds?: readonly RoundCost[];
  /** A state file written as it stands, for a file the round cannot read. */
  readonly stateSource?: string;
  readonly marginMs?: number;
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

/** A reviewer that reports a cost and then never finishes, so the bound kills it. */
function hangs(cost: RoundCost): Reviewer {
  return {
    command: "/bin/sh",
    args: ["-c", "sleep 30"],
    parse: async (_stdout, costSoFar): Promise<ParsedRun> => {
      costSoFar?.(cost);
      // The round races the bound against this, and stops the process instead.
      await new Promise<never>(() => {});
      throw new Error("the round read a parse that never finished");
    },
  };
}

/** A reviewer whose output cannot be read as a review, however often it is run. */
function unreadable(cost: RoundCost): Reviewer {
  return {
    parse: async (stdout): Promise<ParsedRun> => {
      await drain(stdout);
      return { cost, result: { kind: "unparsed", reason: "the last message was not a review" } };
    },
  };
}

/** A reviewer that ran, exited cleanly and completed no message. */
function completesNothing(cost: RoundCost): Reviewer {
  return {
    parse: async (stdout): Promise<ParsedRun> => {
      await drain(stdout);
      return { cost, result: { kind: "incomplete", reason: "the model refused the request" } };
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
    await writeFake(binaries, setup.answers);
    process.env["PATH"] = `${binaries}:${previous ?? ""}`;

    const episode = episodeAt(worktree, AGENT_ID);
    if (setup.rounds !== undefined) {
      const written = writeState(episode, { pullRequest: PULL_REQUEST, rounds: setup.rounds });
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

    const conclusion = await runRound({
      episode,
      config: { ...defaultConfig, timeout: 5, ...setup.config },
      adapter,
      charterFile,
      ...(setup.marginMs === undefined ? {} : { marginMs: setup.marginMs }),
    });

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
    };
  } finally {
    if (previous === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previous;
    await rm(root, { recursive: true, force: true });
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
async function writeFake(directory: string, answers: Answers): Promise<void> {
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
    'if [ ! -f "$dir/answer-$kind" ]; then',
    '  printf \'no answer fixtured for %s\\n\' "$kind" >&2',
    "  exit 1",
    "fi",
    'cat "$dir/answer-$kind"',
    "exit 0",
    "",
  ].join("\n");

  await writeFile(join(directory, "gh"), script, "utf8");
  await chmod(join(directory, "gh"), 0o755);
  for (const [kind, answer] of Object.entries(answers)) {
    await writeFile(join(directory, `answer-${kind}`), answer, "utf8");
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

  assert.deepEqual(ran.state, { pullRequest: PULL_REQUEST, rounds: [ANSWER_COST] });
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
  assert.equal(ran.state?.rounds.length, 1);
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

test("a budget already spent closes the episode", async () => {
  const ran = await runInFixture({
    config: { budget: 0.5 },
    rounds: [{ dollars: 0.49, tokens: 9000, messages: 20 }],
    answers: {
      prlist: PR_LIST,
      diff: DIFF,
      threads: listed([{ id: "PRRT_one", isResolved: false }]),
      unresolve: REOPENED,
    },
    reviewer: reviews({ verdicts: [{ thread: "PRRT_one", verdict: "open" }] }),
  });

  assert.ok(ran.conclusion.outcome === "close");
  assert.equal(ran.conclusion.because, "cost-bound");
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
    { pullRequest: PULL_REQUEST, rounds: [floor] },
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

test("a reviewer that completed no message is reported as a setup problem", async () => {
  const spent: RoundCost = { dollars: 0.005, tokens: 90, messages: 1 };
  const ran = await runInFixture({
    answers: POSTING,
    reviewer: completesNothing(spent),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.equal(ran.conclusion.failure, "setup");
  assert.match(ran.conclusion.reason, /the model refused the request/u);
  assert.deepEqual(ran.state?.rounds, [spent]);
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
