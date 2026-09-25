/**
 * One round of review: start the reviewer, confine it, bound its time, and
 * return what it found, what it cost, or why it failed.
 *
 * Nothing here knows which CLI is running. The adapter builds the command line
 * and reads the output back, and everything else — the current directory, the
 * scratch space, stdin, the time bound and the one retry — is the same whatever
 * reviewer a project configured.
 *
 * Nothing throws. Every outcome is a value the caller reads, because the round
 * runs inside a hook that may fail in any way except by preventing the coding
 * agent from finishing.
 *
 * Deciding whether another round happens is the caller's. This runs one.
 */

import {
  spawn,
  type ChildProcess,
  type ChildProcessByStdio,
  type SpawnOptionsWithStdioTuple,
  type StdioNull,
  type StdioPipe,
} from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Readable } from "node:stream";

import {
  type Adapter,
  type CostSoFar,
  type Invocation,
  type ParsedRun,
  type RoundCost,
  type RoundOutput,
  type RunResult,
  unspent,
} from "./adapter.ts";
import { type Deadline, deadlineIn } from "./deadline.ts";

/**
 * How long a killed reviewer is given to exit before it is killed outright, and
 * again before the round stops waiting for it.
 *
 * A round that reaches its time bound therefore returns within twice this of
 * reaching it, which is what the margin left for posting has to cover.
 */
const GRACE_MS = 2_000;

/** What one round of review came to. */
export type Round =
  /** The reviewer ran and returned a review. Empty findings is a review that found nothing. */
  | ({ readonly outcome: "reviewed"; readonly cost: RoundCost } & RoundOutput)
  /**
   * The time bound passed and the reviewer was killed. A failed round rather
   * than a round that found nothing, and its cost is a floor: the messages that
   * completed carry theirs, and the request in flight is spent and never
   * reported.
   */
  | { readonly outcome: "timed-out"; readonly cost: RoundCost; readonly seconds: number }
  /**
   * Output no fresh process could be read either, which is as good as an API
   * that is not answering.
   */
  | { readonly outcome: "unavailable"; readonly cost: RoundCost; readonly reason: string }
  /**
   * Something that will fail the same way next round: the reviewer would not
   * start, or it ran and completed no message. Reported as a setup problem
   * rather than as a bad round, and not retried.
   */
  | {
      readonly outcome: "setup";
      readonly cost: RoundCost;
      readonly reason: string;
      /**
       * Whether a reviewer process ran.
       *
       * The two failures under this outcome are opposite: one never started, and
       * one started and completed no message. A reviewer killed before its first
       * message reports no cost at all, so a caller that read a cost of nothing
       * as a reviewer that never ran would leave a round that really ran
       * unaccounted for. This is the only thing that separates them.
       */
      readonly started: boolean;
    };

/**
 * Run one round, at most `seconds` of wall clock for the whole of it.
 *
 * The bound belongs to the round rather than to each attempt, so the retry runs
 * on what the first attempt left and a round that was killed is not tried
 * again.
 */
export async function runRound(
  adapter: Adapter,
  invocation: Invocation,
  seconds: number,
): Promise<Round> {
  const bound = deadlineIn(seconds * 1_000);
  // Absolute, so that TMPDIR still names the scratch space for a reviewer that
  // changes directory, and so the directory is made wherever the harness runs.
  const scratch = resolve(invocation.directory, invocation.scratchDirectory);
  const unmade = makeScratch(scratch);
  if (unmade !== null) {
    return { outcome: "setup", cost: unspent, reason: unmade, started: false };
  }

  let spent = unspent;
  for (let attempts = 1; ; attempts += 1) {
    let ran: Attempt;
    try {
      ran = await attempt(adapter, invocation, scratch, bound);
    } catch (cause) {
      // A throw here is this harness's own bug. The round is still a value.
      return {
        outcome: "setup",
        cost: spent,
        reason: `the round could not be run: ${reasonFor(cause)}`,
        // Whether the process was started before the throw is not knowable here,
        // and a round left unaccounted for is the loop's only bound gone.
        started: true,
      };
    }
    spent = plus(spent, ran.cost);

    if (ran.kind === "reviewed") {
      return { outcome: "reviewed", cost: spent, findings: ran.findings, verdicts: ran.verdicts };
    }
    if (ran.kind === "killed") return { outcome: "timed-out", cost: spent, seconds };
    if (ran.kind === "unstartable" || ran.kind === "incomplete") {
      // A run that completed no message reached the stream, so a process ran.
      // Only a spawn that failed did not.
      return {
        outcome: "setup",
        cost: spent,
        reason: ran.reason,
        started: ran.kind === "incomplete",
      };
    }
    if (attempts > 1) return { outcome: "unavailable", cost: spent, reason: ran.reason };
    if (bound.passed()) {
      return {
        outcome: "unavailable",
        cost: spent,
        reason: `${ran.reason}; no time was left in the round to run the reviewer again`,
      };
    }
  }
}

/** How one attempt ended, and what it spent getting there. */
type Attempt = { readonly cost: RoundCost } & (
  | RunResult
  /** The time bound passed and the process was stopped. */
  | { readonly kind: "killed" }
  /** The reviewer never ran: it is not installed, or it could not be executed. */
  | { readonly kind: "unstartable"; readonly reason: string }
);

/**
 * As much of the reviewer's stderr as a reason carries.
 *
 * A startup failure says one line and stops, so this is generous enough to hold
 * it whole and small enough that a reviewer writing to stderr for the length of
 * a round cannot grow it.
 */
const COMPLAINT_LIMIT = 2_000;

/**
 * One process, read to the end or stopped at the bound.
 *
 * Three things confine it, and none is conditional. It runs in the work tree
 * holding the change. `TMPDIR` is the scratch space, which exists before it
 * starts. Its stdin is `/dev/null`: with stdin inherited the reviewer blocks
 * forever and emits nothing, and a silent hang looks exactly like a reviewer
 * thinking.
 *
 * Two things watch the bound, because a reviewer fails the round in two
 * opposite ways. One that has gone quiet is caught by the timer. One that
 * floods is caught by the clock read as its output arrives, which is the only
 * reading that happens at all while the loop is busy passing chunks on.
 */
async function attempt(
  adapter: Adapter,
  invocation: Invocation,
  scratch: string,
  bound: Deadline,
): Promise<Attempt> {
  const line = adapter.argv(invocation);
  const options: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe> = {
    cwd: line.directory,
    env: { ...process.env, TMPDIR: scratch },
    // The reviewer leads its own process group, so that stopping it stops the
    // tools it started. At depth `read` the grant is the only thing keeping the
    // reviewer off the code under review, and a tool outliving the round that
    // launched it is outside the grant as much as outside the bound.
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  };

  let child: ChildProcessByStdio<null, Readable, Readable>;
  try {
    child = spawn(line.command, [...line.args], options);
  } catch (cause) {
    return { cost: unspent, kind: "unstartable", reason: startFailed(line.command, cause) };
  }

  // A startup failure never reaches the stream: the process exits non-zero with
  // an empty stdout, and its only account of itself is here. Read as it
  // arrives, because a pipe nobody drains fills and stops the process it was
  // meant to be reading.
  const complaint = drain(child.stderr);
  const closing = ending(child);

  // The last figure reported before the process is stopped is what a killed
  // round records, so it is tracked here rather than taken from the parse.
  let cost = unspent;
  let startFailure: string | undefined;
  let unstarted = false;
  let finished = false;
  child.on("error", (cause) => {
    // A process that never started emits no exit, so this is the only word that
    // it is not running.
    unstarted = true;
    // Once the attempt is over the only signals left are this module's own, and
    // a refused one says nothing about whether the reviewer started.
    if (!finished) startFailure = startFailed(line.command, cause);
  });

  // The reviewer leads the group, so its identifier names the group. What the
  // round owns is the group rather than the one process in it that it started.
  const owned: Owned = {
    child,
    group: child.pid,
    gone: () => hasStopped(child) || unstarted,
  };

  // Read as the chunks arrive, so that a reviewer flooding its output is
  // stopped by the bound even where the loop never reaches a timer.
  let overran = false;
  const bounded = async function* (): AsyncGenerator<Uint8Array> {
    for await (const chunk of child.stdout) {
      if (bound.passed()) {
        overran = true;
        return;
      }
      yield chunk;
    }
  };

  const parsing = read(adapter, bounded(), (reported) => {
    cost = reported;
  }).then(
    (run): Attempt => ({ cost: run.cost, ...run.result }),
    (cause): Attempt => ({
      cost,
      kind: "unparsed",
      reason: `the reviewer's output could not be read: ${reasonFor(cause)}`,
    }),
  );

  let cancel = (): void => {};
  const expiry = new Promise<"expired">((settle) => {
    cancel = bound.whenPassed(() => settle("expired"));
  });

  const ended = await Promise.race([parsing, expiry]);
  cancel();

  if (ended === "expired" || overran) {
    finished = true;
    await stop(owned);
    // The parse is left mid-stream, so the streams are closed under it rather
    // than waiting on a process that has been told to go.
    child.stdout.destroy();
    child.stderr.destroy();
    return { cost, kind: "killed" };
  }

  // The reviewer is stopped before its account is read, and whatever the
  // account turns out to be. One still running would never close its output, so
  // there would be nothing to wait for; one already gone is not signalled at
  // all; and no reviewer outlives the round that started it.
  await stop(owned);
  // Its exit status and the last of stderr are both there only once its output
  // has closed. A spawn that failed reports itself here too, rather than an
  // empty stream being read as a reviewer that ran and said nothing.
  await within(closing, GRACE_MS);
  const failure = startFailure;
  finished = true;
  if (failure !== undefined) return { cost: ended.cost, kind: "unstartable", reason: failure };
  if (ended.kind !== "unparsed" && ended.kind !== "incomplete") return ended;

  // A run that completed a message explained itself in the stream, and stderr
  // would only say the same thing a second way.
  const said = complaint();
  if (ended.cost.messages > 0 || said === "") return ended;
  return {
    ...ended,
    reason: `${ended.reason}: ${endedAs(line.command, child)}, and said: ${said}`,
  };
}

/**
 * The adapter's read of the output, as a promise however it fails.
 *
 * An adapter need not be written as an async function, and one that throws
 * before it returns its promise would otherwise throw past the bound and the
 * cleanup both, leaving a reviewer running and its cost unrecorded.
 */
async function read(
  adapter: Adapter,
  stdout: AsyncIterable<Uint8Array>,
  costSoFar: CostSoFar,
): Promise<ParsedRun> {
  return adapter.parse(stdout, costSoFar);
}

/**
 * Read stderr as it arrives, keeping the end of it.
 *
 * Draining is not optional: a pipe nobody reads fills, and the reviewer stops
 * on the write that fills it. Keeping only the end is what stops a reviewer
 * that complains for a whole round from being held in memory.
 */
function drain(stderr: Readable): () => string {
  let tail = "";
  stderr.setEncoding("utf8");
  stderr.on("data", (chunk: string) => {
    tail = (tail + chunk).slice(-COMPLAINT_LIMIT);
  });
  // A pipe closed under a reviewer that is still writing, which is not a
  // failure of the round.
  stderr.on("error", () => {});
  return () => tail.trim();
}

/** Resolves once the process is gone and its output is closed, however it ended. */
function ending(child: ChildProcess): Promise<void> {
  return new Promise((settle) => {
    child.once("close", () => settle());
    // A process that never started emits no close of its own.
    child.once("error", () => settle());
  });
}

/** How the process ended, named for the reason a reader is given. */
function endedAs(command: string, child: ChildProcess): string {
  if (child.signalCode !== null) return `${command} was stopped by ${child.signalCode}`;
  if (child.exitCode !== null) return `${command} exited ${child.exitCode}`;
  return `${command} did not run`;
}

/** How often the reviewer's group is asked whether anything of it is left. */
const POLL_MS = 25;

/** What one round owns: the reviewer, and the process group it leads. */
type Owned = {
  readonly child: ChildProcess;
  /**
   * The group's identifier, which is the reviewer's own. Absent where the
   * reviewer never got as far as having one.
   */
  readonly group: number | undefined;
  /** Whether the reviewer itself is gone, including where it never started. */
  readonly gone: () => boolean;
};

/**
 * Stop the reviewer and everything it started, and do not return while any of
 * it might still be running.
 *
 * `SIGTERM` to the process group first, which makes the reviewer kill its own
 * children and exit. Anything of the group still there after the grace is
 * killed outright, and each wait is bounded, so a reviewer that answers neither
 * signal cannot hold the round open.
 *
 * **The reviewer's own exit does not end this.** A tool it started sits in the
 * same group and can outlive it, whether because the reviewer finished first or
 * because the reviewer took the signal and the tool did not. At depth `read`
 * the grant is the only thing keeping the round off the code under review, and
 * a tool that outlives the round is outside the grant as much as outside the
 * bound.
 */
async function stop(owned: Owned): Promise<void> {
  if (owned.gone() && !groupRuns(owned)) return;
  signal(owned, "SIGTERM");
  if (await settled(owned, GRACE_MS)) return;
  signal(owned, "SIGKILL");
  await settled(owned, GRACE_MS);
}

/**
 * Whether anything is still running in the reviewer's group.
 *
 * Asked only once the reviewer itself is gone, because until then it is in the
 * group and the answer is always yes.
 *
 * A group is named by its leader's identifier, and the system keeps that
 * identifier reserved while the group has members. An empty group therefore
 * answers no here rather than answering for whoever holds the identifier next.
 */
function groupRuns(owned: Owned): boolean {
  const { group } = owned;
  if (group === undefined) return false;
  try {
    // Signal 0 asks whether the group could be signalled, and sends nothing.
    process.kill(-group, 0);
    return true;
  } catch (cause) {
    // Refused rather than absent means it is there and not ours to signal.
    return refused(cause);
  }
}

/**
 * Wait for the reviewer and its group both to be gone, for as long as the wait
 * allows. Resolves false where either is still there.
 *
 * The reviewer's exit arrives as an event; a tool of its group outliving it
 * does not, so the group is asked at intervals rather than waited on.
 */
async function settled(owned: Owned, milliseconds: number): Promise<boolean> {
  const bound = deadlineIn(milliseconds);
  for (;;) {
    if (owned.gone() && !groupRuns(owned)) return true;
    if (bound.passed()) return false;
    await pause(POLL_MS);
  }
}

/**
 * Send the signal to the reviewer's process group, and carry on where the
 * system refuses it.
 *
 * A refused signal is a process that cannot be stopped from here, which the
 * grace then covers. It is not a round that failed to run.
 */
function signal(owned: Owned, sent: NodeJS.Signals): void {
  const { group } = owned;
  if (group !== undefined) {
    try {
      // A negative identifier is the group rather than the one process, so a
      // tool the reviewer started is stopped whether or not the reviewer is.
      process.kill(-group, sent);
      return;
    } catch {
      // No group of its own, or none left. The reviewer itself may still be there.
    }
  }
  try {
    owned.child.kill(sent);
  } catch {
    // Nothing to do with it: the wait below is what bounds this either way.
  }
}

/** Whether the system refused the signal rather than finding nothing to send it to. */
function refused(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "EPERM";
}

/** Whether the process is gone, by its own exit or by a signal. */
function hasStopped(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((settle) => {
    setTimeout(settle, milliseconds);
  });
}

/** Wait for it to settle, or for the wait to run out, whichever comes first. */
async function within(settling: Promise<void>, milliseconds: number): Promise<void> {
  const waited = new Promise<void>((settle) => {
    deadlineIn(milliseconds).whenPassed(settle);
  });
  await Promise.race([settling, waited]);
}

/** The scratch space, made before the reviewer starts, or why it could not be. */
function makeScratch(directory: string): string | null {
  try {
    mkdirSync(directory, { recursive: true });
    return null;
  } catch (cause) {
    return `the reviewer's scratch space ${directory} could not be made: ${reasonFor(cause)}`;
  }
}

/** Two attempts' costs added: a retry spends a second process on the same round. */
function plus(total: RoundCost, more: RoundCost): RoundCost {
  return {
    dollars: total.dollars + more.dollars,
    tokens: total.tokens + more.tokens,
    messages: total.messages + more.messages,
  };
}

function nextTurn(): Promise<void> {
  return new Promise((settle) => setImmediate(settle));
}

function startFailed(command: string, cause: unknown): string {
  return `the reviewer ${command} could not be started: ${reasonFor(cause)}`;
}

function reasonFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
