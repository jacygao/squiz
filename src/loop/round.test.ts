/**
 * A round is driven end to end, against a real git work tree, a `gh` on `PATH`
 * and a reviewer process the round starts itself.
 *
 * The failure these are arranged around is a round the reviewer failed reading
 * as a round that found nothing, so every reviewer outcome is exercised beside
 * an honest empty review and the two are asserted to be different conclusions.
 *
 * Which calls a round makes is part of what it does: every round lists the
 * threads once, and a round that ended before the review must post nothing. The
 * fake `gh` records the kind of every call for that reason.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { defaultConfig, type Config } from "../config/config.ts";
import { renderComment } from "../findings/comment.ts";
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
import { deadlineIn } from "../reviewers/deadline.ts";
import { standIn } from "../testing/stand-in.ts";
import { readState, writeState, type EpisodeState } from "./episode-state.ts";
import { episodeAt } from "./episode.ts";
import type { EpisodeSummary } from "./post-summary.ts";
import { reviewSeconds, runRound, type RoundConclusion } from "./round.ts";
import { HOOK_CEILING_MS, POSTING_MARGIN_MS } from "./window.ts";

const BRANCH = "review-me";
const PULL_REQUEST = 142;
const HEAD_SHA = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";

/** The subagent id the episode keys on, which is hexadecimal as every real one is. */
const AGENT_ID = "ab12cd34";

/** A second episode's id, for the worktree a round does not have to itself. */
const OTHER_AGENT_ID = "ef56ab78";

/** The file under review, tracked and committed, which is what a reviewer's write shows up in. */
const TRACKED = "src/ui/card.ts";

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
type Kind =
  | "prlist"
  | "diff"
  | "threads"
  | "create"
  | "lookup"
  | "resolve"
  | "unresolve"
  | "summary";

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
  /** Whether a firing of the episode has already reported its close. */
  readonly closeReported?: boolean;
  /**
   * A kind of call after which the episode's directory takes no more writes, for
   * a state file the round can read and cannot write. It is the round's own later
   * writes that fail, and the ones before that call have already landed.
   */
  readonly lockStateAfter?: Kind;
  /** A state file written as it stands, for a file the round cannot read. */
  readonly stateSource?: string;
  /** An episode of the same worktree that has run a round and not closed. */
  readonly sharedWith?: string;
  /**
   * A directory where the round's marker goes, so that marking the round fails
   * and every other write the round makes lands.
   */
  readonly blockMarker?: boolean;
  readonly marginMs?: number;
  readonly windowMs?: number;
  readonly detached?: boolean;
  /**
   * The rounds after the first, in order.
   *
   * Each runs against the worktree the round before it left behind and reads the
   * state file that round wrote, so what one round hands the next is what a
   * fixture of several drives. A fixture of one round cannot reach a handover at
   * all: whatever it supplies the composer is what the composer renders.
   */
  readonly andThen?: readonly Later[];
};

/** One round after the first: what happened before it, and the reviewer it runs. */
type Later = {
  /** The coding agent's turn, and anything else that happened between the rounds. */
  readonly before?: (worktree: string) => void;
  readonly reviewer: Reviewer;
};

/** One call to `gh`, as the fake took it. */
type Call = {
  readonly kind: Kind;
  /** The arguments as one line, which is where the method and the path are. */
  readonly argv: string;
  /** What the round wrote to `gh`'s stdin, empty where it sent no body. */
  readonly body: string;
};

/** Everything the rounds left behind, read before the fixture is removed. */
type Ran = {
  /** What the last round concluded, which is the only round a fixture of one ran. */
  readonly conclusion: RoundConclusion;
  /** What each round concluded, in the order the rounds ran. */
  readonly conclusions: readonly RoundConclusion[];
  /** The kind of each `gh` call, in the order the round made them. */
  readonly kinds: readonly Kind[];
  /** Every call in the order the round made them, with what it sent. */
  readonly calls: readonly Call[];
  /** What the reviewer was handed, one entry per process the round started. */
  readonly invocations: readonly Invocation[];
  /** Whether both directories the reviewer writes into existed when it started. */
  readonly directoriesReady: readonly boolean[];
  /** Whether the round was marked as running when each reviewer process started. */
  readonly markedWhenStarted: readonly boolean[];
  /** Whether the marker naming this round was still there once the round ended. */
  readonly markerLeft: boolean;
  /**
   * Whether the round's own space was still there once the round had ended, or
   * `null` where the round was handed none.
   */
  readonly roundSpaceLeft: boolean | null;
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
        refusals: 0,
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
      progressSoFar?.({
        cost,
        findings,
        verdicts: [],
        refusals: 0,
        finished: false,
        broken: undefined,
      });
      await drain(stdout);
      return { cost, result: { kind: "unparsed", reason: "the last message was not a review" } };
    },
  };
}

/** A reviewer that ran, exited cleanly and completed no message. */
function completesNothing(cost: RoundCost, findings: readonly Finding[] = []): Reviewer {
  return {
    parse: async (stdout, progressSoFar): Promise<ParsedRun> => {
      progressSoFar?.({
        cost,
        findings,
        verdicts: [],
        refusals: 0,
        finished: false,
        broken: undefined,
      });
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

/** A reviewer that wrote to the file under review through its shell, and reviewed. */
function writesThenReviews(findings: readonly Finding[] = []): Reviewer {
  return {
    command: "/bin/sh",
    args: ["-c", `printf '// line 2\\n' >> ${TRACKED}`],
    parse: reviews({ findings }).parse,
  };
}

/**
 * A reviewer that wrote to the file under review and then never finished, so the
 * bound kills it.
 *
 * The write a killed reviewer left behind is the one the comparison exists for.
 */
function writesThenHangs(cost: RoundCost): Reviewer {
  return {
    command: "/bin/sh",
    args: ["-c", `printf '// line 2\\n' >> ${TRACKED}; sleep 30`],
    parse: hangs(cost).parse,
  };
}

/**
 * A reviewer that wrote to the file under review and then took the write
 * permission off the episode's directory, so the round cannot record what it
 * spent.
 */
function writesThenLocksTheState(): Reviewer {
  return {
    command: "/bin/sh",
    args: ["-c", `printf '// line 2\\n' >> ${TRACKED}; chmod 500 .squiz/${AGENT_ID}`],
    parse: reviews({}).parse,
  };
}

/** A reviewer that corrupted git's index, so the reading after it cannot be taken. */
function breaksGit(): Reviewer {
  return {
    command: "/bin/sh",
    args: ["-c", "printf 'not an index' > .git/index"],
    parse: reviews({}).parse,
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
 * Run the fixture's rounds against one worktree, and hand back everything they
 * left behind.
 *
 * A real git work tree and a real `gh` on `PATH`: the gate asks git which branch
 * is checked out and `gh` which pull request has it as a head, and a round that
 * reached neither would still pass against injected answers.
 *
 * The rounds run in order against the same episode, so a `gh` answer served in
 * sequence is served to the round that asks for it next.
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
    // `.squiz/` is gitignored, as it is in a project the harness is installed in,
    // so the episode's own directory is not read as something the reviewer wrote.
    await writeFile(join(worktree, ".gitignore"), ".squiz/\n", "utf8");
    await mkdir(join(worktree, "src", "ui"), { recursive: true });
    await writeFile(join(worktree, TRACKED), "// line 1\n", "utf8");
    git(worktree, ["add", "."]);
    git(worktree, ["commit", "--quiet", "--message", "the change under review"]);
    if (setup.detached === true) git(worktree, ["checkout", "--quiet", "--detach", "HEAD"]);

    const episode = episodeAt(worktree, AGENT_ID);
    const charterFile = join(root, "charter.md");
    await writeFile(charterFile, "What a good review is.\n", "utf8");
    await writeFake(binaries, setup.answers, setup.sequences ?? {}, setup.delays ?? {}, {
      ...(setup.lockStateAfter === undefined
        ? {}
        : { [setup.lockStateAfter]: episode.directory }),
    });
    process.env["PATH"] = `${binaries}:${previous ?? ""}`;

    if (setup.rounds !== undefined) {
      const written = writeState(episode, {
        rounds: setup.rounds,
        spentOutsideRounds: setup.outsideRounds ?? unspent,
        ...(setup.closeReported === undefined ? {} : { closeReported: setup.closeReported }),
      });
      assert.equal(written.outcome, "written", "the fixture's own state file must be written");
    }
    if (setup.stateSource !== undefined) {
      mkdirSync(episode.directory, { recursive: true });
      writeFileSync(episode.stateFile, setup.stateSource, "utf8");
    }
    if (setup.sharedWith !== undefined) {
      const written = writeState(episodeAt(worktree, setup.sharedWith), {
        rounds: [ANSWER_COST],
        spentOutsideRounds: unspent,
      });
      assert.equal(written.outcome, "written", "the other episode's own state must be written");
    }
    const marker = join(episode.directory, "running.json");
    if (setup.blockMarker === true) mkdirSync(join(marker, "occupied"), { recursive: true });

    const invocations: Invocation[] = [];
    const directoriesReady: boolean[] = [];
    const markedWhenStarted: boolean[] = [];
    const laterRounds = setup.andThen ?? [];
    const reviewers = [setup.reviewer, ...laterRounds.map((later) => later.reviewer)];
    // Which round is running, which is what says whose reviewer the adapter starts.
    // One round can start more than one process, so the index is the round's rather
    // than the process's.
    let running = 0;
    const current = (): Reviewer => reviewers[running] ?? setup.reviewer;
    const adapter: Adapter = {
      confine: () => ({ outcome: "prepared", environment: {} }),
      argv: (invocation) => {
        invocations.push(invocation);
        // Read here rather than after the round: the reviewer is told to write
        // into both, and both have to be there before its process starts.
        directoriesReady.push(
          existsSync(invocation.sessionDirectory) && existsSync(invocation.scratchDirectory),
        );
        // The round is marked before the reading it takes here, so a reviewer that
        // starts unmarked is a round no other episode in this worktree can find.
        markedWhenStarted.push(existsSync(marker));
        return {
          command: current().command ?? "/bin/sh",
          args: [...(current().args ?? ["-c", "exit 0"])],
          directory: invocation.directory,
        };
      },
      parse: (stdout, progressSoFar) => current().parse(stdout, progressSoFar),
      grants: { read: ["read"], deep: ["read", "bash"] },
    };

    const conclusions: RoundConclusion[] = [];
    const started = Date.now();
    for (running = 0; running < reviewers.length; running += 1) {
      laterRounds[running - 1]?.before?.(worktree);
      conclusions.push(
        await runRound({
          episode,
          config: { ...defaultConfig, timeout: 5, ...setup.config },
          adapter,
          charterFile,
          ...(setup.marginMs === undefined ? {} : { marginMs: setup.marginMs }),
          ...(setup.windowMs === undefined ? {} : { windowMs: setup.windowMs }),
        }),
      );
    }
    const elapsedMs = Date.now() - started;

    const stateSource = existsSync(episode.stateFile)
      ? readFileSync(episode.stateFile, "utf8")
      : null;
    const kinds = lines(join(binaries, "kinds")) as readonly Kind[];
    return {
      conclusion: conclusions.at(-1) ?? assert.fail("the fixture ran no round at all"),
      conclusions,
      kinds,
      calls: kinds.map((kind, at) => ({
        kind,
        argv: (lines(join(binaries, `argv-${at + 1}`))[0] ?? "").trim(),
        body: contents(join(binaries, `stdin-${at + 1}`)),
      })),
      invocations,
      directoriesReady,
      markedWhenStarted,
      markerLeft: existsSync(marker),
      roundSpaceLeft: spaceLeft(invocations),
      state: stateIn(stateSource),
      stateSource,
      elapsedMs,
    };
  } finally {
    if (previous === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previous;
    // A directory a test locked takes no writes, and removing what is under it is
    // one, so the permission goes back before the fixture is removed.
    unlock(join(worktree, ".squiz"));
    await rm(root, { recursive: true, force: true });
  }
}

/** Whether the space the round made for itself outlived the round. */
function spaceLeft(invocations: readonly Invocation[]): boolean | null {
  const space = invocations[0]?.roundSpace;
  return space === undefined ? null : existsSync(space.directory);
}

/** Let `directory` and everything under it be written again, where it is there. */
function unlock(directory: string): void {
  if (!existsSync(directory)) return;
  chmodSync(directory, 0o700);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) unlock(join(directory, entry.name));
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

/**
 * The state with each round cut down to what it spent.
 *
 * How long a reviewer ran is the clock's, so no fixture can name it in advance.
 * The bound that cut a round short stays out too, and the tests about it read it
 * off the state itself.
 */
function untimed(state: EpisodeState | null): EpisodeState | null {
  if (state === null) return null;
  return {
    ...state,
    rounds: state.rounds.map(({ dollars, tokens, messages }) => ({ dollars, tokens, messages })),
  };
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
  locks: Partial<Record<Kind, string>>,
): Promise<void> {
  standIn(directory, "gh", GH_SCRIPT);
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
  for (const [kind, locked] of Object.entries(locks)) {
    await writeFile(join(directory, `lock-${kind}`), locked, "utf8");
  }
}

/** The fake `gh`, which keeps its answers and its records beside itself. */
const GH_SCRIPT = [
  "#!/bin/sh",
  'dir="${0%/*}"',
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
  // Before the create, which is the other POST. The summary goes to the issues
  // path and a finding's thread to the pulls path, and those two paths are the
  // whole of the difference between a comment on the pull request and a comment
  // on a line of its diff.
  "  *'/issues/'*'/comments'*) kind=summary ;;",
  "  *'--method POST'*) kind=create ;;",
  "  *'pr list'*) kind=prlist ;;",
  "  *'v3.diff'*) kind=diff ;;",
  "esac",
  'printf \'%s\\n\' "$kind" >> "$dir/kinds"',
  // The arguments of this one call, so a test can read the method and the path
  // a comment was sent to and not only that a call was made.
  'printf \'%s\\n\' "$*" > "$dir/argv-$n"',
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
  // After the answer, so the call itself succeeded and only what the round
  // writes afterwards fails.
  'if [ -f "$dir/lock-$kind" ]; then chmod 500 "$(cat "$dir/lock-$kind")"; fi',
  "exit 0",
  "",
].join("\n");

function lines(path: string): readonly string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

/** A file as it stands, or the empty string where there is none. */
function contents(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
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

/** The summary comment GitHub created: an issue comment, on no line of the diff. */
const SUMMARY_POSTED = included("201 Created", JSON.stringify({
  id: 2140876531,
  node_id: "IC_kwDOUEd2qM7q-4A7",
  html_url: `https://github.com/o/r/pull/${PULL_REQUEST}#issuecomment-2140876531`,
}));

/** One thread of the pull request as the listing reads it back. */
type Listed = {
  readonly id: string;
  readonly isResolved: boolean;
  /**
   * The comment that opened it, which is what says whose thread it is. The
   * reviewer's own finding by default.
   */
  readonly opening?: string;
};

/**
 * The comment a person left, carrying none of the markers.
 *
 * A thread opened by one of these is nobody's finding, so no round hands it to
 * the reviewer.
 */
const PERSON_WROTE = "Why does this need a card at all?";

/** One thread already on the pull request, as the listing reads it back. */
function listed(threads: readonly Listed[]): string {
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
                  {
                    id: `PRRC_of_${thread.id}`,
                    databaseId: 51,
                    author: { login: "squiz" },
                    body: thread.opening ?? renderComment(finding("The name says nothing.")),
                    createdAt: "2026-09-06T07:13:05Z",
                  },
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

/** The comment body `gh` was handed, or a failure naming what arrived instead. */
function sent(stdin: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdin);
  } catch {
    return assert.fail(`gh was handed what is not JSON: ${stdin}`);
  }
  assert.ok(
    typeof parsed === "object" && parsed !== null && "body" in parsed,
    `gh was handed no body: ${stdin}`,
  );
  const body: unknown = parsed.body;
  assert.equal(typeof body, "string", `the body gh was handed is not text: ${stdin}`);
  return String(body);
}

/** Why the episode has no summary comment, or the empty string where it has one. */
function summaryReason(summary: EpisodeSummary): string {
  switch (summary.outcome) {
    case "failed":
    case "never-composed":
      return summary.reason;
    case "posted":
      return "";
  }
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

/**
 * Everything a round that posts one finding needs answering.
 *
 * The threads listing is among them because every round makes it, the first
 * round of an episode included, and the summary because a round that closes the
 * episode posts one.
 */
const POSTING: Answers = {
  prlist: PR_LIST,
  diff: DIFF,
  threads: listed([]),
  create: CREATED,
  lookup: LOOKUP,
  summary: SUMMARY_POSTED,
};

test("the first round of a first episode posts its finding, is handed no thread, and blocks", async () => {
  const ran = await runInFixture({
    answers: POSTING,
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.deepEqual(
    ran.kinds,
    ["prlist", "threads", "diff", "create", "lookup"],
    "the listing is one call and the round makes it once: a pull request with no thread of the reviewer's is answered by asking, not by assuming",
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
    "a prompt that carried a threads section with nothing handed over would ask for a verdict on nothing",
  );
});

/**
 * The configured command reaches the prompt, and only where the reviewer has a
 * shell to run it with.
 *
 * The configuration is built here rather than loaded, so a round at `deep` runs
 * before the loader accepts that depth.
 */
test("the configured test command reaches a reviewer at `deep` and not one at `read`", async () => {
  const deep = await runInFixture({
    answers: POSTING,
    reviewer: reviews({}),
    config: { depth: "deep", test: "pnpm vitest run" },
  });
  const read = await runInFixture({
    answers: POSTING,
    reviewer: reviews({}),
    config: { depth: "read", test: "pnpm vitest run" },
  });

  assert.match(
    deep.invocations[0]?.prompt ?? "",
    /^pnpm vitest run$/mu,
    "the project's own command did not reach the reviewer, so it runs whatever it infers",
  );
  assert.equal(
    read.invocations[0]?.prompt.includes("pnpm vitest run"),
    false,
    "a reviewer with no shell was named a command to run the tests with",
  );
});

/**
 * Only `deep` grants a shell, and only a shell puts a tool in a group of its
 * own. At `read` there is nothing to record, so nothing is recorded and nothing
 * is read back: a record at `read` would have the round signalling numbers no
 * reviewer of that depth could have written.
 *
 * The record lives in the episode's directory, which is gitignored, so the
 * comparison of tracked files never reads it as a change. Its name is the
 * round's own and it goes when the round ends, so a later round can take neither
 * it nor what a killed round left behind for its own.
 */
test("a round at `deep` records its shells' groups, and one at `read` records nothing", async () => {
  const deep = await runInFixture({
    answers: POSTING,
    reviewer: reviews({}),
    config: { depth: "deep" },
  });
  const read = await runInFixture({ answers: POSTING, reviewer: reviews({}), config: {} });

  const space = deep.invocations[0]?.roundSpace;
  assert.ok(space !== undefined, "a reviewer with a shell was handed nowhere to record");
  assert.ok(
    space.shellRecord.startsWith(join(space.directory, "")),
    `the record is at ${space.shellRecord}, which is outside the round's own space`,
  );
  assert.match(space.directory, /\.squiz\//u, "the record is outside the episode's own directory");
  assert.equal(deep.roundSpaceLeft, false, "the round's own space outlived the round");
  assert.equal(read.invocations[0]?.roundSpace, undefined);
});

/**
 * A second coding agent on the same branch is a second episode, and its state
 * file is new while the pull request is not.
 *
 * No round is recorded here, so this is that episode's first round. The threads
 * the earlier episode left are still on the pull request, and a round handed none
 * of them raises every one of those findings again beside the old ones.
 */
test("a second episode's first round is handed the threads already on the pull request", async () => {
  const ran = await runInFixture({
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
  assert.ok(ran.conclusion.outcome === "block");
  assert.deepEqual(
    ran.conclusion.verdicts.threads.map((applied) => applied.thread),
    ["PRRT_one", "PRRT_two"],
    "every verdict still reached its thread, so no finding of the earlier episode is raised a second time",
  );
});

/**
 * A thread whose first comment carries no marker was written by a person, and the
 * loop leaves it alone.
 *
 * Nothing else is open here, so the episode closes over a thread that is. That is
 * the point: the thread is a conversation on the pull request rather than work of
 * this review, and a round that counted it would block the coding agent over a
 * comment nobody asked it to work.
 */
test("a person's thread is not handed over, and an episode closes with one still open", async () => {
  const ran = await runInFixture({
    rounds: [ANSWER_COST],
    answers: {
      prlist: PR_LIST,
      diff: DIFF,
      threads: listed([{ id: "PRRT_person", isResolved: false, opening: PERSON_WROTE }]),
      summary: SUMMARY_POSTED,
    },
    reviewer: reviews({}),
  });

  assert.deepEqual(
    ran.kinds,
    ["prlist", "threads", "diff", "summary"],
    "a person's thread was resolved or re-opened, so the reviewer's judgement was applied to a comment it was never shown",
  );
  assert.equal(
    ran.invocations[0]?.prompt.includes("PRRT_person"),
    false,
    "the reviewer was shown a person's thread and asked to rule on it",
  );
  assert.ok(ran.conclusion.outcome === "close");
  assert.equal(
    ran.conclusion.because,
    "nothing-open",
    "the person's thread was counted among the open threads, so the episode blocked over work this review does not have",
  );
  assert.deepEqual(ran.conclusion.verdicts.threads, []);
});

/**
 * A round that blocks over its own thread does not name a person's in the reason
 * it hands the coding agent.
 */
test("the blocking reason names no thread a person opened", async () => {
  const ran = await runInFixture({
    rounds: [ANSWER_COST],
    answers: {
      prlist: PR_LIST,
      diff: DIFF,
      threads: listed([
        { id: "PRRT_person", isResolved: false, opening: PERSON_WROTE },
        { id: "PRRT_ours", isResolved: false },
      ]),
    },
    reviewer: reviews({ verdicts: [{ thread: "PRRT_ours", verdict: "open" }] }),
  });

  assert.ok(ran.conclusion.outcome === "block");
  assert.match(ran.conclusion.reason, /1 thread is open on it:\nPRRT_ours/u);
  assert.equal(
    ran.conclusion.reason.includes("PRRT_person"),
    false,
    "the reason told the coding agent to work a person's comment as a finding of this review",
  );
});

/**
 * A verdict naming a thread the round did not hand over is reported rather than
 * dropped, and nothing is sent for it.
 *
 * The reviewer cannot name a person's thread from the prompt, which never carried
 * it. One that names it anyway is a reviewer inventing an identifier, and the
 * round says so instead of acting on it.
 */
test("a verdict naming a person's thread is reported unapplied and reaches nothing", async () => {
  const ran = await runInFixture({
    rounds: [ANSWER_COST],
    answers: {
      prlist: PR_LIST,
      diff: DIFF,
      threads: listed([{ id: "PRRT_person", isResolved: false, opening: PERSON_WROTE }]),
      resolve: RESOLVED,
      summary: SUMMARY_POSTED,
    },
    reviewer: reviews({ verdicts: [{ thread: "PRRT_person", verdict: "fixed" }] }),
  });

  assert.deepEqual(
    ran.kinds,
    ["prlist", "threads", "diff", "summary"],
    "the verdict closed a person's thread, which is the reviewer's judgement applied to a comment it was never handed",
  );
  assert.ok(ran.conclusion.outcome === "close");
  assert.deepEqual(ran.conclusion.verdicts.unapplied, [
    {
      thread: "PRRT_person",
      verdict: "fixed",
      reason: "no thread with that id was handed to the reviewer",
    },
  ]);
});

/**
 * The reviewer's own resolved threads are handed over, so a verdict can re-open
 * one.
 *
 * No round is recorded here, so a filter that kept only open threads and a round
 * that handed over nothing at all would both pass on a listing of open ones.
 */
test("a resolved thread of the reviewer's own is handed over, and a verdict re-opens it", async () => {
  const ran = await runInFixture({
    answers: {
      prlist: PR_LIST,
      diff: DIFF,
      threads: listed([{ id: "PRRT_closed", isResolved: true }]),
      unresolve: REOPENED,
    },
    reviewer: reviews({ verdicts: [{ thread: "PRRT_closed", verdict: "open" }] }),
  });

  assert.deepEqual(ran.kinds, ["prlist", "threads", "diff", "unresolve"]);
  assert.ok(ran.conclusion.outcome === "block");
  assert.match(ran.conclusion.reason, /1 thread is open on it:\nPRRT_closed/u);
});

test("the round's cost is recorded in the episode state with its token count", async () => {
  const ran = await runInFixture({
    answers: POSTING,
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.deepEqual(untimed(ran.state), {
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

test("a later round hands over the reviewer's threads with their state and applies the verdicts", async () => {
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
      summary: SUMMARY_POSTED,
    },
    reviewer: reviews({ verdicts: [{ thread: "PRRT_one", verdict: "fixed" }] }),
  });

  assert.ok(ran.conclusion.outcome === "close");
  assert.equal(ran.conclusion.because, "nothing-open");
});

/**
 * The one comment an episode posts, asserted as the whole body `gh` was handed.
 *
 * A test that asserted a call had been made would pass on an empty body, and the
 * comment is posted once and never edited, so whatever is wrong in it is
 * permanent for that episode.
 *
 * Every part of it comes from somewhere else: the round count and the spend from
 * the episode's state file, the location and the headline from the thread that was
 * listed before the review, the status from the verdict the reviewer returned, and
 * the note from the bound that closed the episode.
 */
test("a closing round posts one comment carrying the summary it composed", async () => {
  const ran = await runInFixture({
    config: { rounds: 2 },
    // One round recorded, so this round is the second and the last the cap allows.
    rounds: [ANSWER_COST],
    answers: {
      prlist: PR_LIST,
      diff: DIFF,
      threads: listed([{ id: "PRRT_open", isResolved: false }]),
      summary: SUMMARY_POSTED,
    },
    reviewer: reviews({ verdicts: [{ thread: "PRRT_open", verdict: "open" }] }),
  });

  assert.ok(ran.conclusion.outcome === "close");
  assert.equal(ran.conclusion.because, "round-cap");
  assert.deepEqual(ran.conclusion.summary, { outcome: "posted" });
  assert.deepEqual(ran.kinds, ["prlist", "threads", "diff", "summary"]);
  assert.equal(
    ran.state?.closeReported,
    true,
    "a later firing of this episode reads this to know the close was reported, and announces a missing summary where it is not there",
  );

  const posted = ran.calls.filter((call) => call.kind === "summary");
  assert.equal(posted.length, 1, "the comment is posted once, and nothing ever edits it");
  assert.equal(
    sent(posted[0]?.body ?? ""),
    [
      "**Squiz review — 2 rounds, 1 finding**",
      "",
      "Fixed 0 · Withdrawn 0 · Open 1 · Disputed 0",
      "2,400 tokens over 2 rounds: 1,200, 1,200 · $0.0800",
      "",
      "**Needs a person**",
      "",
      "- `src/ui/card.ts:88` — The name says nothing. (open)",
      "",
      "**Notes**",
      "",
      "- The episode ended at its round cap rather than with nothing left open",
    ].join("\n"),
  );
});

test("a round that blocks posts no summary", async () => {
  const ran = await runInFixture({
    answers: POSTING,
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.ok(ran.conclusion.outcome === "block");
  assert.deepEqual(
    ran.kinds.filter((kind) => kind === "summary"),
    [],
    "the summary is the episode's close, and one for every firing reports a review that is still going on",
  );
  assert.notEqual(
    ran.state?.closeReported,
    true,
    "a round that blocked reported no close, and a later firing that read this as one would close the episode in silence",
  );
});

/**
 * A summary that did not post leaves the close a close.
 *
 * A failed round would be the wrong answer twice over: the review finished and
 * the episode is over, and a round that failed over a comment it could not post
 * would be reported as a review that did not happen.
 */
test("a summary gh refused does not turn the close into a failed round", async () => {
  const ran = await runInFixture({
    rounds: [ANSWER_COST],
    // No summary answer, so the fake exits 1 exactly as a gh that could not post.
    answers: {
      prlist: PR_LIST,
      diff: DIFF,
      threads: listed([{ id: "PRRT_one", isResolved: false }]),
      resolve: RESOLVED,
    },
    reviewer: reviews({ verdicts: [{ thread: "PRRT_one", verdict: "fixed" }] }),
  });

  assert.equal(ran.conclusion.outcome, "close", "the episode closed, and the review finished");
  assert.ok(ran.conclusion.outcome === "close");
  assert.equal(ran.conclusion.because, "nothing-open");
  assert.equal(ran.conclusion.summary?.outcome, "failed");
  assert.match(
    summaryReason(ran.conclusion.summary),
    /gh exited 1/u,
    "the reason GitHub gave is what the failure pointer has to carry",
  );
  assert.deepEqual(ran.kinds, ["prlist", "threads", "diff", "resolve", "summary"]);
  assert.deepEqual(
    ran.conclusion.verdicts.threads.map((applied) => applied.outcome),
    ["closed"],
    "what the round put on the pull request stands, whatever became of the summary",
  );
});

/**
 * A round the reviewer failed posts no summary.
 *
 * The cap is 1 here, so a clean round of this shape would close the episode. The
 * round reached no decision about the episode, and counts taken from a review that
 * did not finish would read as counts from one that did.
 */
test("a round the reviewer failed posts no summary", async () => {
  const ran = await runInFixture({
    config: { timeout: 1, rounds: 1 },
    answers: POSTING,
    reviewer: hangs(ANSWER_COST, { findings: [finding("The flag is never read")] }),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.equal(ran.conclusion.failure, "timed-out");
  assert.deepEqual(
    ran.kinds.filter((kind) => kind === "summary"),
    [],
    "a failed round is reported on the hook's stderr, not as a summary of a review that did not finish",
  );
});

/**
 * Two episodes on one pull request each post their own comment, and neither
 * touches what is already there.
 *
 * A second coding agent on the same branch is a second episode: its state file is
 * new and the pull request is not. Posting is a create addressed to the pull
 * request's comment collection rather than to any comment of its own, so the
 * comments accumulate as the history of the review passes.
 */
test("a second episode on the same pull request posts a second comment and edits nothing", async () => {
  const answers: Answers = {
    prlist: PR_LIST,
    diff: DIFF,
    threads: listed([{ id: "PRRT_one", isResolved: false }]),
    resolve: RESOLVED,
    summary: SUMMARY_POSTED,
  };
  const reviewer = reviews({ verdicts: [{ thread: "PRRT_one", verdict: "fixed" }] });

  const first = await runInFixture({ rounds: [ANSWER_COST], answers, reviewer });
  const second = await runInFixture({ rounds: [ANSWER_COST], answers, reviewer });

  for (const [at, ran] of [first, second].entries()) {
    const episode = `episode ${at + 1}`;
    assert.ok(ran.conclusion.outcome === "close", `${episode} did not close`);
    assert.deepEqual(ran.conclusion.summary, { outcome: "posted" }, `${episode} posted no summary`);
    const posted = ran.calls.filter((call) => call.kind === "summary");
    assert.equal(posted.length, 1, `${episode} posted ${posted.length} comments`);
    assert.equal(
      posted[0]?.argv,
      `api --include --method POST repos/{owner}/{repo}/issues/${PULL_REQUEST}/comments --input -`,
      `${episode} posted somewhere other than the pull request's comment collection`,
    );
    assert.deepEqual(
      ran.calls.filter((call) => /--method (?:PATCH|PUT|DELETE)/u.test(call.argv)),
      [],
      `${episode} edited or removed a comment, and the first episode's own is permanent`,
    );
  }
});

test("an honest empty review is a clean round and not a failure", async () => {
  const ran = await runInFixture({
    answers: { prlist: PR_LIST, diff: DIFF, threads: listed([]), summary: SUMMARY_POSTED },
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
      summary: SUMMARY_POSTED,
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
    untimed(ran.state)?.rounds.at(-1),
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
  assert.deepEqual(
    ran.kinds,
    ["prlist", "threads", "diff"],
    "a round with no review posts nothing",
  );
  assert.deepEqual(
    untimed(ran.state),
    { rounds: [floor], spentOutsideRounds: unspent },
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
  assert.deepEqual(ran.kinds, ["prlist", "threads", "diff"]);
  assert.deepEqual(
    untimed(ran.state)?.rounds,
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
    assert.deepEqual(ran.kinds, ["prlist", "threads", "diff", "create", "lookup"]);
    assert.match(ran.conclusion.reason, /kept the 1 finding the reviewer had reported/u);
    assert.deepEqual(
      untimed(ran.state)?.rounds ?? [],
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

test("a branch with no pull request runs nothing, and names the branch and where it looked", async () => {
  const ran = await runInFixture({
    answers: { prlist: "[]" },
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.ok(ran.conclusion.outcome === "no-pull-request");
  assert.equal(ran.conclusion.branch, BRANCH);
  assert.match(ran.conclusion.directory, /\/tree$/u, "the worktree the gate asked git in");
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

  assert.ok(ran.conclusion.outcome === "no-pull-request");
  assert.equal(ran.conclusion.branch, null, "a detached HEAD names no branch");
  assert.match(ran.conclusion.directory, /\/tree$/u, "the worktree the gate asked git in");
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
    answers: { prlist: PR_LIST, threads: listed([]) },
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.equal(ran.conclusion.failure, "harness");
  assert.match(ran.conclusion.reason, /the diff of PR #142 could not be fetched/u);
  assert.equal(ran.invocations.length, 0);
});

test("a finding that could not be posted is reported and does not read as clean", async () => {
  const ran = await runInFixture({
    answers: { prlist: PR_LIST, diff: DIFF, threads: listed([]), summary: SUMMARY_POSTED },
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
 *
 * The summary is on the same terms as the findings. It is the last thing the round
 * would send, so it is the first thing a spent window costs.
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
    ran.kinds,
    ["prlist", "threads", "diff"],
    "a call made past the end of the window is one the runtime kills the hook during",
  );
  assert.match(
    summaryReason(ran.conclusion.summary),
    /ran out before this call was made/u,
    "the episode closed without its summary, and the round has to say so for the pointer to name it",
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

// The hook runs the round inside the ceiling, and a configured bound larger than
// what the window leaves would let the runtime cancel the hook with nothing posted.
test("a configured timeout longer than the hook's window still fits the reviewer inside it", () => {
  const reviewMs = HOOK_CEILING_MS - POSTING_MARGIN_MS;
  for (const configured of [defaultConfig.timeout, 900, 3_600]) {
    const seconds = reviewSeconds(configured, deadlineIn(reviewMs));
    assert.ok(
      seconds !== null && seconds * 1_000 <= reviewMs,
      `a timeout of ${configured} gave the reviewer ${seconds ?? "no"} seconds, past the ${reviewMs / 1_000} the hook's window leaves it`,
    );
  }
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
  assert.deepEqual(
    ran.kinds,
    ["prlist"],
    "a comment composed here would report an episode with none of its threads in hand as an episode that raised nothing",
  );
  // The state file this fixture wrote records no close, which is what an
  // interruption between the cost and the close leaves. The comment is missing
  // and the round says so.
  assert.equal(ran.conclusion.summary.outcome, "never-composed");
  assert.equal(ran.state?.rounds.length, 3, "and no fourth round is appended to the count");
});

/**
 * A cap lowered between firings closes an episode whose summary was never posted.
 *
 * The first firing reviews under a cap of 3, posts its finding and blocks, so
 * nothing has closed the episode and nothing has reported it. The cap is 1 by the
 * next firing, which finds the bound already spent: it starts no review, lists
 * none of the episode's threads and composes no comment. A close that said nothing
 * here would end the episode with findings on the pull request, no comment
 * reporting them, and exit 0 reading as a clean review.
 */
test("a cap lowered after a round blocked closes the episode with no summary, and says so", async () => {
  const blocked = await runInFixture({
    config: { rounds: 3 },
    answers: POSTING,
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.ok(blocked.conclusion.outcome === "block");
  assert.notEqual(
    blocked.state?.closeReported,
    true,
    "a round that blocked closed no episode, so it has reported no close",
  );

  const closed = await runInFixture({
    config: { rounds: 1 },
    rounds: blocked.state?.rounds ?? [],
    answers: POSTING,
    reviewer: reviews({}),
  });

  assert.ok(closed.conclusion.outcome === "close");
  assert.equal(closed.conclusion.because, "round-cap");
  assert.deepEqual(
    closed.kinds,
    ["prlist"],
    "no review ran here, so nothing was listed to compose a comment from and nothing was posted",
  );
  assert.equal(
    closed.conclusion.summary.outcome,
    "never-composed",
    "the episode closed with no summary anywhere, and a close that reports nothing reads as a clean review",
  );
  assert.match(
    summaryReason(closed.conclusion.summary),
    /1 round/u,
    "the line has to say the episode reviewed, or a person has no reason to go and read its threads",
  );
});

/**
 * An episode whose close was recorded is over, and a later firing of it reviews
 * nothing and posts nothing.
 *
 * The firings are chained: what the second reads is what the close wrote, rather
 * than a state the fixture arranged. A firing that reviewed here would spend a
 * round of a closed episode, raise its findings again and put a second comment on
 * one pull request.
 */
test("a firing after the episode reported its close reviews nothing and posts nothing", async () => {
  const closed = await runInFixture({
    config: { rounds: 1 },
    answers: POSTING,
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.ok(closed.conclusion.outcome === "close");
  assert.deepEqual(closed.conclusion.summary, { outcome: "posted" });

  const again = await runInFixture({
    config: { rounds: 1 },
    rounds: closed.state?.rounds ?? [],
    closeReported: closed.state?.closeReported,
    answers: POSTING,
    reviewer: reviews({}),
  });

  assert.deepEqual(again.conclusion, { outcome: "episode-over" });
  assert.deepEqual(again.kinds, [], "an episode that is over asks GitHub nothing at all");
});

/**
 * An episode that closed below its cap is over too.
 *
 * The cap allows two more rounds here, so the bounds do not end this episode and
 * the record of its close is the only thing that does. A round gated on the bounds
 * alone reviews again, appends a round and posts a second comment for one episode.
 */
test("a firing after an episode closed below its cap reviews nothing, whatever the cap allows", async () => {
  const closed = await runInFixture({
    config: { rounds: 3 },
    rounds: [ANSWER_COST],
    answers: {
      prlist: PR_LIST,
      diff: DIFF,
      threads: listed([{ id: "PRRT_one", isResolved: false }]),
      resolve: RESOLVED,
      summary: SUMMARY_POSTED,
    },
    reviewer: reviews({ verdicts: [{ thread: "PRRT_one", verdict: "fixed" }] }),
  });

  assert.ok(closed.conclusion.outcome === "close");
  assert.equal(closed.conclusion.because, "nothing-open");
  assert.equal(closed.state?.closeReported, true, "the close records itself, cap or no cap");

  const again = await runInFixture({
    config: { rounds: 3 },
    rounds: closed.state?.rounds ?? [],
    closeReported: closed.state?.closeReported,
    answers: POSTING,
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.deepEqual(again.conclusion, { outcome: "episode-over" });
  assert.equal(again.invocations.length, 0, "a closed episode must not be billed for another round");
  assert.deepEqual(again.kinds, []);
  assert.deepEqual(
    again.state?.rounds,
    closed.state?.rounds,
    "and no round is appended to an episode that is over",
  );
});

/**
 * A close that reported a summary nothing composed records itself, so it is
 * reported once.
 *
 * The first firing finds its cap already spent, composes nothing and says so. The
 * second is an episode that is over: the line has been written, and writing it
 * again on every firing is the second output format the pointer must not grow.
 */
test("a close that reported its missing summary records itself, and is not reported twice", async () => {
  const first = await runInFixture({
    config: { rounds: 1 },
    rounds: [ANSWER_COST],
    answers: POSTING,
    reviewer: reviews({}),
  });

  assert.ok(first.conclusion.outcome === "close");
  assert.equal(first.conclusion.because, "round-cap");
  assert.equal(first.conclusion.summary.outcome, "never-composed");
  assert.equal(first.state?.closeReported, true, "a close that ends the episode records it");

  const again = await runInFixture({
    config: { rounds: 1 },
    rounds: first.state?.rounds ?? [],
    closeReported: first.state?.closeReported,
    answers: POSTING,
    reviewer: reviews({}),
  });

  assert.deepEqual(again.conclusion, { outcome: "episode-over" });
  assert.deepEqual(again.kinds, []);
});

/**
 * A close whose record could not be written says so, and the comment it posted
 * still counts as posted.
 *
 * The episode's directory stops taking writes once the comment has gone up, which
 * is the shape a full disk and a directory turned read-only both leave: the state
 * file is there and readable, the round's cost is in it, and the close cannot be
 * added. Two failures would be worse than the one: a comment reported as lost when
 * it is on the pull request, and a persistence failure nobody was told about.
 */
test("a close that could not record itself reports the write and keeps the comment it posted", async () => {
  const ran = await runInFixture({
    rounds: [ANSWER_COST],
    answers: { prlist: PR_LIST, diff: DIFF, threads: listed([]), summary: SUMMARY_POSTED },
    lockStateAfter: "summary",
    reviewer: reviews({}),
  });

  assert.ok(ran.conclusion.outcome === "close");
  assert.deepEqual(
    ran.conclusion.summary,
    { outcome: "posted" },
    "the comment is on the pull request, and a write that failed afterwards does not take it off",
  );
  assert.equal(ran.conclusion.recorded.outcome, "failed");
  assert.match(
    ran.conclusion.recorded.outcome === "failed" ? ran.conclusion.recorded.reason : "",
    /could not be written/u,
    "the filesystem's own error is what a person has to act on",
  );
  assert.notEqual(
    ran.state?.closeReported,
    true,
    "the file is readable and holds no close, which is exactly why the next firing cannot know",
  );

  // The next firing of that episode, its directory writable again. It has nothing
  // that says the episode closed, so it reviews as an episode that never did.
  const again = await runInFixture({
    rounds: ran.state?.rounds ?? [],
    closeReported: ran.state?.closeReported,
    answers: POSTING,
    reviewer: reviews({}),
  });

  assert.equal(
    again.invocations.length,
    1,
    "a close the harness could not record is one no later firing can read, and the round that lost it said so",
  );
  assert.deepEqual(again.kinds.filter((kind) => kind === "summary"), ["summary"]);
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

/**
 * A reviewer at `deep` can write to the tree through its shell, and two readings
 * taken around it are the only thing that names the file it changed. A round
 * reports what they say and does nothing else with it.
 */
test("a tracked file the reviewer wrote to is named, and the round posts what it found", async () => {
  const ran = await runInFixture({
    answers: POSTING,
    reviewer: writesThenReviews([finding("The flag is never read")]),
  });

  assert.ok(ran.conclusion.outcome === "block");
  assert.deepEqual(ran.conclusion.confinement?.trackedFiles, {
    outcome: "changed",
    paths: [TRACKED],
  });
  assert.deepEqual(ran.conclusion.confinement?.otherEpisodes, { outcome: "alone" });
  assert.deepEqual(
    ran.kinds,
    ["prlist", "threads", "diff", "create", "lookup"],
    "a mutated tree is reported rather than blocked on, so the round posts what it always would",
  );
  assert.deepEqual(
    ran.markedWhenStarted,
    [true],
    "a round another episode cannot find is one whose reviewer's writes that episode reads as its own",
  );
  assert.equal(ran.markerLeft, false, "the marker goes when the round ends");
});

/**
 * The reading after the reviewer is taken on every path the reviewer can end on.
 *
 * A reviewer killed at its time bound is the one most likely to have left a write
 * behind, and it is the path where the round is already handling a failure. A
 * comparison taken only where the review finished would be missing from the case
 * it exists for, and every other test here would still pass.
 */
test("a round killed at its bound takes the reading after the reviewer all the same", async () => {
  const floor: RoundCost = { dollars: 0.02, tokens: 700, messages: 1 };
  const ran = await runInFixture({
    config: { timeout: 1 },
    answers: POSTING,
    reviewer: writesThenHangs(floor),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.equal(ran.conclusion.failure, "timed-out");
  assert.deepEqual(
    ran.conclusion.confinement?.trackedFiles,
    { outcome: "changed", paths: [TRACKED] },
    "the write the kill left behind is what the comparison exists to name",
  );
  assert.deepEqual(ran.markedWhenStarted, [true]);
  assert.equal(ran.markerLeft, false, "a round that failed clears its marker too");
});

test("a worktree shared with another live episode takes no comparison, and the round still runs", async () => {
  const ran = await runInFixture({
    sharedWith: OTHER_AGENT_ID,
    answers: POSTING,
    reviewer: writesThenReviews([finding("The flag is never read")]),
  });

  assert.ok(ran.conclusion.outcome === "block");
  const confinement = ran.conclusion.confinement;
  assert.equal(confinement?.otherEpisodes.outcome, "shared");
  assert.deepEqual(
    confinement?.otherEpisodes.outcome === "shared"
      ? confinement.otherEpisodes.episodes.map((other) => other.id)
      : [],
    [OTHER_AGENT_ID],
    "the episodes that shared the worktree are what the summary names in place of a comparison",
  );
  assert.equal(
    confinement?.trackedFiles.outcome,
    "not-taken",
    "a reading taken here would name the other episode's writing as this reviewer's",
  );
  assert.deepEqual(
    ran.kinds,
    ["prlist", "threads", "diff", "create", "lookup"],
    "what is disabled in a shared worktree is the comparison and nothing else",
  );
});

test("a reading that could not be taken is not a tree that did not change", async () => {
  const ran = await runInFixture({
    answers: POSTING,
    reviewer: breaksGit(),
  });

  assert.ok(ran.conclusion.outcome === "close");
  const trackedFiles = ran.conclusion.confinement?.trackedFiles;
  assert.equal(
    trackedFiles?.outcome,
    "unknown",
    "a git that failed, read as a clean tree, would report a reviewer that touched nothing",
  );
  assert.match(
    trackedFiles?.outcome === "unknown" ? trackedFiles.reason : "",
    /the reading after could not be taken/u,
  );
  assert.ok(ran.kinds.includes("summary"), "the episode closed on its own terms all the same");
});

test("a round with too little of its window left takes no reading", async () => {
  const ran = await runInFixture({
    // Less left than a reading is given, and nothing interrupts one that has
    // started: the round takes none rather than one the posting pays for.
    windowMs: 4_000,
    marginMs: 1_000,
    answers: POSTING,
    reviewer: reviews({}),
  });

  assert.ok(ran.conclusion.outcome === "close");
  const trackedFiles = ran.conclusion.confinement?.trackedFiles;
  assert.equal(trackedFiles?.outcome, "not-taken");
  assert.match(trackedFiles?.outcome === "not-taken" ? trackedFiles.reason : "", /window/u);
});

test("a marker that could not be written is reported, and the round reviews and posts", async () => {
  const ran = await runInFixture({
    blockMarker: true,
    answers: POSTING,
    reviewer: writesThenReviews([finding("The flag is never read")]),
  });

  assert.ok(ran.conclusion.outcome === "block");
  assert.equal(
    ran.conclusion.confinement?.marked.outcome,
    "failed",
    "a round no other episode can find says so rather than passing for one they can",
  );
  assert.deepEqual(
    ran.conclusion.confinement?.trackedFiles,
    { outcome: "changed", paths: [TRACKED] },
    "the marker is for the other episodes, and this round reads its own worktree either way",
  );
});

/**
 * A round that could not record what it spent posts nothing and reports the write,
 * and what the readings established is not lost with it.
 *
 * The reviewer ran and both readings were taken, so a conclusion carrying no
 * confinement here would say no reviewer ran. The mutation is the one thing about
 * this round nothing else can be asked for afterwards: the tree has moved on by
 * the time anybody reads it.
 */
test("a cost that could not be recorded keeps what the readings established", async () => {
  const ran = await runInFixture({
    answers: POSTING,
    reviewer: writesThenLocksTheState(),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.equal(ran.conclusion.failure, "harness");
  assert.match(ran.conclusion.reason, /nothing was posted/u);
  assert.deepEqual(
    ran.conclusion.confinement?.trackedFiles,
    { outcome: "changed", paths: [TRACKED] },
    "the reviewer ran, and the file it wrote to is named whatever the state file did",
  );
  assert.deepEqual(
    ran.kinds,
    ["prlist", "threads", "diff"],
    "nothing is posted on a state file that would not take the round",
  );
});

/** Everything the two rounds of a closing episode need answering. */
const TWO_ROUNDS: Answers = {
  prlist: PR_LIST,
  diff: DIFF,
  create: CREATED,
  lookup: LOOKUP,
  resolve: RESOLVED,
  summary: SUMMARY_POSTED,
};

/**
 * The threads each round is handed: none for the first, and the one the first
 * round opened for the second.
 */
const THREADS_OF_TWO_ROUNDS: Partial<Record<Kind, readonly string[]>> = {
  threads: [listed([]), listed([{ id: "PRRT_new", isResolved: false }])],
};

/** The verdict that closes the thread the first round opened, leaving nothing open. */
const FIXES_IT = reviews({ verdicts: [{ thread: "PRRT_new", verdict: "fixed" }] });

/** The body of the one summary comment the episode posted. */
function summaryBody(ran: Ran): string {
  const posted = ran.calls.filter((call) => call.kind === "summary");
  assert.equal(posted.length, 1, "the comment is posted once, and nothing ever edits it");
  return sent(posted[0]?.body ?? "");
}

/** Another episode of the worktree reports its close, which leaves it no longer live. */
function closeEpisode(worktree: string, agentId: string): void {
  const other = episodeAt(worktree, agentId);
  const read = readState(other);
  assert.equal(read.outcome, "read", "the fixture's other episode must have a state file");
  const written = writeState(other, {
    rounds: [ANSWER_COST],
    spentOutsideRounds: unspent,
    closeReported: true,
  });
  assert.equal(written.outcome, "written", "the other episode's close must be written");
}

/**
 * The write an earlier round found reaches the comment the closing round posts.
 *
 * A round that blocks posts nothing, so the only comment the episode ever puts up
 * is the closing round's, and a comment composed from that round's own readings
 * reports the worktree of one round as the worktree of all of them. The closing
 * round here touched nothing and compared the tree successfully, which is the
 * answer that would overwrite the first round's.
 *
 * Two rounds, because one cannot reach the handover: whatever a fixture supplies
 * the composer is what the composer renders.
 */
test("a file the first round changed is named in the comment the closing round posts", async () => {
  const ran = await runInFixture({
    answers: TWO_ROUNDS,
    sequences: THREADS_OF_TWO_ROUNDS,
    reviewer: writesThenReviews([finding("The flag is never read")]),
    andThen: [{ reviewer: FIXES_IT }],
  });

  assert.ok(ran.conclusions[0]?.outcome === "block");
  assert.deepEqual(
    ran.conclusions[0].confinement?.trackedFiles,
    { outcome: "changed", paths: [TRACKED] },
    "the round that found the write posted no comment, so what it found is the episode's to carry",
  );
  assert.ok(ran.conclusion.outcome === "close");
  assert.equal(ran.conclusion.because, "nothing-open");
  assert.deepEqual(
    ran.conclusion.confinement?.trackedFiles,
    { outcome: "unchanged" },
    "the closing round compared the tree and found nothing, which the comment must not be composed from",
  );
  assert.deepEqual(ran.kinds, [
    "prlist",
    "threads",
    "diff",
    "create",
    "lookup",
    "prlist",
    "threads",
    "diff",
    "resolve",
    "summary",
  ]);

  assert.equal(
    summaryBody(ran),
    [
      "**Squiz review — 2 rounds, 1 finding**",
      "",
      "Fixed 1 · Withdrawn 0 · Open 0 · Disputed 0",
      "2,400 tokens over 2 rounds: 1,200, 1,200 · $0.0800",
      "",
      "**Needs a person**",
      "",
      "Nothing needs a person.",
      "",
      "**Notes**",
      "",
      `- A file changed in the worktree while the reviewer ran: \`${TRACKED}\``,
    ].join("\n"),
  );
});

/** A reviewer that moved `HEAD` through its shell with `move`, and reviewed. */
function movesHeadThenReviews(move: string, findings: readonly Finding[]): Reviewer {
  return { command: "/bin/sh", args: ["-c", move], parse: reviews({ findings }).parse };
}

/**
 * A move that leaves the branch is told to the coding agent by the round that
 * blocks.
 *
 * The next firing gates on the branch `HEAD` names then, and finds no pull request
 * for it. That firing reads nothing the episode saved, so a move kept only for the
 * summary is reported by nothing at all.
 */
test("a reviewer that detached HEAD is named in the blocking reason, before the next firing finds no pull request", async () => {
  const ran = await runInFixture({
    answers: TWO_ROUNDS,
    sequences: THREADS_OF_TWO_ROUNDS,
    reviewer: movesHeadThenReviews("git checkout --quiet --detach", [
      finding("The flag is never read"),
    ]),
    andThen: [{ reviewer: FIXES_IT }],
  });

  assert.deepEqual(
    ran.conclusions.map((conclusion) => conclusion.outcome),
    ["block", "no-pull-request"],
  );
  assert.ok(ran.conclusions[0]?.outcome === "block");
  assert.match(
    ran.conclusions[0].reason,
    new RegExp(
      `\`HEAD\` moved while the reviewer ran: from refs/heads/${BRANCH} at [0-9a-f]{40} to a detached HEAD at [0-9a-f]{40}`,
      "u",
    ),
    "the next firing finds no pull request and reports nothing, so the blocking reason is the move's one report",
  );
});

test("a reviewer that switched to a branch with no pull request is named in the blocking reason", async () => {
  const ran = await runInFixture({
    answers: TWO_ROUNDS,
    sequences: { ...THREADS_OF_TWO_ROUNDS, prlist: [PR_LIST, "[]"] },
    reviewer: movesHeadThenReviews("git checkout --quiet -b elsewhere", [
      finding("The flag is never read"),
    ]),
    andThen: [{ reviewer: FIXES_IT }],
  });

  assert.deepEqual(
    ran.conclusions.map((conclusion) => conclusion.outcome),
    ["block", "no-pull-request"],
  );
  assert.ok(ran.conclusions[0]?.outcome === "block");
  assert.match(
    ran.conclusions[0].reason,
    new RegExp(
      `\`HEAD\` moved while the reviewer ran: from refs/heads/${BRANCH} at ([0-9a-f]{40}) to refs/heads/elsewhere at \\1`,
      "u",
    ),
    "the next firing finds no pull request and reports nothing, so the blocking reason is the move's one report",
  );
});

/**
 * A worktree an earlier round shared, and could not compare, reaches the comment
 * too.
 *
 * The other episode reports its close between the rounds, so the closing round has
 * the tree to itself and compares it. Those are the two answers that would
 * overwrite the first round's, and the first round's are the ones a person needs:
 * nothing about its interval was established at all.
 */
test("a worktree the first round shared is named in the comment the closing round posts", async () => {
  const ran = await runInFixture({
    sharedWith: OTHER_AGENT_ID,
    answers: TWO_ROUNDS,
    sequences: THREADS_OF_TWO_ROUNDS,
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
    andThen: [
      { before: (worktree) => closeEpisode(worktree, OTHER_AGENT_ID), reviewer: FIXES_IT },
    ],
  });

  assert.ok(ran.conclusion.outcome === "close");
  assert.deepEqual(
    ran.conclusion.confinement?.otherEpisodes,
    { outcome: "alone" },
    "the closing round had the tree to itself, which the comment must not be composed from",
  );
  assert.deepEqual(ran.conclusion.confinement?.trackedFiles, { outcome: "unchanged" });

  assert.equal(
    summaryBody(ran),
    [
      "**Squiz review — 2 rounds, 1 finding**",
      "",
      "Fixed 1 · Withdrawn 0 · Open 0 · Disputed 0",
      "2,400 tokens over 2 rounds: 1,200, 1,200 · $0.0800",
      "",
      "**Needs a person**",
      "",
      "Nothing needs a person.",
      "",
      "**Notes**",
      "",
      "- A round could not tell whether a file changed or `HEAD` moved while the reviewer ran:" +
        ` the worktree is shared with live episode ${OTHER_AGENT_ID}`,
      `- Another episode was in the worktree while the reviewer ran: ${OTHER_AGENT_ID}`,
    ].join("\n"),
  );
});

/**
 * A state file written before the episode kept what its rounds established still
 * reads, and the round that reads it closes normally.
 *
 * Read as unreadable, the file would end the round before the reviewer ran, and
 * every round of that episode after it.
 */
test("a state file written before the worktree evidence existed is read as an episode with none", async () => {
  const ran = await runInFixture({
    config: { rounds: 2 },
    stateSource: `{"rounds": [{"dollars": 0.04, "tokens": 1200, "messages": 3}]}\n`,
    answers: {
      prlist: PR_LIST,
      diff: DIFF,
      threads: listed([{ id: "PRRT_open", isResolved: false }]),
      summary: SUMMARY_POSTED,
    },
    reviewer: writesThenReviews(),
  });

  assert.ok(ran.conclusion.outcome === "close");
  assert.equal(ran.conclusion.because, "round-cap");
  assert.equal(
    summaryBody(ran),
    [
      "**Squiz review — 2 rounds, 1 finding**",
      "",
      "Fixed 0 · Withdrawn 0 · Open 1 · Disputed 0",
      "2,400 tokens over 2 rounds: 1,200, 1,200 · $0.0800",
      "",
      "**Needs a person**",
      "",
      "- `src/ui/card.ts:88` — The name says nothing. (open)",
      "",
      "**Notes**",
      "",
      `- A file changed in the worktree while the reviewer ran: \`${TRACKED}\``,
      "- The episode ended at its round cap rather than with nothing left open",
    ].join("\n"),
  );
});

/**
 * A killed reviewer and a finished one both end with their findings posted, so
 * the posting proves nothing about which of the two a round was. The reviewer
 * here outlives a real bound of one second, and the record and the comment are
 * what is asserted.
 *
 * Two rounds, because a round the reviewer failed posts no summary: the cut is
 * reported by the round that closes the episode after it.
 */
test("a round the time bound cut short is recorded, and the closing summary says so", async () => {
  const floor: RoundCost = { dollars: 0.02, tokens: 700, messages: 1 };
  const ran = await runInFixture({
    config: { timeout: 1 },
    answers: TWO_ROUNDS,
    sequences: THREADS_OF_TWO_ROUNDS,
    reviewer: hangs(floor, { findings: [finding("The flag is never read")] }),
    andThen: [{ reviewer: FIXES_IT }],
  });

  assert.ok(ran.conclusions[0]?.outcome === "failed");
  assert.equal(ran.conclusions[0].failure, "timed-out");
  assert.ok(ran.conclusion.outcome === "close");

  const [cut, finished] = ran.state?.rounds ?? [];
  assert.equal(cut?.cutShortAtSeconds, 1, "the killed round names the bound that ended it");
  assert.ok(
    (cut?.elapsedSeconds ?? 0) >= 1,
    `a round killed at a one-second bound ran ${cut?.elapsedSeconds} seconds`,
  );
  assert.equal(finished?.cutShortAtSeconds, undefined, "a review that finished was cut short by nothing");

  assert.match(
    summaryBody(ran),
    /\n- The review was cut short by the 1-second time bound in round 1, and the round kept only the findings it had reported by then$/u,
  );
});

test("a reviewer that exits on its own records how long it ran, and no cut", async () => {
  const ran = await runInFixture({
    config: { rounds: 1 },
    answers: POSTING,
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.ok(ran.conclusion.outcome === "close");
  const [round] = ran.state?.rounds ?? [];
  assert.equal(typeof round?.elapsedSeconds, "number", "every round records how long its reviewer ran");
  assert.ok((round?.elapsedSeconds ?? -1) >= 0);
  assert.equal(round?.cutShortAtSeconds, undefined);
  assert.doesNotMatch(summaryBody(ran), /cut short/u);
});
