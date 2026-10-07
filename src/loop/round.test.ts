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
import { dirname, join } from "node:path";
import { test } from "node:test";

import { defaultConfig, type Config } from "../config/config.ts";
import { renderComment } from "../findings/comment.ts";
import type { Finding } from "../findings/finding.ts";
import { endsOnFor, failureLinesOf } from "../host/host.ts";
import { takeHostLock, type HostLock } from "../host/lock.ts";
import {
  unspent,
  type Adapter,
  type Invocation,
  type ParsedRun,
  type RoundCost,
  type RoundOutput,
  type ThreadVerdict,
} from "../reviewers/adapter.ts";
import { composeReview } from "../review/output.ts";
import { startChild } from "../sessions/child.ts";
import type { Backends } from "../sessions/session.ts";
import { standIn } from "../testing/stand-in.ts";
import { snapshotPath } from "../worktree/snapshot.ts";
import { writeState, type EpisodeState, type RoundRecord } from "./episode-state.ts";
import { episodeAt } from "./episode.ts";
import type { EpisodeSummary } from "./post-summary.ts";
import { runRound, type RoundConclusion } from "./round.ts";

const BRANCH = "review-me";
const PULL_REQUEST = 142;
const HEAD_SHA = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";

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
  | "reply"
  | "summary"
  | "failure";

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
  readonly rounds?: readonly RoundRecord[];
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
  /**
   * Whether the host lock is taken before the round starts and handed to it, as
   * the round host does, so the round takes no lock of its own.
   */
  readonly heldByHost?: boolean;
  /** A state file written as it stands, for a file the round cannot read. */
  readonly stateSource?: string;
  /** What the episode's lock holds before the round starts, where it is there. */
  readonly lockSource?: string;
  readonly postingMs?: number;
  readonly preReviewMs?: number;
  /** Whether a failed round posts its failure comment, where the caller says. */
  readonly postsFailure?: boolean;
  /** The round's clock, where the test moves it rather than leaving it to the load. */
  readonly clock?: Clock;
  readonly detached?: boolean;
  /**
   * Whether git's `worktree add` makes the snapshot and then exits non-zero, for
   * a snapshot left behind by an add that failed.
   */
  readonly snapshotAddFails?: boolean;
  /**
   * The rounds after the first, in order.
   *
   * Each runs against the worktree the round before it left behind and reads the
   * state file that round wrote, so what one round hands the next is what a
   * fixture of several drives. A fixture of one round cannot reach a handover at
   * all: whatever it supplies the composer is what the composer renders.
   */
  readonly andThen?: readonly Later[];
  /**
   * Rounds started together against the one episode, each running `reviewer`,
   * as two subagents stopping at once in one worktree start them.
   */
  readonly overlapping?: number;
  /** What starts the reviewer, where it is not the real backends. */
  readonly sessionBackends?: Backends;
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
  readonly state: EpisodeState | null;
  /** The state file exactly as it stands, `null` where there is no file at all. */
  readonly stateSource: string | null;
  /** How long the round itself took, with the fixture's own setup left out. */
  readonly elapsedMs: number;
  /** Whether the episode's lock was still there once the rounds had ended. */
  readonly lockLeft: boolean;
  /** What `.squiz/` holds once the rounds have ended, empty where it is not there. */
  readonly episodesLeft: readonly string[];
  /**
   * The commit checked out in each reviewer's current directory as its process
   * started, `null` where git could not say.
   */
  readonly headsWhenStarted: readonly (string | null)[];
  /** The coding agent's worktree the rounds reviewed. */
  readonly worktree: string;
  /** The commit the fixture's worktree holds, which the pull request names as its head. */
  readonly head: string;
  /** The rounds' snapshot directories still standing once the rounds have ended. */
  readonly snapshotsLeft: readonly string[];
  /** The worktrees git lists once the rounds have ended, the fixture's own included. */
  readonly worktreesLeft: readonly string[];
  /** Whether a snapshot was standing as each `gh` call was made, in call order. */
  readonly snapshotAtCall: readonly boolean[];
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
  /** `undefined` given explicitly is a review with no cost, as Copilot's can be. */
  readonly cost?: RoundCost | undefined;
}): Reviewer {
  return {
    parse: async (stdout): Promise<ParsedRun> => {
      await drain(stdout);
      return {
        cost: "cost" in output ? output.cost : ANSWER_COST,
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

/** A clock that stands still until the test moves it. */
type Clock = { at: number; readonly now: () => number };

function stoppedClock(): Clock {
  const clock: Clock = { at: 0, now: () => clock.at };
  return clock;
}

/**
 * A reviewer that reports `findings` and never finishes, and moves `clock` to
 * `atMs` once it has started.
 *
 * The clock starts at zero and nothing before the review moves it, so the
 * review's bound ends at the configured timeout exactly. A move past that is
 * time spent stopping the reviewer, as the round sees it.
 */
function hangsUntil(clock: Clock, atMs: number, findings: readonly Finding[] = []): Reviewer {
  return {
    command: "/bin/sh",
    args: ["-c", "sleep 30"],
    parse: async (stdout, progressSoFar): Promise<ParsedRun> => {
      clock.at = atMs;
      return hangs(ANSWER_COST, { findings }).parse(stdout, progressSoFar);
    },
  };
}

/**
 * A reviewer that answers inside its bound and then holds on through the round's
 * cleanup.
 *
 * It finishes its review at once, so the round holding the declaration is left
 * with findings to post. It then ignores the signal that would stop it, so the
 * round spends the grace and the kill after the moment the review had to be
 * over by.
 */
function answersThenHolds(findings: readonly Finding[]): Reviewer {
  return {
    command: "/bin/sh",
    // The wait is short and repeated, because a shell blocked in one long sleep
    // reaches its trap only once that sleep is over.
    args: ["-c", "trap '' TERM; while :; do sleep 0.2; done"],
    parse: async (reports, progressSoFar): Promise<ParsedRun> => {
      progressSoFar?.({
        cost: ANSWER_COST,
        findings,
        verdicts: [],
        refusals: 0,
        finished: true,
        broken: undefined,
      });
      return reviews({ findings }).parse(reports, progressSoFar);
    },
  };
}

/**
 * A reviewer that reports findings and then ignores both its bound and the signal
 * that would stop it.
 *
 * The round spends the grace and the kill after the moment the review had to be
 * over by, and that comes out of the posting reserve.
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

/** A reviewer that wrote to the file under review in its snapshot, and reviewed. */
function writesThenReviews(findings: readonly Finding[] = []): Reviewer {
  return {
    command: "/bin/sh",
    args: ["-c", `printf '// line 2\\n' >> ${TRACKED}`],
    parse: reviews({ findings }).parse,
  };
}

/**
 * A reviewer that took the write permission off the episode's directory, so the
 * round cannot record what it spent.
 */
function locksTheState(): Reviewer {
  return {
    command: "/bin/sh",
    args: ["-c", `chmod 500 "$AGENT_WORKTREE/.squiz/${PULL_REQUEST}"`],
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
    const head = headIn(worktree) ?? assert.fail("the fixture's own commit must read back");

    const episode = episodeAt(worktree, PULL_REQUEST);
    // Where the episode's snapshots go, for the fake `gh` to look as each call is made.
    await writeFile(join(binaries, "snapshot-rounds"), snapshotRoundsOf(worktree), "utf8");
    const charterFile = join(root, "charter.md");
    await writeFile(charterFile, "What a good review is.\n", "utf8");
    // The pull request names the commit the fixture made, which is one a snapshot
    // can be made of.
    const answers = withHead(setup.answers, head);
    const sequences = withHead(setup.sequences ?? {}, head);
    await writeFake(binaries, answers, sequences, setup.delays ?? {}, {
      ...(setup.lockStateAfter === undefined
        ? {}
        : { [setup.lockStateAfter]: episode.directory }),
    });
    if (setup.snapshotAddFails === true) failCheckout(binaries);
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
    if (setup.lockSource !== undefined) {
      mkdirSync(episode.directory, { recursive: true });
      writeFileSync(join(episode.directory, "host.lock"), setup.lockSource, "utf8");
    }

    const invocations: Invocation[] = [];
    const directoriesReady: boolean[] = [];
    const headsWhenStarted: (string | null)[] = [];
    const laterRounds = setup.andThen ?? [];
    const reviewers = [setup.reviewer, ...laterRounds.map((later) => later.reviewer)];
    // Which round is running, which is what says whose reviewer the adapter starts.
    // One round can start more than one process, so the index is the round's rather
    // than the process's.
    let running = 0;
    const current = (): Reviewer => reviewers[running] ?? setup.reviewer;
    const adapter: Adapter = {
      // The coding agent's worktree, for a reviewer standing in for the agent's
      // own edits while the review runs.
      confine: () => ({ outcome: "prepared", environment: { AGENT_WORKTREE: worktree } }),
      argv: (invocation) => {
        invocations.push(invocation);
        // Read here rather than after the round: the reviewer is told to write
        // into it, and it has to be there before its process starts.
        directoriesReady.push(existsSync(invocation.sessionDirectory));
        headsWhenStarted.push(headIn(invocation.directory));
        return {
          command: current().command ?? "/bin/sh",
          args: [...(current().args ?? ["-c", "exit 0"])],
          directory: invocation.directory,
          stdin: "/dev/null",
          environment: {},
        };
      },
      parse: (stdout, progressSoFar) => current().parse(stdout, progressSoFar),
      grants: ["read"],
    };

    let held: HostLock | undefined;
    if (setup.heldByHost === true) {
      mkdirSync(episode.directory, { recursive: true });
      const taking = takeHostLock(episode.directory, { boundMs: 5_000 });
      held = taking.outcome === "taken" ? taking.lock : assert.fail("the fixture's host lock must be taken");
    }
    const conclusions: RoundConclusion[] = [];
    const started = Date.now();
    const config = { ...defaultConfig, timeout: 5, ...setup.config };
    const roundSetup = {
      worktree,
      config,
      adapter,
      charterFile,
      // Nothing is ever queued here, so the round's end is the cap's and the
      // token bound's alone, decided as the round host decides it.
      endsOn: endsOnFor({ head, activity: null }, config),
      ...(setup.postingMs === undefined ? {} : { postingMs: setup.postingMs }),
      ...(setup.preReviewMs === undefined ? {} : { preReviewMs: setup.preReviewMs }),
      ...(setup.postsFailure === undefined ? {} : { postsFailure: setup.postsFailure }),
      ...(setup.clock === undefined ? {} : { now: setup.clock.now }),
      ...(held === undefined ? {} : { held: { pullRequest: PULL_REQUEST, lock: held } }),
      ...(setup.sessionBackends === undefined ? {} : { sessionBackends: setup.sessionBackends }),
    };
    if (setup.overlapping !== undefined) {
      const together = Array.from({ length: setup.overlapping }, () => runRound(roundSetup));
      conclusions.push(...(await Promise.all(together)));
    }
    for (running = 0; setup.overlapping === undefined && running < reviewers.length; running += 1) {
      laterRounds[running - 1]?.before?.(worktree);
      conclusions.push(await runRound(roundSetup));
    }
    const elapsedMs = Date.now() - started;

    const stateSource = existsSync(episode.stateFile)
      ? readFileSync(episode.stateFile, "utf8")
      : null;
    const kinds = lines(join(binaries, "kinds")) as readonly Kind[];
    const episodes = join(worktree, ".squiz");
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
      state: stateIn(stateSource),
      stateSource,
      elapsedMs,
      episodesLeft: existsSync(episodes) ? readdirSync(episodes) : [],
      lockLeft: existsSync(join(episode.directory, "host.lock")),
      headsWhenStarted,
      head,
      worktree,
      snapshotsLeft: snapshotsOf(worktree),
      worktreesLeft: worktreesOf(worktree),
      snapshotAtCall: kinds.map((_, at) => existsSync(join(binaries, `snapshot-${at + 1}`))),
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

/** The commit checked out in `directory`, or `null` where git cannot say. */
function headIn(directory: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/** Every answer, with the placeholder head replaced by the commit the fixture made. */
function withHead<T extends Partial<Record<Kind, string | readonly string[]>>>(
  answers: T,
  head: string,
): T {
  const replaced = (answer: string): string => answer.replaceAll(HEAD_SHA, head);
  return Object.fromEntries(
    Object.entries(answers).map(([kind, answer]) => [
      kind,
      typeof answer === "string" ? replaced(answer) : (answer as readonly string[]).map(replaced),
    ]),
  ) as T;
}

/** A `git` ahead of the real one, whose `checkout` checks out and then fails. */
function failCheckout(binaries: string): void {
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  standIn(
    binaries,
    "git",
    [
      "#!/bin/sh",
      `case " $* " in *" checkout "*) '${real}' "$@"; exit 1 ;; esac`,
      `exec '${real}' "$@"`,
      "",
    ].join("\n"),
  );
}

/** The directory holding one directory per round of the episode's snapshots of `worktree`. */
function snapshotRoundsOf(worktree: string): string {
  return dirname(dirname(snapshotPath(worktree, { pullRequest: PULL_REQUEST, round: 1 })));
}

/** The round snapshots of `worktree` still standing. */
function snapshotsOf(worktree: string): readonly string[] {
  const rounds = snapshotRoundsOf(worktree);
  if (!existsSync(rounds)) return [];
  return readdirSync(rounds)
    .map((round) => join(rounds, round, "tree"))
    .filter((tree) => existsSync(tree));
}

/** The worktrees git lists for the repository holding `worktree`. */
function worktreesOf(worktree: string): readonly string[] {
  return execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: worktree, encoding: "utf8" })
    .split("\n")
    .filter((line) => line.startsWith("worktree "));
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
    // A round with no cost has none of the three, and is left with none.
    rounds: state.rounds.map(({ dollars, tokens, messages }) =>
      tokens === undefined ? {} : { dollars, tokens, messages },
    ),
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
  "  *'addPullRequestReviewThreadReply'*) kind=reply ;;",
  // Before the resolve: one spelling is inside the other.
  "  *'unresolveReviewThread'*) kind=unresolve ;;",
  "  *'resolveReviewThread'*) kind=resolve ;;",
  // The read-back that follows a create reaches the threads from the comment.
  "  *'PullRequestReviewComment'*) kind=lookup ;;",
  "  *'reviewThreads(first:100'*) kind=threads ;;",
  // Before the create, which is the other POST. The summary goes to the issues
  // path and a finding's thread to the pulls path, and those two paths are the
  // whole of the difference between a comment on the pull request and a comment
  // on a line of its diff. The failure comment goes to the same path, and its
  // marker is what tells it from the summary.
  "  *'/issues/'*'/comments'*'Squiz review failed'*) kind=failure ;;",
  "  *'/issues/'*'/comments'*) kind=summary ;;",
  "  *'--method POST'*) kind=create ;;",
  "  *'pr list'*) kind=prlist ;;",
  "  *'v3.diff'*) kind=diff ;;",
  "esac",
  'printf \'%s\\n\' "$kind" >> "$dir/kinds"',
  // Whether a round's snapshot stood as this call was made.
  'for tree in "$(cat "$dir/snapshot-rounds")"/*/tree; do [ -d "$tree" ] && : > "$dir/snapshot-$n"; done',
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

/** A reply GitHub took, on a thread the reviewer kept open. */
const REPLIED = included(
  "200 OK",
  JSON.stringify({ data: { addPullRequestReviewThreadReply: { comment: { databaseId: 2140876600 } } } }),
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
  assert.equal(ran.invocations.length, 1);
  assert.equal(
    ran.invocations[0]?.prompt.includes("## Threads already on this pull request"),
    false,
    "a prompt that carried a threads section with nothing handed over would ask for a verdict on nothing",
  );
});

test("the prompt the round hands the reviewer tells it what the history tools are for", async () => {
  const ran = await runInFixture({ answers: POSTING, reviewer: reviews({}) });
  assert.match(ran.invocations[0]?.prompt ?? "", /^## History$/mu);
});

/**
 * A new worktree on the same branch starts a second episode of the pull request,
 * and its state file is new while the pull request is not.
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
      reply: REPLIED,
    },
    reviewer: reviews({
      verdicts: [
        { thread: "PRRT_one", verdict: "fixed" },
        { thread: "PRRT_two", verdict: "open", reason: "Still wrong." },
      ],
    }),
  });

  assert.deepEqual(ran.kinds, ["prlist", "threads", "diff", "reply", "resolve", "unresolve", "reply"]);
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
 * this review, and a round that counted it would keep the episode open over a
 * comment nobody asked the coding agent to work.
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
      reply: REPLIED,
    },
    reviewer: reviews({ verdicts: [{ thread: "PRRT_closed", verdict: "open", reason: "Still wrong." }] }),
  });

  assert.deepEqual(ran.kinds, ["prlist", "threads", "diff", "unresolve", "reply"]);
  assert.equal(ran.conclusion.outcome, "block");
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

test("the reviewer's session directory exists before it starts", async () => {
  const ran = await runInFixture({
    answers: POSTING,
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.deepEqual(ran.directoriesReady, [true], "the reviewer's CLI does not make its session directory");
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
      reply: REPLIED,
    },
    reviewer: reviews({
      verdicts: [
        { thread: "PRRT_one", verdict: "fixed" },
        { thread: "PRRT_two", verdict: "open", reason: "Still wrong." },
      ],
    }),
  });

  assert.deepEqual(ran.kinds, ["prlist", "threads", "diff", "reply", "resolve", "unresolve", "reply"]);
  const prompt = ran.invocations[0]?.prompt ?? "";
  assert.match(prompt, /### PRRT_one\n\nNot resolved\./u);
  assert.match(prompt, /### PRRT_two\n\nResolved\./u);
  assert.match(prompt, /The name says nothing\./u);

  assert.ok(ran.conclusion.outcome === "block");
  assert.deepEqual(ran.conclusion.posted, []);
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
    rounds: [{ ...ANSWER_COST, reviewer: "pi" }],
    answers: {
      prlist: PR_LIST,
      diff: DIFF,
      threads: listed([{ id: "PRRT_open", isResolved: false }]),
      summary: SUMMARY_POSTED,
      reply: REPLIED,
    },
    reviewer: reviews({ verdicts: [{ thread: "PRRT_open", verdict: "open", reason: "Still wrong." }] }),
  });

  assert.ok(ran.conclusion.outcome === "close");
  assert.equal(ran.conclusion.because, "round-cap");
  assert.deepEqual(ran.conclusion.summary, { outcome: "posted" });
  assert.deepEqual(ran.kinds, ["prlist", "threads", "diff", "reply", "summary"]);
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
      "Reviewed by `pi` on an unknown model",
      "",
      "**Needs a person**",
      "",
      "- `src/ui/card.ts:88` — The name says nothing. (open)",
      "",
      "**Rounds**",
      "",
      // The fixture's state names no work for the round it seeded.
      "- Round 1: not recorded",
      `- Round 2 at ${(ran.state?.rounds[1]?.head ?? "").slice(0, 7)}: raised nothing, and ruled 1 open`,
      "",
      "**Notes**",
      "",
      "- The episode ended at its round cap rather than with nothing left open",
    ].join("\n"),
  );
});

/**
 * The configured model is what the round asked for, and a CLI can run another
 * without saying so. Naming it where the run named none would read exactly like
 * a summary that named the model the run reported.
 */
test("a run that reported no model is summarised on an unknown model, whatever is configured (#271)", async () => {
  const ran = await runInFixture({
    config: { model: "openai/gpt-5-mini" },
    answers: POSTING,
    reviewer: reviews({ cost: ANSWER_COST }),
  });

  assert.ok(ran.conclusion.outcome === "close");
  const body = sent(ran.calls.find((call) => call.kind === "summary")?.body ?? "");
  assert.ok(body.includes("\nReviewed by `pi` on an unknown model\n"), `the summary did not say the model is unknown: ${body}`);
  assert.ok(!body.includes("gpt-5-mini"), `the summary named the configured model the run never reported: ${body}`);
  assert.deepEqual(ran.state?.rounds.map((round) => [round.reviewer, round.models]), [["pi", undefined]]);
});

test("the round records the reviewer and the models its run reported, and the summary names them (#271)", async () => {
  const ran = await runInFixture({
    config: { reviewer: "copilot", model: "gpt-5-mini" },
    answers: POSTING,
    reviewer: reviews({ cost: { ...ANSWER_COST, models: ["claude-sonnet-5"] } }),
  });

  assert.ok(ran.conclusion.outcome === "close");
  const body = sent(ran.calls.find((call) => call.kind === "summary")?.body ?? "");
  assert.ok(body.includes("\nReviewed by `copilot` on `claude-sonnet-5`\n"), `the summary named another model: ${body}`);
  assert.deepEqual(ran.state?.rounds.map((round) => [round.reviewer, round.models]), [["copilot", ["claude-sonnet-5"]]]);
});

test("a round that ran the reviewer twice records the models of both runs (#271)", async () => {
  const ran = await runInFixture({
    answers: POSTING,
    reviewer: attempts(
      {
        cost: { ...ANSWER_COST, models: ["openai/gpt-5-mini"] },
        result: { kind: "unparsed", reason: "the last message was not a review" },
      },
      {
        cost: { ...ANSWER_COST, models: ["openai/gpt-5-mini", "deepseek/deepseek-v4-pro"] },
        result: { kind: "reviewed", findings: [], verdicts: [] },
      },
    ),
  });

  assert.equal(ran.invocations.length, 2, "the fixture is a round that retried");
  assert.deepEqual(ran.state?.rounds.map((round) => round.models), [["openai/gpt-5-mini", "deepseek/deepseek-v4-pro"]]);
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
  // No reply answer either, and a reply that failed still resolves its thread.
  assert.deepEqual(ran.kinds, ["prlist", "threads", "diff", "reply", "resolve", "summary"]);
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
    "a failed round is reported by its failure comment, not as a summary of a review that did not finish",
  );
});

/**
 * Two episodes on one pull request each post their own comment, and neither
 * touches what is already there.
 *
 * A new worktree on the same branch is a second episode: its state file is
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
      reply: REPLIED,
      summary: SUMMARY_POSTED,
    },
    reviewer: reviews({ cost: wide, verdicts: [{ thread: "PRRT_one", verdict: "open", reason: "Still wrong." }] }),
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

/**
 * A round with no cost is recorded with no figures, and the token bound counts
 * nothing for it. Recorded as zeros, the summary would total it as a round that
 * spent nothing.
 */
test("a round with no cost is recorded with no figures, and counts nothing against the token bound", async () => {
  const ran = await runInFixture({
    config: { rounds: 8, tokens: 100_000 },
    answers: POSTING,
    reviewer: reviews({ cost: undefined, findings: [finding("The flag is never read")] }),
  });

  assert.ok(ran.conclusion.outcome === "block", `the round concluded ${ran.conclusion.outcome}`);
  assert.deepEqual(
    Object.keys(ran.state?.rounds[0] ?? { missing: true }).sort(),
    ["elapsedSeconds", "head", "postingSeconds", "raised", "reviewer", "ruled"],
    "a round with no cost was written with figures",
  );
});

// Copilot's tokens are input and output, as pi's are, so one bound means the
// same thing whichever CLI reviews.
test("a Copilot round with a cost is held to the token bound, its credits recorded beside the tokens", async () => {
  const wide: RoundCost = { dollars: 0, tokens: 400_000, messages: 12, credits: 3.5 };
  const ran = await runInFixture({
    config: { rounds: 8, tokens: 400_000 },
    answers: {
      prlist: PR_LIST,
      diff: DIFF,
      threads: listed([{ id: "PRRT_one", isResolved: false }]),
      unresolve: REOPENED,
      reply: REPLIED,
      summary: SUMMARY_POSTED,
    },
    reviewer: reviews({ cost: wide, verdicts: [{ thread: "PRRT_one", verdict: "open", reason: "Still wrong." }] }),
  });

  assert.ok(ran.conclusion.outcome === "close");
  assert.equal(ran.conclusion.because, "token-bound");
  assert.equal(ran.state?.rounds.at(-1)?.credits, 3.5);
  assert.ok(
    summaryBody(ran).includes("400,000 tokens over 1 round: 400,000 · 3.50 AI credits"),
    `the summary did not carry the round's credits: ${summaryBody(ran)}`,
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
    ["prlist", "threads", "diff", "failure"],
    "a round with no review posts nothing but its failure comment",
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
  assert.deepEqual(ran.kinds, ["prlist", "threads", "diff", "failure"]);
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
    assert.deepEqual(ran.kinds, ["prlist", "threads", "diff", "create", "lookup", "failure"]);
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
      reply: REPLIED,
    },
    reviewer: hangs(ANSWER_COST, { verdicts: [{ thread: "PRRT_one", verdict: "fixed" }] }),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.equal(ran.conclusion.failure, "timed-out");
  assert.deepEqual(
    ran.kinds,
    ["prlist", "threads", "diff", "reply", "resolve", "failure"],
    "the closed thread the reviewer never ruled on was re-opened, which reads a review that stopped early as a ruling that it is still wrong",
  );
  assert.deepEqual(
    ran.conclusion.salvaged?.verdicts.threads.map((applied) => applied.thread),
    ["PRRT_one"],
  );
  assert.deepEqual(
    ran.state?.rulings,
    { PRRT_one: "fixed" },
    "the failed round's ruling was not kept, or a thread it never reached was given one",
  );
});

test("a round that reported nothing before it failed posts only its failure comment", async () => {
  const ran = await runInFixture({
    config: { timeout: 1 },
    // Round 2, so a thread was handed over for a verdict the reviewer never gave.
    rounds: [ANSWER_COST],
    answers: {
      ...POSTING,
      threads: listed([{ id: "PRRT_two", isResolved: true }]),
      unresolve: REOPENED,
      reply: REPLIED,
    },
    reviewer: hangs(ANSWER_COST),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.equal(ran.conclusion.failure, "timed-out");
  assert.equal(ran.conclusion.salvaged, undefined, "there was nothing for the round to salvage");
  assert.deepEqual(ran.kinds, ["prlist", "threads", "diff", "failure"]);
});

/**
 * The posting a failed round does runs on the posting reserve, exactly as a
 * finished review's does.
 *
 * The reviewer here reports a finding, runs past its bound, and then ignores the
 * signal that would stop it, so the round spends the grace and the kill past the
 * moment the review had to be over by. That comes out of the reserve, which is
 * smaller here than the grace alone.
 */
test("a salvaged round's reserve loses what stopping the reviewer took past its bound", async () => {
  const ran = await runInFixture({
    postingMs: 500,
    config: { timeout: 2 },
    answers: POSTING,
    reviewer: reportsThenHolds(ANSWER_COST, [finding("The flag is never read")]),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.equal(ran.conclusion.failure, "timed-out");
  assert.deepEqual(
    ran.kinds.filter((kind) => kind === "create"),
    [],
    "the stop spent the reserve, so no call was left to make",
  );
  const outcome = ran.conclusion.salvaged?.findings.outcomes[0];
  assert.equal(outcome?.outcome, "failed", "a round that could not post is never a clean round");
  assert.match(
    outcome?.outcome === "failed" ? outcome.reason : "",
    /ran out before this call was made/u,
    "the reserve was gone before the posting started, and the round says so rather than reporting a comment it never wrote",
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
  assert.deepEqual(ran.episodesLeft, [], "an episode was opened with no pull request to key it");
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
  assert.deepEqual(ran.episodesLeft, [], "an episode was opened with no pull request to key it");
});

test("the episode a round opens is keyed by the number of the pull request it found", async () => {
  const ran = await runInFixture({
    answers: POSTING,
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.ok(ran.conclusion.outcome === "block");
  assert.deepEqual(ran.episodesLeft, [String(PULL_REQUEST)]);
  assert.equal(ran.state?.rounds.length, 1, "the round recorded nothing under the pull request's number");
});

test("a pull request number no JavaScript number holds exactly opens no episode", async () => {
  // GitHub's answer is the one thing the key comes from, and a number past the
  // exact range would be spelled as some other pull request's.
  const ran = await runInFixture({
    answers: { prlist: PR_LIST.replace(`"number":${PULL_REQUEST}`, '"number":1e300') },
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.equal(ran.conclusion.failure, "harness");
  assert.match(ran.conclusion.reason, /^no review ran: 1e\+300 is no pull request's number/u);
  assert.equal(ran.invocations.length, 0);
  assert.deepEqual(ran.kinds, ["prlist"]);
  assert.deepEqual(ran.episodesLeft, []);
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

test("threads that could not be listed end the round with nothing posted but the failure", async () => {
  const ran = await runInFixture({
    answers: { prlist: PR_LIST, diff: DIFF, create: CREATED, lookup: LOOKUP },
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.equal(ran.conclusion.failure, "harness");
  assert.match(ran.conclusion.reason, /the threads on PR #142 could not be listed/u);
  assert.deepEqual(ran.kinds, ["prlist", "threads", "failure"]);
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

test("a round none of whose findings could be posted fails, and never closes as clean (#426)", async () => {
  const ran = await runInFixture({
    answers: { prlist: PR_LIST, diff: DIFF, threads: listed([]), summary: SUMMARY_POSTED },
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.ok(ran.conclusion.outcome === "failed", `the round concluded ${ran.conclusion.outcome}`);
  assert.equal(ran.conclusion.reason, "round 1 found 1 finding and could not post it to PR #142");
  assert.deepEqual(ran.conclusion.salvaged?.posted, []);
  assert.equal(ran.conclusion.salvaged?.findings.outcomes[0]?.outcome, "failed");
  assert.equal(ran.kinds.includes("summary"), false, "a summary was posted for a round that handed nothing over");
});

test("the posting reserve bounds every call the round makes after the review", async () => {
  const ran = await runInFixture({
    postingMs: 2,
    answers: POSTING,
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.ok(ran.conclusion.outcome === "failed", `the round concluded ${ran.conclusion.outcome}`);
  const outcome = ran.conclusion.salvaged?.findings.outcomes[0];
  assert.equal(outcome?.outcome, "failed");
  assert.match(
    outcome?.outcome === "failed" ? outcome.reason : "",
    /did not answer within|ran out before this call was made/u,
    "a round that kept posting past the reserve would have no bound on its posting at all",
  );
});

/**
 * The reviewer answers at once and the round then spends the grace and the kill
 * stopping it, which lands past the moment the review had to be over by. The
 * reserve is counted from that moment, so the overrun comes out of it rather
 * than being added to the round.
 *
 * The summary is on the same terms as the findings. It is the last thing the round
 * would send, so it is the first thing a spent reserve costs.
 */
test("a review whose stop ran past its bound leaves the posting what is left of the reserve", async () => {
  const ran = await runInFixture({
    // A bound the reviewer's own cleanup runs past by more than the reserve.
    config: { timeout: 1 },
    postingMs: 500,
    answers: POSTING,
    reviewer: answersThenHolds([finding("The flag is never read")]),
  });

  assert.ok(ran.conclusion.outcome === "failed", "a round that could not post is never a clean round");
  const outcome = ran.conclusion.salvaged?.findings.outcomes[0];
  assert.equal(outcome?.outcome, "failed");
  assert.match(
    outcome?.outcome === "failed" ? outcome.reason : "",
    /ran out before this call was made/u,
    "the reserve was gone before the posting started, and the round says so rather than reporting a comment it never wrote",
  );
  assert.deepEqual(ran.kinds, ["prlist", "threads", "diff"], "the stop spent the reserve, so no call was left to make");
  assert.ok(ran.conclusion.failureComment?.posting.outcome === "failed", "the failure comment was posted past the reserve");
  assert.match(
    ran.conclusion.failureComment.posting.reason,
    /ran out before this call was made/u,
    "the round has to say why its failure went unposted for the pointer to name it",
  );
});

/** How many pages the threads listing is offered before it must stop itself. */
const OFFERED_PAGES = 30;

/**
 * The calls before the review are bounded as a part rather than one at a time.
 *
 * The listing pages, so the part makes a number of calls nobody knows in
 * advance, and a bound per call lets every one of them have the whole of one.
 */
test("the calls before the review share one deadline, and the part ends inside it", async () => {
  const ran = await runInFixture({
    preReviewMs: 1_000,
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
  assert.equal(ran.invocations.length, 0, "a part that ran out of time starts no reviewer");
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
    `the round took ${ran.elapsedMs}ms, which is a part spending its calls' bounds one after another`,
  );
});

/**
 * The gate is the round's quietest exit: no pull request means exit 0 with
 * nothing posted and nothing said. A lookup the deadline stopped must not reach
 * it, or a round decides in silence that there was nothing to review.
 */
test("a pull request lookup that ran out of time fails the round rather than reading as no pull request", async () => {
  const ran = await runInFixture({
    preReviewMs: 1,
    answers: POSTING,
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.equal(ran.conclusion.failure, "harness");
  assert.match(ran.conclusion.reason, /the pull request for "review-me" could not be looked up/u);
  assert.equal(ran.invocations.length, 0);
});

test("a review is bounded by the configured timeout, whatever the calls before it took", async () => {
  const clock = stoppedClock();
  const ran = await runInFixture({
    clock,
    config: { timeout: 900 },
    answers: FAILING,
    reviewer: hangsUntil(clock, 900_000),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.equal(ran.conclusion.failure, "timed-out");
  assert.match(ran.conclusion.reason, /killed at its 900-second bound/u);
  assert.equal(ran.state?.rounds[0]?.cutShortAtSeconds, 900);
});

/**
 * The posting reserve is counted from the end of the review rather than from the
 * start of the round. Counted from the start, a review that ran its whole bound
 * would leave nothing to post its findings in.
 */
test("a review that ran its whole bound still has the posting reserve to post in", async () => {
  const clock = stoppedClock();
  const ran = await runInFixture({
    clock,
    config: { timeout: 900 },
    answers: FAILING,
    reviewer: hangsUntil(clock, 900_000, [finding("The flag is never read")]),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.equal(ran.conclusion.failure, "timed-out");
  assert.equal(ran.conclusion.salvaged?.findings.outcomes[0]?.outcome, "threaded");
  assert.deepEqual(ran.kinds, ["prlist", "threads", "diff", "create", "lookup", "failure"]);
});

/**
 * Stopping the reviewer runs after the review's deadline. What it takes past
 * that comes out of the posting reserve rather than being added to the round.
 */
test("time spent stopping the reviewer past its bound comes out of the posting reserve", async () => {
  const clock = stoppedClock();
  const ran = await runInFixture({
    clock,
    config: { timeout: 900 },
    answers: FAILING,
    // Sixty-one seconds past the bound, which is more than the whole reserve.
    reviewer: hangsUntil(clock, 961_000, [finding("The flag is never read")]),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.equal(ran.conclusion.failure, "timed-out");
  assert.deepEqual(ran.kinds, ["prlist", "threads", "diff"], "the stop spent the reserve, so nothing was posted");
  const outcome = ran.conclusion.salvaged?.findings.outcomes[0];
  assert.match(outcome?.outcome === "failed" ? outcome.reason : "", /ran out before this call was made/u);
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
  // The state file this fixture wrote records no close, which is what an
  // interruption between the cost and the close leaves. The round lists the
  // threads and posts the summary the close owes.
  assert.deepEqual(ran.kinds, ["prlist", "threads", "summary"]);
  assert.deepEqual(ran.conclusion.summary, { outcome: "posted" });
  assert.equal(ran.state?.rounds.length, 3, "and no fourth round is appended to the count");
});

/**
 * A cap lowered between firings closes the episode with its summary.
 *
 * The first firing reviews under a cap of 3, posts its finding and blocks, so
 * nothing has closed the episode and nothing has reported it. The cap is 1 by the
 * next firing, which finds the bound already spent. It starts no review, and it
 * lists the episode's threads and posts the summary from them. A close that
 * posted nothing here would leave findings on the pull request with no comment
 * reporting them.
 */
test("a cap lowered after a round blocked lists the threads and posts the summary, naming the cap", async () => {
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
    answers: { ...POSTING, threads: listed([{ id: "PRRT_new", isResolved: false }]) },
    reviewer: reviews({}),
  });

  assert.ok(closed.conclusion.outcome === "close");
  assert.equal(closed.conclusion.because, "round-cap");
  assert.equal(closed.invocations.length, 0, "a cap already spent starts no reviewer");
  assert.deepEqual(closed.kinds, ["prlist", "threads", "summary"]);
  assert.deepEqual(closed.conclusion.summary, { outcome: "posted" });
  assert.deepEqual(closed.conclusion.beforeReview?.openThreads, ["PRRT_new"]);
  assert.equal(closed.state?.closeReported, true);
  const body = summaryBody(closed);
  assert.match(body, /^\*\*Squiz review — 1 round, 1 finding\*\*/u);
  assert.match(body, /Fixed 0 · Withdrawn 0 · Open 1 · Disputed 0/u);
  assert.match(body, /- `src\/ui\/card\.ts:88` — The name says nothing\. \(open\)/u);
  assert.match(
    body,
    /\*\*Notes\*\*\n\n- The episode ended at its round cap rather than with nothing left open/u,
    `the summary did not name the cap that closed the episode: ${body}`,
  );
});

/**
 * The last round to reach its end left the episode open with a finding no thread
 * holds, and the round after it failed. Nothing has settled that finding, and
 * the close before the review is the episode's only comment.
 */
test("#606: a close before the review names the findings no thread holds that the last round reaching its end left", async () => {
  const left = "About the change as a whole: The retry queue duplicates the scheduler";
  const ran = await runInFixture({
    config: { rounds: 2 },
    stateSource: JSON.stringify({
      rounds: [ANSWER_COST, ANSWER_COST],
      spentOutsideRounds: unspent,
      records: [
        {
          head: "3f9c2e07b1d4a8c6e5f0923b7a1d6c4e8b2f5a90",
          activity: null,
          status: "reviewed",
          result: "exited",
          exitStatus: 2,
          openThreads: ["PRRT_new"],
          round: { number: 1, startedAt: 1, endedAt: 2, reviewer: { backend: "detached" } },
          unthreaded: [left],
        },
        {
          head: "8d21a4f0c3b2e1d4a5f6b7c8d9e0f1a2b3c4d5e6",
          activity: null,
          status: "failed",
          reason: "the reviewer was stopped at the time bound",
          ownerNoted: false,
          round: { number: 2, startedAt: 3, endedAt: 4 },
        },
      ],
    }),
    answers: { ...POSTING, threads: listed([{ id: "PRRT_new", isResolved: false }]) },
    reviewer: reviews({}),
  });

  assert.ok(ran.conclusion.outcome === "close", `concluded ${JSON.stringify(ran.conclusion)}`);
  const body = summaryBody(ran);
  assert.match(body, /^\*\*Squiz review — 2 rounds, 2 findings\*\*/u);
  assert.ok(body.includes(`**Notes**\n\n- ${left}\n`), `the summary did not name the earlier finding: ${body}`);
});

/**
 * A round that reviews read the whole change again, so the finding an earlier
 * round left on no thread is either raised again by it or no longer found.
 */
test("#606: a round that reviews and closes settles an earlier round's findings no thread holds", async () => {
  const ran = await runInFixture({
    config: { rounds: 2 },
    stateSource: JSON.stringify({
      rounds: [ANSWER_COST],
      spentOutsideRounds: unspent,
      records: [
        {
          head: "3f9c2e07b1d4a8c6e5f0923b7a1d6c4e8b2f5a90",
          activity: null,
          status: "reviewed",
          result: "exited",
          exitStatus: 2,
          openThreads: [],
          round: { number: 1, startedAt: 1, endedAt: 2, reviewer: { backend: "detached" } },
          unthreaded: ["About the change as a whole: The retry queue duplicates the scheduler"],
        },
      ],
    }),
    answers: POSTING,
    reviewer: reviews({}),
  });

  assert.ok(ran.conclusion.outcome === "close", `concluded ${JSON.stringify(ran.conclusion)}`);
  assert.doesNotMatch(summaryBody(ran), /retry queue/u);
});

/**
 * The round that rules a thread withdrawn records the ruling, and a later close
 * that runs no reviewer counts the thread by it. Every resolved thread once
 * counted fixed, so a fixed thread alone passes against that code.
 */
test("#627: a close before the review counts a thread an earlier round withdrew as withdrawn", async () => {
  const ruled = await runInFixture({
    config: { rounds: 3 },
    answers: {
      ...POSTING,
      threads: listed([
        { id: "PRRT_argued", isResolved: false },
        { id: "PRRT_mended", isResolved: false },
      ]),
      resolve: RESOLVED,
      reply: REPLIED,
    },
    reviewer: reviews({
      findings: [finding("The flag is never read")],
      verdicts: [
        { thread: "PRRT_argued", verdict: "withdrawn", reason: "The argument holds." },
        { thread: "PRRT_mended", verdict: "fixed" },
      ],
    }),
  });
  assert.ok(ruled.conclusion.outcome === "block", `concluded ${JSON.stringify(ruled.conclusion)}`);
  assert.deepEqual(ruled.state?.rulings, { PRRT_argued: "withdrawn", PRRT_mended: "fixed" });

  const closed = await runInFixture({
    config: { rounds: 1 },
    stateSource: ruled.stateSource ?? "",
    answers: {
      ...POSTING,
      threads: listed([
        { id: "PRRT_argued", isResolved: true },
        { id: "PRRT_mended", isResolved: true },
        { id: "PRRT_new", isResolved: false },
      ]),
    },
    reviewer: reviews({}),
  });

  assert.ok(closed.conclusion.outcome === "close", `concluded ${JSON.stringify(closed.conclusion)}`);
  assert.equal(closed.invocations.length, 0, "a cap already spent starts no reviewer");
  assert.match(summaryBody(closed), /Fixed 1 · Withdrawn 1 · Open 1 · Disputed 0\n/u);
});

/**
 * The round's rulings go into the state before anything is posted. Written
 * after the posting, a write that failed there left the earlier `fixed` on
 * record for a thread GitHub had just closed as withdrawn.
 */
test("#627: a round's rulings are on record before its verdicts reach the pull request", async () => {
  const ran = await runInFixture({
    config: { rounds: 3 },
    stateSource: JSON.stringify({ rounds: [ANSWER_COST], spentOutsideRounds: unspent, rulings: { PRRT_argued: "fixed" } }),
    answers: { ...POSTING, threads: listed([{ id: "PRRT_argued", isResolved: true }]), resolve: RESOLVED },
    lockStateAfter: "resolve",
    reviewer: reviews({
      findings: [finding("The flag is never read")],
      verdicts: [{ thread: "PRRT_argued", verdict: "withdrawn", reason: "The argument holds." }],
    }),
  });

  assert.ok(ran.kinds.includes("resolve"), `the withdrawal was never sent: ${ran.kinds.join(", ")}`);
  assert.deepEqual(ran.state?.rulings, { PRRT_argued: "withdrawn" });
});

/**
 * A resolved thread the state holds no ruling for was resolved by a person, or
 * in an episode whose state this worktree does not have. Neither says it was
 * fixed. A thread last ruled open and resolved since is the same.
 */
test("#627: a close before the review counts a resolved thread with no fixed or withdrawn ruling on record apart", async () => {
  const ran = await runInFixture({
    config: { rounds: 1 },
    stateSource: JSON.stringify({ rounds: [ANSWER_COST], spentOutsideRounds: unspent, rulings: { PRRT_kept: "open" } }),
    answers: {
      ...POSTING,
      threads: listed([
        { id: "PRRT_done", isResolved: true },
        { id: "PRRT_kept", isResolved: true },
        { id: "PRRT_left", isResolved: false },
        { id: "PRRT_person", isResolved: false, opening: PERSON_WROTE },
      ]),
    },
    reviewer: reviews({}),
  });

  assert.ok(ran.conclusion.outcome === "close");
  assert.deepEqual(ran.conclusion.beforeReview?.openThreads, ["PRRT_left"], "a person's thread is no finding of the review");
  const body = summaryBody(ran);
  assert.match(body, /^\*\*Squiz review — 1 round, 3 findings\*\*/u);
  assert.match(body, /Fixed 0 · Withdrawn 0 · Open 1 · Disputed 0 · Resolved, ruling unknown 2\n/u);
  assert.doesNotMatch(body, /src\/ui\/card\.ts:88` — .*\(resolved/u, "a resolved thread needs no person");
});

/**
 * A round the time bound killed records its floor, and a floor at the token
 * bound closes the episode at the next firing. That firing runs no reviewer, and
 * posts the summary naming the bound and the round the bound cut short.
 */
test("a killed round whose floor reached the token bound closes the episode at the next firing, with its summary", async () => {
  const clock = stoppedClock();
  const ran = await runInFixture({
    clock,
    config: { timeout: 900, tokens: ANSWER_COST.tokens },
    answers: FAILING,
    sequences: THREADS_OF_TWO_ROUNDS,
    reviewer: hangsUntil(clock, 900_000, [finding("The flag is never read")]),
    andThen: [{ reviewer: reviews({}) }],
  });

  const [killed, closed] = ran.conclusions;
  assert.ok(killed?.outcome === "failed");
  assert.equal(killed.failure, "timed-out");
  assert.ok(closed?.outcome === "close", `the second firing concluded ${JSON.stringify(closed)}`);
  assert.equal(closed.because, "token-bound");
  assert.equal(ran.invocations.length, 1, "the firing after the bound was reached started a reviewer");
  assert.deepEqual(closed.summary, { outcome: "posted" });
  const body = summaryBody(ran);
  assert.match(body, /Open 1/u);
  assert.match(body, /- The review was cut short by the 900-second time bound in round 1/u);
  assert.match(body, /- The episode ended at the token bound rather than with nothing left open/u);
});

/**
 * An episode whose failed attempts spent the token bound before any round ran,
 * and left none of the reviewer's threads, closes with no summary. There is
 * nothing for one to report, and the close says why there is none.
 */
test("a bound spent before any round ran, with no thread of the reviewer's, closes with no summary and says so", async () => {
  const ran = await runInFixture({
    config: { tokens: 1000 },
    rounds: [],
    outsideRounds: { dollars: 0, tokens: 1000, messages: 1 },
    answers: { ...POSTING, threads: listed([{ id: "PRRT_person", isResolved: false, opening: PERSON_WROTE }]) },
    reviewer: reviews({}),
  });

  assert.ok(ran.conclusion.outcome === "close");
  assert.equal(ran.conclusion.because, "token-bound");
  assert.deepEqual(ran.kinds, ["prlist", "threads"], "a summary was posted for an episode with nothing to report");
  assert.deepEqual(ran.conclusion.summary, {
    outcome: "never-composed",
    reason: "the episode closed before any round ran",
  });
  assert.equal(ran.state?.closeReported, true);
});

/**
 * An attempt that was no round can still have posted the findings it salvaged.
 * An episode whose bound such attempts spent closes with the summary of them.
 */
test("a bound spent before any round ran, with a thread of the reviewer's, posts the summary", async () => {
  const ran = await runInFixture({
    config: { tokens: 1000 },
    rounds: [],
    outsideRounds: { dollars: 0, tokens: 1000, messages: 1 },
    answers: { ...POSTING, threads: listed([{ id: "PRRT_salvaged", isResolved: false }]) },
    reviewer: reviews({}),
  });

  assert.ok(ran.conclusion.outcome === "close");
  assert.deepEqual(ran.conclusion.summary, { outcome: "posted" });
  assert.deepEqual(ran.conclusion.beforeReview?.openThreads, ["PRRT_salvaged"]);
  const body = summaryBody(ran);
  assert.match(body, /^\*\*Squiz review — 0 rounds, 1 finding\*\*/u);
  assert.match(body, /- The episode ended at the token bound rather than with nothing left open/u);
});

/**
 * A close before the review whose threads cannot be listed records no close and
 * posts nothing. A summary composed from part of the threads would report the
 * rest as never raised, so the round fails, and a run of `squiz review` retries
 * it.
 */
test("a cap already spent whose threads cannot be listed fails, and records no close", async () => {
  const ran = await runInFixture({
    config: { rounds: 1 },
    rounds: [ANSWER_COST],
    answers: { ...POSTING, threads: "not a response" },
    postsFailure: false,
    reviewer: reviews({}),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.match(ran.conclusion.reason, /^no review ran: the threads on PR #142 could not be listed: /u);
  assert.deepEqual(ran.kinds, ["prlist", "threads"]);
  assert.notEqual(ran.state?.closeReported, true);
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
  assert.deepEqual(
    again.kinds,
    ["prlist"],
    "an episode that is over asks GitHub which pull request keys it, and nothing else",
  );
});

/**
 * Two rounds of one episode that overlap run one review between them.
 *
 * Two subagents that stop at once in one worktree fire on one pull request, so
 * their rounds share one episode. Each would read the state before the other
 * recorded anything, pass the cap, start a reviewer and post a summary, and the
 * later write would drop the earlier round's cost.
 */
test("two overlapping rounds of one episode run one review, post one summary and record its cost", async () => {
  const ran = await runInFixture({
    overlapping: 2,
    config: { rounds: 1 },
    answers: POSTING,
    // Slow enough that the second round starts while the first is reviewing.
    reviewer: { command: "/bin/sh", args: ["-c", "sleep 1"], parse: reviews({}).parse },
  });

  assert.equal(ran.invocations.length, 1, "both rounds started a reviewer");
  const summaries = ran.calls.filter((call) => call.kind === "summary");
  assert.equal(summaries.length, 1, "both rounds posted a summary");
  assert.deepEqual(
    ran.conclusions.map((conclusion) => conclusion.outcome).sort(),
    ["close", "round-running"],
  );
  assert.deepEqual(ran.state?.rounds.map((round) => round.tokens), [ANSWER_COST.tokens]);
  assert.equal(ran.lockLeft, false, "the lock outlived the round");
});

/**
 * A lock whose holder cannot be told running or gone is never taken for free.
 * Something made it, and nothing says that something has stopped.
 */
test("a lock nobody can read runs no review, and says why", async () => {
  const ran = await runInFixture({
    lockSource: "not a holder\n",
    answers: POSTING,
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.equal(ran.conclusion.failure, "harness");
  assert.match(
    ran.conclusion.reason,
    /^no review ran: whether a round is already running on PR #142 could not be told: .*names no pid and start time/u,
  );
  assert.equal(ran.invocations.length, 0, "a reviewer ran beside a holder nobody could rule out");
  assert.deepEqual(ran.kinds, ["prlist"]);
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
  assert.deepEqual(again.kinds, ["prlist"]);
  assert.deepEqual(
    again.state?.rounds,
    closed.state?.rounds,
    "and no round is appended to an episode that is over",
  );
});

/**
 * A close before the review records itself, so its summary is posted once.
 *
 * The first firing finds its cap already spent and posts the summary. The second
 * is an episode that is over, and a summary posted again on every firing would
 * put a second comment on one episode.
 */
test("a close before the review records itself, and its summary is not posted twice", async () => {
  const first = await runInFixture({
    config: { rounds: 1 },
    rounds: [ANSWER_COST],
    answers: POSTING,
    reviewer: reviews({}),
  });

  assert.ok(first.conclusion.outcome === "close");
  assert.equal(first.conclusion.because, "round-cap");
  assert.deepEqual(first.conclusion.summary, { outcome: "posted" });
  assert.equal(first.state?.closeReported, true, "a close that ends the episode records it");

  const again = await runInFixture({
    config: { rounds: 1 },
    rounds: first.state?.rounds ?? [],
    closeReported: first.state?.closeReported,
    answers: POSTING,
    reviewer: reviews({}),
  });

  assert.deepEqual(again.conclusion, { outcome: "episode-over" });
  assert.deepEqual(again.kinds, ["prlist"]);
});

/**
 * A close whose record could not be written posts no summary, and is a failed
 * round rather than a close.
 *
 * The episode's directory stops taking writes once the round's finding is up,
 * which is after its cost is recorded and before its end is. That is the shape a
 * full disk and a directory turned read-only both leave. A summary posted for a
 * close nothing recorded would be followed by a second one from the next firing,
 * which reads the episode as open.
 */
test("a close that could not record itself posts no summary, and the next firing closes it", async () => {
  const ran = await runInFixture({
    config: { rounds: 2 },
    rounds: [ANSWER_COST],
    answers: POSTING,
    lockStateAfter: "lookup",
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.equal(ran.conclusion.failure, "harness");
  assert.match(
    ran.conclusion.reason,
    /the round's end could not be recorded: .*could not be written/u,
    "the filesystem's own error is what a person has to act on",
  );
  assert.deepEqual(ran.conclusion.salvaged?.posted, ["PRRT_new"], "the finding that landed is still reported");
  assert.ok(!ran.kinds.includes("summary"), "no summary goes up for a close nothing recorded");
  assert.notEqual(ran.state?.closeReported, true);

  // The next firing of that episode, its directory writable again. The cap is
  // spent, so it closes before a reviewer starts and records the close.
  const again = await runInFixture({
    config: { rounds: 2 },
    rounds: ran.state?.rounds ?? [],
    answers: POSTING,
    reviewer: reviews({}),
  });

  assert.ok(again.conclusion.outcome === "close");
  assert.equal(again.conclusion.because, "round-cap");
  assert.deepEqual(again.invocations, [], "a round the cap has spent runs no reviewer");
  assert.equal(again.state?.closeReported, true);
});

/**
 * A close taken before a reviewer starts, whose record could not be written,
 * is a failed round that posts nothing, and the next firing closes the episode
 * again (#495).
 *
 * The episode's directory stops taking writes once the threads are listed, which
 * is before the close is recorded. The host lock is already held, as the round
 * host holds it, so the round has no lock of its own to take there.
 */
test("a cap already spent whose close could not be recorded posts nothing, and the next firing closes it (#495)", async () => {
  const ran = await runInFixture({
    config: { rounds: 1 },
    rounds: [ANSWER_COST],
    answers: POSTING,
    lockStateAfter: "threads",
    heldByHost: true,
    postsFailure: false,
    reviewer: reviews({}),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.equal(ran.conclusion.failure, "harness");
  assert.match(ran.conclusion.reason, /^the episode's close could not be recorded: .*could not be written/u);
  assert.deepEqual(ran.kinds, ["prlist", "threads"], "nothing is posted after a close that was not recorded");
  assert.notEqual(ran.state?.closeReported, true);

  const again = await runInFixture({
    config: { rounds: 1 },
    rounds: ran.state?.rounds ?? [],
    answers: POSTING,
    reviewer: reviews({}),
  });

  assert.ok(again.conclusion.outcome === "close");
  assert.deepEqual(again.conclusion.summary, { outcome: "posted" });
  assert.deepEqual(again.invocations, [], "a round the cap has spent runs no reviewer");
  assert.equal(again.state?.closeReported, true);
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

test("a read-back that pages is stopped by the reserve, not by its own page limit", async () => {
  const ran = await runInFixture({
    postingMs: 500,
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
    `the read-back made all ${lookups} of its pages, so the reserve bounded each request and none of them together`,
  );
  assert.ok(ran.conclusion.outcome === "close");
  const outcome = ran.conclusion.findings.outcomes[0];
  assert.equal(
    outcome?.outcome,
    "threaded",
    "the create completed, and an outcome already completed is kept when the reserve runs out",
  );
  assert.equal(
    outcome?.outcome === "threaded" ? outcome.threadId : "unread",
    null,
    "the pages that would have named the thread were past the reserve, so nothing can be addressed to it",
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

test("a reviewer that ran before its start failed spends the tokens that stop the next round", async () => {
  const paid: RoundCost = { dollars: 0.04, tokens: 410_000, messages: 1 };
  const bounds = { rounds: 8, tokens: 400_000 };

  const first = await runInFixture({
    config: bounds,
    answers: { prlist: PR_LIST, diff: DIFF, threads: listed([]) },
    reviewer: attempts({ cost: paid, result: { kind: "unparsed", reason: "the review was not finished" } }),
    sessionBackends: startsThenFails(),
  });

  assert.ok(first.conclusion.outcome === "failed");
  assert.equal(first.conclusion.failure, "setup");
  assert.deepEqual(first.state?.rounds, [], "a start that failed spends no round");
  assert.deepEqual(
    first.state?.spentOutsideRounds,
    { ...paid, floor: true },
    "the reviewer completed a paid response before its start was given up on",
  );

  const next = await runInFixture({
    config: bounds,
    rounds: first.state?.rounds ?? [],
    ...(first.state === null ? {} : { outsideRounds: first.state.spentOutsideRounds }),
    answers: POSTING,
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.ok(next.conclusion.outcome === "close");
  assert.equal(next.conclusion.because, "token-bound");
  assert.equal(next.invocations.length, 0, "the tokens the failed start spent buy no further reviewer");
});

test("an attempt the harness threw out of spends the tokens that stop the next round", async () => {
  const paid: RoundCost = { dollars: 0.04, tokens: 410_000, messages: 1 };
  const bounds = { rounds: 8, tokens: 400_000 };

  const first = await runInFixture({
    config: bounds,
    answers: { prlist: PR_LIST, diff: DIFF, threads: listed([]) },
    reviewer: attempts({ cost: paid, result: { kind: "unparsed", reason: "the review was not finished" } }),
    sessionBackends: startsBroken(),
  });

  assert.ok(first.conclusion.outcome === "failed");
  assert.equal(first.conclusion.failure, "setup");
  assert.deepEqual(first.state?.rounds, [], "an attempt the harness threw out of spends no round");
  assert.deepEqual(first.state?.spentOutsideRounds, { ...paid, floor: true });

  const next = await runInFixture({
    config: bounds,
    rounds: first.state?.rounds ?? [],
    ...(first.state === null ? {} : { outsideRounds: first.state.spentOutsideRounds }),
    answers: POSTING,
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.ok(next.conclusion.outcome === "close");
  assert.equal(next.conclusion.because, "token-bound");
  assert.equal(next.invocations.length, 0, "the tokens the thrown attempt spent buy no further reviewer");
});

test("a reviewer that ran before its start failed and reported no cost leaves its spend marked unknown", async () => {
  const first = await runInFixture({
    answers: { prlist: PR_LIST, diff: DIFF, threads: listed([]) },
    reviewer: attempts({ cost: undefined, result: { kind: "incomplete", reason: "no usage line" } }),
    sessionBackends: startsThenFails(),
  });

  assert.ok(first.conclusion.outcome === "failed");
  assert.deepEqual(
    first.state?.spentOutsideRounds,
    { dollars: 0, tokens: 0, messages: 0, floor: true },
    "a reviewer that ran may have spent what it never reported, and a bare zero says it spent nothing",
  );
});

/**
 * Backends that run the reviewer with no terminal to its end, and then report
 * the start failed, as one does whose reading of the reviewer's identity failed
 * after the reviewer ran.
 */
function startsThenFails(): Backends {
  return {
    herdr: () => ({ outcome: "refused", reason: "not asked" }),
    tmux: () => ({ outcome: "refused", reason: "not asked" }),
    child: async (command, environment, boundMs) => {
      const started = await startChild(command, environment, boundMs);
      if (started.outcome !== "started") return started;
      await new Promise((settle) => started.child.once("exit", settle));
      return { outcome: "failed", reason: "ps could not be run: a stand-in for ps failing", ran: true };
    },
  };
}

/**
 * Backends that run the reviewer to its end and then hand the round a process
 * with no stderr, which the round throws reading.
 */
function startsBroken(): Backends {
  return {
    herdr: () => ({ outcome: "refused", reason: "not asked" }),
    tmux: () => ({ outcome: "refused", reason: "not asked" }),
    child: async (command, environment, boundMs) => {
      const started = await startChild(command, environment, boundMs);
      if (started.outcome !== "started") return started;
      await new Promise((settle) => started.child.once("exit", settle));
      const broken = new Proxy(started.child, {
        get: (target, property) => (property === "stderr" ? undefined : Reflect.get(target, property)),
      });
      return { ...started, child: broken };
    },
  };
}

test("the reviewer runs in a snapshot of the head commit", async () => {
  const ran = await runInFixture({ answers: POSTING, reviewer: reviews({}) });

  const directory = ran.invocations[0]?.directory ?? "";
  assert.equal(directory, snapshotPath(ran.worktree, { pullRequest: PULL_REQUEST, round: 1 }));
  assert.deepEqual(ran.headsWhenStarted, [ran.head], "the snapshot holds the head commit");
});

test("a change made in the reviewer's snapshot leaves the coding agent's worktree alone", async () => {
  const ran = await runInFixture({
    answers: POSTING,
    reviewer: writesThenReviews([finding("The flag is never read")]),
    andThen: [
      {
        before: (worktree) =>
          assert.equal(
            readFileSync(join(worktree, TRACKED), "utf8"),
            "// line 1\n",
            "the reviewer wrote to the coding agent's worktree",
          ),
        reviewer: reviews({}),
      },
    ],
  });

  assert.equal(ran.conclusions[0]?.outcome, "block");
});

test("a snapshot stands until the round's result is posted, and is gone once the round ends", async () => {
  const ran = await runInFixture({
    answers: POSTING,
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.ok(ran.conclusion.outcome === "block");
  assert.deepEqual(ran.headsWhenStarted, [ran.head]);
  assert.equal(ran.snapshotAtCall.at(-1), true, "the snapshot is removed after the result, not before");
  assert.deepEqual(ran.snapshotsLeft, []);
  assert.equal(ran.worktreesLeft.length, 1, `git still lists a snapshot: ${ran.worktreesLeft.join(", ")}`);
});

const FLOOR: RoundCost = { dollars: 0.02, tokens: 700, messages: 1 };

for (const [became, reviewer] of Object.entries({
  failed: unreadable(FLOOR),
  "was killed at its bound": hangs(FLOOR),
  "never started": notInstalled,
})) {
  test(`a snapshot is removed when the reviewer ${became}`, async () => {
    const ran = await runInFixture({ config: { timeout: 1 }, answers: FAILING, reviewer });

    assert.ok(ran.conclusion.outcome === "failed");
    assert.ok(ran.invocations.length > 0, "the round got as far as the reviewer");
    assert.deepEqual(ran.snapshotsLeft, [], "the snapshot outlived the round");
    assert.equal(ran.worktreesLeft.length, 1, `git still lists a snapshot: ${ran.worktreesLeft.join(", ")}`);
  });
}

test("a snapshot that cannot be made runs no review, and what the add left is removed", async () => {
  const ran = await runInFixture({ snapshotAddFails: true, answers: FAILING, reviewer: reviews({}) });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.equal(ran.conclusion.failure, "harness");
  assert.match(ran.conclusion.reason, /^no review ran: the snapshot could not be made at /u);
  assert.deepEqual(ran.invocations, [], "no reviewer starts without its snapshot");
  assert.deepEqual(ran.kinds, ["prlist", "threads", "diff", "failure"]);
  assert.deepEqual(ran.snapshotsLeft, [], "what the failed add made is removed with the round");
  assert.equal(ran.worktreesLeft.length, 1, `git still lists a snapshot: ${ran.worktreesLeft.join(", ")}`);
});

test("a head commit the repository cannot get runs no review", async () => {
  const missing = "0123456789abcdef0123456789abcdef01234567";
  const ran = await runInFixture({
    answers: { ...FAILING, prlist: PR_LIST.replace(HEAD_SHA, missing) },
    reviewer: reviews({}),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.match(ran.conclusion.reason, new RegExp(`^no review ran: ${missing} could not be fetched: `, "u"));
  assert.deepEqual(ran.invocations, []);
  assert.deepEqual(ran.snapshotsLeft, []);
});

// A round that posted its findings and recorded nothing is one the next round
// repeats comment for comment.
test("a cost that could not be recorded posts none of the findings", async () => {
  const ran = await runInFixture({
    answers: POSTING,
    reviewer: locksTheState(),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.equal(ran.conclusion.failure, "harness");
  assert.match(ran.conclusion.reason, /nothing the reviewer found was posted/u);
  assert.deepEqual(
    ran.kinds,
    ["prlist", "threads", "diff", "failure"],
    "nothing the reviewer found is posted on a state file that would not take the round",
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

test("a round that posted records how long its posting took", async () => {
  const ran = await runInFixture({
    config: { rounds: 1 },
    delays: { create: "0.5" },
    answers: POSTING,
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.ok(ran.conclusion.outcome === "close");
  const posting = ran.state?.rounds[0]?.postingSeconds;
  assert.ok(
    posting !== undefined && posting >= 0.5,
    `a posting that waited half a second on its create recorded ${posting ?? "no"} seconds`,
  );
});

test("a round that posted nothing records no posting time", async () => {
  const ran = await runInFixture({
    config: { timeout: 1 },
    answers: FAILING,
    postsFailure: false,
    reviewer: hangs(ANSWER_COST),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.deepEqual(ran.kinds, ["prlist", "threads", "diff"]);
  assert.equal(ran.state?.rounds.length, 1);
  assert.equal(ran.state?.rounds[0]?.postingSeconds, undefined);
});

/** The failure comment GitHub created: an issue comment, like the summary. */
const FAILURE_POSTED = included("201 Created", JSON.stringify({
  id: 2140876532,
  node_id: "IC_kwDOUEd2qM7q-4A8",
  html_url: `https://github.com/o/r/pull/${PULL_REQUEST}#issuecomment-2140876532`,
}));

/** Everything a failed round that salvaged one finding needs answering. */
const FAILING: Answers = { ...POSTING, failure: FAILURE_POSTED };

/** The body of the one failure comment the round posted. */
function failureBody(ran: Ran): string {
  const posted = ran.calls.filter((call) => call.kind === "failure");
  assert.equal(posted.length, 1, "a failed round posts one failure comment");
  return sent(posted[0]?.body ?? "");
}

/**
 * A reviewer that reports its findings, declares its review finished, and is
 * then cut at the bound while it writes its closing message.
 */
function declaresThenHangs(cost: RoundCost, findings: readonly Finding[]): Reviewer {
  return {
    command: "/bin/sh",
    args: ["-c", "sleep 30"],
    parse: async (_stdout, progressSoFar): Promise<ParsedRun> => {
      progressSoFar?.({
        cost,
        findings,
        verdicts: [],
        refusals: 0,
        finished: true,
        broken: undefined,
      });
      await new Promise<never>(() => {});
      throw new Error("the round read a parse that never finished");
    },
  };
}

test("a failed round posts one failure comment after what it salvaged, naming the reason", async () => {
  const ran = await runInFixture({
    config: { timeout: 1 },
    answers: FAILING,
    reviewer: hangs(ANSWER_COST, { findings: [finding("The flag is never read")] }),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.deepEqual(
    ran.kinds,
    ["prlist", "threads", "diff", "create", "lookup", "failure"],
    "the failure comment goes up after the salvaged findings, and once",
  );
  assert.match(ran.calls.at(-1)?.argv ?? "", /issues\/142\/comments/u);
  const [first, ...rest] = failureBody(ran).split("\n");
  assert.equal(first, `**Squiz review failed — ${ran.conclusion.reason}**`);
  assert.match(rest.join("\n"), /^\nThe finding is posted as a thread\. The review is still open\./u);
  assert.deepEqual(ran.conclusion.failureComment, { pullRequest: PULL_REQUEST, posting: { outcome: "posted" } });
});

test("#544: a failed round that was the last the cap allows says the review closed", async () => {
  const ran = await runInFixture({
    config: { timeout: 1, rounds: 2 },
    rounds: [ANSWER_COST],
    answers: FAILING,
    reviewer: hangs(ANSWER_COST, { findings: [finding("The flag is never read")] }),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.equal(
    failureBody(ran).split("\n\n")[1],
    "The finding is posted as a thread. The review is closed: it has run 2 rounds, and the round cap allows 2. " +
      "No round runs again. A new commit or reply, or running `squiz review`, posts its summary.",
  );
});

test("#544: a failed round that reached the token bound says the review closed", async () => {
  const ran = await runInFixture({
    config: { timeout: 1, tokens: 1_000 },
    answers: FAILING,
    reviewer: hangs(ANSWER_COST, { findings: [finding("The flag is never read")] }),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.equal(
    failureBody(ran).split("\n\n")[1],
    "The finding is posted as a thread. The review is closed: it reached the token bound of 1,000 tokens. " +
      "No round runs again. A new commit or reply, or running `squiz review`, posts its summary.",
  );
});

test("a failed round's comment counts the findings that landed, not the ones reported", async () => {
  const { create: _create, ...noCreate } = FAILING;
  const ran = await runInFixture({
    config: { timeout: 1 },
    answers: noCreate,
    // The first create lands and the second has no answer, so gh fails it.
    sequences: { create: [CREATED] },
    reviewer: hangs(ANSWER_COST, {
      findings: [finding("The flag is never read"), finding("The card renders twice")],
    }),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.match(failureBody(ran), /\n1 of the 2 findings the reviewer reported is posted as a thread\./u);
});

test("a killed round's findings that no thread holds are listed in its failure comment (#357)", async () => {
  const wholeChange: Finding = {
    scope: "change",
    severity: "medium",
    headline: "The retry queue duplicates the scheduler",
    reasoning: ["Nothing calls the scheduler."],
    suggestedFix: "Use the scheduler.",
  };
  // The fixture's diff touches only `src/ui/card.ts`, so this file has nowhere to hang a thread.
  const unplaced: Finding = {
    scope: "line",
    file: "src/cache.ts",
    line: 12,
    severity: "high",
    headline: "The cache is never cleared",
    reasoning: ["Nothing evicts an entry."],
    suggestedFix: "Evict on write.",
  };
  const ran = await runInFixture({
    config: { timeout: 1 },
    answers: FAILING,
    reviewer: hangs(ANSWER_COST, {
      findings: [finding("The flag is never read"), wholeChange, unplaced],
    }),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.equal(ran.conclusion.failure, "timed-out");
  const body = failureBody(ran);
  assert.match(body, /\n1 of the 3 findings the reviewer reported is posted as a thread\./u);
  assert.match(
    body,
    /\n\n- `src\/cache\.ts:12` — The cache is never cleared \(no thread could be opened for it\)\n- About the change as a whole: The retry queue duplicates the scheduler$/u,
  );
});

test("a round that could post none of its findings lists them in its failure comment (#357)", async () => {
  const ran = await runInFixture({
    answers: { prlist: PR_LIST, diff: DIFF, threads: listed([]), failure: FAILURE_POSTED },
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.match(
    failureBody(ran),
    /\n\n- `src\/ui\/card\.ts:88` — The flag is never read \(raised, and its comment could not be posted\)$/u,
  );
});

test("a failure comment gh refuses leaves the round failed as it was, and is not retried", async () => {
  const reviewer = hangs(ANSWER_COST, { findings: [finding("The flag is never read")] });
  const refused = await runInFixture({ config: { timeout: 1 }, answers: POSTING, reviewer });
  const posted = await runInFixture({ config: { timeout: 1 }, answers: FAILING, reviewer });

  assert.ok(refused.conclusion.outcome === "failed");
  assert.ok(posted.conclusion.outcome === "failed");
  assert.equal(refused.conclusion.failure, posted.conclusion.failure);
  assert.equal(refused.conclusion.reason, posted.conclusion.reason);
  assert.deepEqual(refused.conclusion.salvaged?.posted, ["PRRT_new"]);
  assert.deepEqual(
    refused.kinds.filter((kind) => kind === "failure"),
    ["failure"],
    "posting is a create, so a second attempt would be a second comment",
  );
  const comment = refused.conclusion.failureComment?.posting;
  assert.equal(comment?.outcome, "failed");
  assert.match(comment?.outcome === "failed" ? comment.reason : "", /no answer fixtured for failure/u);
});

test("a review the reviewer declared before the bound cut it posts no failure comment", async () => {
  const ran = await runInFixture({
    config: { timeout: 1, rounds: 1 },
    answers: FAILING,
    reviewer: declaresThenHangs(ANSWER_COST, [finding("The flag is never read")]),
  });

  assert.equal(ran.conclusion.outcome, "close", "a declared review is the review it declared");
  assert.deepEqual(ran.kinds.filter((kind) => kind === "failure"), []);
});

test("a round that failed before the review posts its failure comment, with nothing salvaged", async () => {
  const ran = await runInFixture({
    answers: { prlist: PR_LIST, failure: FAILURE_POSTED },
    reviewer: reviews({ findings: [finding("The flag is never read")] }),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.deepEqual(ran.kinds, ["prlist", "threads", "failure"]);
  const body = failureBody(ran);
  assert.equal(body.split("\n")[0], `**Squiz review failed — ${ran.conclusion.reason}**`);
  assert.doesNotMatch(body, /posted as a thread/u, "nothing was salvaged, so nothing is counted");
});

test("a caller that asks for no failure comment gets none, and the round is failed all the same", async () => {
  const ran = await runInFixture({
    config: { timeout: 1 },
    answers: FAILING,
    postsFailure: false,
    reviewer: hangs(ANSWER_COST, { findings: [finding("The flag is never read")] }),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.deepEqual(ran.kinds, ["prlist", "threads", "diff", "create", "lookup"]);
  assert.equal(ran.conclusion.failureComment, undefined);
});

test("a failed round whose posting time is spent attempts no failure comment, and says why", async () => {
  const ran = await runInFixture({
    postingMs: 500,
    config: { timeout: 2 },
    answers: FAILING,
    reviewer: reportsThenHolds(ANSWER_COST, [finding("The flag is never read")]),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.deepEqual(ran.kinds.filter((kind) => kind === "failure"), []);
  const comment = ran.conclusion.failureComment?.posting;
  assert.equal(comment?.outcome, "failed");
  assert.match(comment?.outcome === "failed" ? comment.reason : "", /ran out before this call was made/u);
});

/**
 * The comment's first line and `squiz review`'s stderr carry one reason, word for
 * word, for every kind of failure that posts a comment. The stderr is composed
 * from what the round host records for the failure, as `squiz review` reads it
 * back.
 */
test("each kind of failure says the same reason on the pull request and on stderr", async () => {
  const floor: RoundCost = { dollars: 0.02, tokens: 700, messages: 1 };
  const failures: readonly { readonly name: string; readonly setup: Setup }[] = [
    {
      name: "timed-out",
      setup: { config: { timeout: 1 }, answers: FAILING, reviewer: hangs(floor) },
    },
    { name: "unavailable", setup: { answers: FAILING, reviewer: unreadable(floor) } },
    { name: "setup", setup: { answers: FAILING, reviewer: notInstalled } },
    {
      name: "harness",
      setup: { answers: { prlist: PR_LIST, failure: FAILURE_POSTED }, reviewer: reviews({}) },
    },
  ];

  for (const { name, setup } of failures) {
    const ran = await runInFixture(setup);
    assert.ok(ran.conclusion.outcome === "failed", `${name} did not fail`);
    const [first] = failureBody(ran).split("\n");
    const failed = {
      outcome: "failed",
      pullRequest: PULL_REQUEST,
      reason: ran.conclusion.reason,
      items: failureLinesOf(ran.conclusion),
    } as const;
    const stderr = composeReview(failed, "/unwritten").stderr.split("\n");
    const reason = /^\*\*Squiz review failed — (.*)\*\*$/u.exec(first ?? "")?.[1];
    assert.equal(stderr[0], `squiz: review failed: ${reason}`, `${name} said two reasons`);
  }
});

/** A thread mutation GitHub refused inside an HTTP 200, as it refuses one it will not apply. */
const MUTATION_REFUSED = included(
  "200 OK",
  JSON.stringify({ data: null, errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }] }),
);

test("a closing round names in its summary each ruling it could not apply (#605)", async () => {
  const ran = await runInFixture({
    config: { rounds: 2 },
    rounds: [ANSWER_COST],
    answers: {
      prlist: PR_LIST,
      diff: DIFF,
      threads: listed([{ id: "PRRT_closed", isResolved: true }]),
      unresolve: MUTATION_REFUSED,
      reply: REPLIED,
      summary: SUMMARY_POSTED,
    },
    reviewer: reviews({
      verdicts: [
        { thread: "PRRT_closed", verdict: "open", reason: "Still wrong." },
        { thread: "PRRT_invented", verdict: "fixed" },
      ],
    }),
  });

  assert.ok(ran.conclusion.outcome === "close", `the round did not close: ${JSON.stringify(ran.conclusion)}`);
  assert.deepEqual(ran.kinds, ["prlist", "threads", "diff", "unresolve", "reply", "summary"]);
  const summary = sent(ran.calls.find((call) => call.kind === "summary")?.body ?? "");
  assert.match(
    summary,
    /\n- `src\/ui\/card\.ts:88` — The name says nothing\. \(ruled open, and the thread could not be re-opened\)\n- A ruling of fixed on thread `PRRT_invented`, which was not handed to the reviewer, was not applied$/u,
  );
  assert.ok(!summary.includes("Resource not accessible"), `GitHub's own words reached the summary: ${summary}`);
});

test("a failed round names each ruling it could not apply in its failure comment and on stderr (#605)", async () => {
  const ran = await runInFixture({
    config: { timeout: 1 },
    rounds: [ANSWER_COST],
    answers: {
      prlist: PR_LIST,
      diff: DIFF,
      threads: listed([{ id: "PRRT_one", isResolved: false }]),
      reply: REPLIED,
      resolve: MUTATION_REFUSED,
      failure: FAILURE_POSTED,
    },
    reviewer: hangs(ANSWER_COST, {
      verdicts: [
        { thread: "PRRT_one", verdict: "fixed" },
        { thread: "PRRT_invented", verdict: "withdrawn", reason: "There was no defect." },
      ],
    }),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.deepEqual(ran.kinds, ["prlist", "threads", "diff", "reply", "resolve", "failure"]);
  assert.match(
    failureBody(ran),
    /\n\n- `src\/ui\/card\.ts:88` — The name says nothing\. \(ruled fixed, and the thread could not be resolved\)\n- A ruling of withdrawn on thread `PRRT_invented`, which was not handed to the reviewer, was not applied$/u,
  );
  const stderr = composeReview(
    { outcome: "failed", pullRequest: PULL_REQUEST, reason: ran.conclusion.reason, items: failureLinesOf(ran.conclusion) },
    "/unwritten",
  ).stderr;
  assert.match(
    stderr,
    /\nsquiz: the reviewer ruled thread PRRT_one fixed, and it could not be resolved: GitHub reported a GraphQL error: Resource not accessible by integration\n/u,
  );
  assert.match(
    stderr,
    /\nsquiz: the reviewer ruled thread PRRT_invented withdrawn, and the ruling was not applied: no thread with that id was handed to the reviewer\n/u,
  );
});

/** The body of a reply the round posted inside a thread, read out of its GraphQL request. */
function replyBody(call: Call | undefined): string {
  const request = JSON.parse(call?.body ?? "{}") as { variables?: { body?: unknown } };
  const body = request.variables?.body;
  return typeof body === "string" ? body : assert.fail(`no reply body was sent: ${call?.body ?? "no call"}`);
}

test("a round replies on each thread it closes before resolving it, and records what it ruled (#586)", async () => {
  const ran = await runInFixture({
    rounds: [ANSWER_COST],
    answers: {
      prlist: PR_LIST,
      diff: DIFF,
      threads: listed([
        { id: "PRRT_fixed", isResolved: false },
        { id: "PRRT_withdrawn", isResolved: false },
      ]),
      reply: REPLIED,
      resolve: RESOLVED,
      summary: SUMMARY_POSTED,
    },
    reviewer: reviews({
      verdicts: [
        { thread: "PRRT_fixed", verdict: "fixed" },
        { thread: "PRRT_withdrawn", verdict: "withdrawn", reason: "The caller clamps the height." },
      ],
    }),
  });

  assert.ok(ran.conclusion.outcome === "close", `the round did not close: ${JSON.stringify(ran.conclusion)}`);
  assert.deepEqual(ran.kinds, ["prlist", "threads", "diff", "reply", "resolve", "reply", "resolve", "summary"]);
  const recorded = ran.state?.rounds[1];
  // The fixture's own commit, which the pull request's head was rewritten to.
  const short = (recorded?.head ?? "").slice(0, 7);
  assert.match(recorded?.head ?? "", /^[0-9a-f]{40}$/u, "the round recorded no head it reviewed");
  const replies = ran.calls.filter((call) => call.kind === "reply");
  assert.equal(replyBody(replies[0]), `**Squiz reviewer · fixed**\n\nConfirmed in round 2 at ${short}.`);
  assert.equal(
    replyBody(replies[1]),
    `**Squiz reviewer · withdrawn**\n\nWithdrawn in round 2 at ${short}.\n\nThe caller clamps the height.`,
  );
  assert.equal(recorded?.raised, 0);
  assert.deepEqual(recorded?.ruled, { fixed: 1, withdrawn: 1, open: 0 });

  const summary = sent(ran.calls.find((call) => call.kind === "summary")?.body ?? "");
  assert.match(
    summary,
    new RegExp(
      `\\*\\*Rounds\\*\\*\\n\\n- Round 1: not recorded\\n- Round 2 at ${short}: raised nothing, and ruled 1 fixed and 1 withdrawn$`,
      "u",
    ),
  );
});

test("a closing reply GitHub refuses still resolves the thread, and the summary names it in Notes (#586)", async () => {
  const ran = await runInFixture({
    answers: {
      prlist: PR_LIST,
      diff: DIFF,
      threads: listed([{ id: "PRRT_fixed", isResolved: false }]),
      reply: MUTATION_REFUSED,
      resolve: RESOLVED,
      summary: SUMMARY_POSTED,
    },
    reviewer: reviews({ verdicts: [{ thread: "PRRT_fixed", verdict: "fixed" }] }),
  });

  assert.ok(ran.conclusion.outcome === "close", `the round did not close: ${JSON.stringify(ran.conclusion)}`);
  assert.equal(ran.conclusion.because, "nothing-open", "the refused reply undid the verdict");
  assert.deepEqual(ran.kinds, ["prlist", "threads", "diff", "reply", "resolve", "summary"]);
  const summary = sent(ran.calls.find((call) => call.kind === "summary")?.body ?? "");
  assert.match(summary, /^Fixed 1 · Withdrawn 0 · Open 0 · Disputed 0$/mu);
  assert.match(
    summary,
    /\*\*Notes\*\*\n\n- `src\/ui\/card\.ts:88` — The name says nothing\. \(ruled fixed, and the reviewer's reply could not be posted on its thread\)$/u,
  );
  assert.match(summary, /- Round 1 at [0-9a-f]{7}: raised nothing, and ruled 1 fixed\n/u);
  assert.ok(!summary.includes("Resource not accessible"), `GitHub's own words reached the summary: ${summary}`);
});

test("a round that leaves threads open records its refused closing replies for the summary that closes later (#586)", async () => {
  const ran = await runInFixture({
    answers: {
      ...POSTING,
      threads: listed([{ id: "PRRT_fixed", isResolved: false }]),
      reply: MUTATION_REFUSED,
      resolve: RESOLVED,
    },
    reviewer: reviews({
      findings: [finding("The flag is never read")],
      verdicts: [{ thread: "PRRT_fixed", verdict: "fixed" }],
    }),
  });

  assert.ok(ran.conclusion.outcome === "block", `the round did not block: ${JSON.stringify(ran.conclusion)}`);
  assert.deepEqual(ran.state?.rounds[0]?.unpostedReplies, [
    "`src/ui/card.ts:88` — The name says nothing. (ruled fixed, and the reviewer's reply could not be posted on its thread)",
  ]);
  assert.equal(ran.state?.rounds[0]?.raised, 1);
});

test("a close lists an earlier round's refused closing replies from the state file (#586)", async () => {
  const lost =
    "`src/ui/card.ts:40` — The cap is never read (ruled fixed, and the reviewer's reply could not be posted on its thread)";
  const ran = await runInFixture({
    rounds: [{ ...ANSWER_COST, head: HEAD_SHA, raised: 1, ruled: { fixed: 1, withdrawn: 0, open: 0 }, unpostedReplies: [lost] }],
    answers: {
      prlist: PR_LIST,
      diff: DIFF,
      threads: listed([{ id: "PRRT_open", isResolved: false }]),
      reply: REPLIED,
      resolve: RESOLVED,
      summary: SUMMARY_POSTED,
    },
    reviewer: reviews({ verdicts: [{ thread: "PRRT_open", verdict: "fixed" }] }),
  });

  assert.ok(ran.conclusion.outcome === "close", `the round did not close: ${JSON.stringify(ran.conclusion)}`);
  const summary = sent(ran.calls.find((call) => call.kind === "summary")?.body ?? "");
  assert.match(summary, new RegExp(`\\*\\*Notes\\*\\*\\n\\n- ${lost.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "u"));
});


test("a failed round names in its failure comment each closing reply it could not post (#586)", async () => {
  const ran = await runInFixture({
    config: { timeout: 1 },
    answers: {
      prlist: PR_LIST,
      diff: DIFF,
      threads: listed([{ id: "PRRT_one", isResolved: false }]),
      reply: MUTATION_REFUSED,
      resolve: RESOLVED,
      failure: FAILURE_POSTED,
    },
    reviewer: hangs(ANSWER_COST, { verdicts: [{ thread: "PRRT_one", verdict: "fixed" }] }),
  });

  assert.ok(ran.conclusion.outcome === "failed");
  assert.deepEqual(ran.kinds, ["prlist", "threads", "diff", "reply", "resolve", "failure"]);
  assert.match(
    failureBody(ran),
    /\n\n- `src\/ui\/card\.ts:88` — The name says nothing\. \(ruled fixed, and the reviewer's reply could not be posted on its thread\)$/u,
  );
});
