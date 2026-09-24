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
  type Invocation,
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
  | { readonly outcome: "setup"; readonly cost: RoundCost; readonly reason: string };

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
  if (unmade !== null) return { outcome: "setup", cost: unspent, reason: unmade };

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
      };
    }
    spent = plus(spent, ran.cost);

    if (ran.kind === "reviewed") {
      return { outcome: "reviewed", cost: spent, findings: ran.findings, verdicts: ran.verdicts };
    }
    if (ran.kind === "killed") return { outcome: "timed-out", cost: spent, seconds };
    if (ran.kind === "unstartable" || ran.kind === "incomplete") {
      return { outcome: "setup", cost: spent, reason: ran.reason };
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
  const options: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioNull> = {
    cwd: line.directory,
    env: { ...process.env, TMPDIR: scratch },
    // stderr goes nowhere: the reviewer writes none, and a pipe nobody drains
    // fills and stops the process it was meant to be reading.
    stdio: ["ignore", "pipe", "ignore"],
  };

  let child: ChildProcessByStdio<null, Readable, null>;
  try {
    child = spawn(line.command, [...line.args], options);
  } catch (cause) {
    return { cost: unspent, kind: "unstartable", reason: startFailed(line.command, cause) };
  }

  // The last figure reported before the process is stopped is what a killed
  // round records, so it is tracked here rather than taken from the parse.
  let cost = unspent;
  let startFailure: string | undefined;
  let finished = false;
  child.on("error", (cause) => {
    // Once the attempt is over the only signals left are this module's own, and
    // a refused one says nothing about whether the reviewer started.
    if (!finished) startFailure = startFailed(line.command, cause);
  });

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

  const parsing = adapter
    .parse(bounded(), (reported) => {
      cost = reported;
    })
    .then(
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
    await stop(child);
    // The parse is left mid-stream, so the stream is closed under it rather
    // than waiting on a process that has been told to go.
    child.stdout.destroy();
    return { cost, kind: "killed" };
  }

  // A spawn that failed reports it around the time stdout closes, so a failure
  // waits one turn for it rather than reporting an empty stream as a reviewer
  // that ran and said nothing.
  if (ended.kind !== "reviewed") await nextTurn();
  const failure = startFailure;
  finished = true;
  await stop(child);
  if (failure !== undefined) return { cost: ended.cost, kind: "unstartable", reason: failure };
  return ended;
}

/**
 * Stop the reviewer, and do not return while it might still be running.
 *
 * `SIGTERM` first, which makes the reviewer kill its own children and exit. One
 * still there after the grace is killed outright, and the wait for each is
 * bounded, so a reviewer that answers neither signal cannot hold the round open.
 */
async function stop(child: ChildProcess): Promise<void> {
  if (hasStopped(child)) return;
  signal(child, "SIGTERM");
  if (await exited(child, GRACE_MS)) return;
  signal(child, "SIGKILL");
  await exited(child, GRACE_MS);
}

/**
 * Send the signal, and carry on where the system refuses it.
 *
 * A refused signal is a process that cannot be stopped from here, which the
 * grace then covers. It is not a round that failed to run.
 */
function signal(child: ChildProcess, sent: NodeJS.Signals): void {
  try {
    child.kill(sent);
  } catch {
    // Nothing to do with it: the wait below is what bounds this either way.
  }
}

/** Whether the process is gone, by its own exit or by a signal. */
function hasStopped(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Resolves true where the process exited inside the wait, false where it did not. */
function exited(child: ChildProcess, milliseconds: number): Promise<boolean> {
  return new Promise((settle) => {
    if (hasStopped(child)) {
      settle(true);
      return;
    }
    let cancel = (): void => {};
    const onExit = (): void => {
      cancel();
      settle(true);
    };
    child.once("exit", onExit);
    cancel = deadlineIn(milliseconds).whenPassed(() => {
      child.off("exit", onExit);
      settle(false);
    });
  });
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
