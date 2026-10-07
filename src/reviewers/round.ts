/**
 * One round of review: start the reviewer, confine it, bound its time, and
 * return what it found, what it cost, or why it failed.
 *
 * Nothing here knows which CLI is running. The adapter builds the command line
 * and reads the report file back, and everything else — the current directory,
 * stdin, following the report file, the time bound and the one retry — is the
 * same whatever reviewer a project configured.
 *
 * Nothing throws. Every outcome is a value the caller reads, because the round
 * host has to record a result for every round it takes.
 *
 * Deciding whether another round happens is the caller's. This runs one.
 */

import { spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import type { Readable } from "node:stream";

import type { ChildProcessHandle } from "../sessions/child.ts";
import { closeHerdrPane, insideHerdr } from "../sessions/herdr.ts";
import { identityOf } from "../sessions/process.ts";
import { startSession, type Backends, type LeftOpen, type SessionPlace } from "../sessions/session.ts";
import { closeWindow, windowProcess, type Environment } from "../sessions/tmux.ts";

import {
  type Adapter,
  type Invocation,
  type ParsedRun,
  type ProgressSoFar,
  type RoundOutput,
  type RoundCost,
  type RoundProgress,
  type RunResult,
  type Spend,
  unspent,
} from "./adapter.ts";
import { type Deadline, deadlineIn } from "./deadline.ts";
import { follow } from "./follow.ts";

/**
 * How long a killed reviewer is given to exit before it is killed outright, and
 * again before the round stops waiting for it.
 */
const GRACE_MS = 2_000;

/**
 * What one round of review came to, and how many of the reviewer's calls it
 * refused.
 *
 * The refusals are the round's rather than an attempt's, so a round that ran the
 * reviewer twice reports what both were stopped from doing. A reviewer that
 * spent its window being refused returns the findings of one that had nothing to
 * say, and this is what tells the two apart.
 */
export type Round = { readonly refusals: number } & (
  /** The reviewer ran and returned a review. Empty findings is a review that found nothing. */
  | ({ readonly outcome: "reviewed"; readonly cost: Spend } & RoundOutput)
  /**
   * The time bound passed on a review the reviewer had not finished, and it was
   * killed.
   *
   * A failed round rather than a round that found nothing, and it keeps what
   * the reviewer had reported by then: those findings were confirmed and
   * reported before the kill, and the review they belong to is the one that did
   * not finish. Its cost is a floor, because the messages that completed carry
   * theirs and the request in flight is spent and never reported. A CLI that
   * reports its cost only as it exits leaves it no cost at all.
   */
  | ({
      readonly outcome: "timed-out";
      readonly cost: Spend;
      readonly seconds: number;
    } & RoundOutput)
  /**
   * Output no fresh process could be read either, which is as good as an API
   * that is not answering. It keeps what the reviewer reported on the same
   * terms as a round that was killed.
   */
  | ({
      readonly outcome: "unavailable";
      readonly cost: Spend;
      readonly reason: string;
    } & RoundOutput)
  /**
   * Something that will fail the same way next round: the reviewer would not
   * start, or it ran and completed no message. Reported as a setup problem
   * rather than as a bad round, and not retried. It keeps what the reviewer
   * reported, because a reviewer whose provider gave out after three findings
   * made those three.
   */
  | ({
      readonly outcome: "setup";
      readonly cost: Spend;
      readonly reason: string;
    } & RoundOutput));

/** Where the reviewer may run, and who is told where it did. */
export type Sessions = {
  /**
   * Chooses the backend: a Herdr pane where it names a Herdr server, a tmux
   * window where it names a tmux server, and a child with no terminal otherwise.
   * A child runs with it as its environment.
   *
   * Without one the reviewer is a child, run with this process's environment,
   * so no caller opens a pane on a server it did not choose.
   */
  readonly environment?: Environment;
  /** The tab's label or the window's name. */
  readonly name: string;
  /** The Herdr workspace the tab opens in. Without one, Herdr uses the focused workspace. */
  readonly workspace?: string;
  /**
   * Told where each reviewer started, as soon as it has, with the moment its
   * bound runs out in whole seconds since the epoch. A throw is ignored.
   */
  readonly started?: (place: SessionPlace, boundEndsAt: number) => void;
  /** Told why a reviewer's pane could not be confirmed closed after it ended. */
  readonly paneLeftOpen?: (reason: string) => void;
  /** What starts a session, where it is not the real backends. */
  readonly backends?: Backends;
};

type SessionsAt = Sessions & { readonly environment: Environment; readonly boundEndsAt: number };

/**
 * How long a reviewer in a Herdr pane may take to start running once the
 * pane's shell has its line. The review itself is bounded by the round.
 */
const STARTS_MS = 15_000;

/** Bounds each program run to start a session or close a pane. */
const SESSION_BOUND_MS = 5_000;

/**
 * Run one round, at most `seconds` of wall clock for the whole of it.
 *
 * The bound belongs to the round rather than to each attempt, so the retry runs
 * on what the first attempt left and a round that was killed is not tried
 * again. `now` is the clock the bound is read from.
 */
export async function runRound(
  adapter: Adapter,
  handed: Invocation,
  seconds: number,
  sessions: Sessions = { name: "squiz-reviewer" },
  now: () => number = Date.now,
): Promise<Round> {
  const bound = deadlineIn(seconds * 1_000, now);
  const boundEndsAt = Math.ceil((now() + seconds * 1_000) / 1_000);
  // Absolute, so that the reviewer and the round name the same file whatever
  // directory either of them is in.
  const invocation = {
    ...handed,
    reportsFile: resolve(handed.directory, handed.reportsFile),
    promptFile: resolve(handed.directory, handed.promptFile),
  };
  const unwritten = writePrompt(invocation.promptFile, invocation.prompt);
  if (unwritten !== null) {
    return { outcome: "setup", cost: unspent, reason: unwritten, refusals: 0, ...nothingReported };
  }
  const github = resolve(invocation.directory, invocation.githubConfigDirectory);
  const unemptied = emptyDirectory(github);
  if (unemptied !== null) {
    return { outcome: "setup", cost: unspent, reason: unemptied, refusals: 0, ...nothingReported };
  }

  // What the CLI reads from a file rather than from its command line is put in
  // place before anything starts. A confinement that is not in place is not a
  // round to run.
  const confinement = adapter.confine(invocation);
  if (confinement.outcome === "failed") {
    return {
      outcome: "setup",
      cost: unspent,
      reason: confinement.reason,
      refusals: 0,
      ...nothingReported,
    };
  }

  const variables = variablesOf(github, confinement.environment);

  let spent: Spend = undefined;
  // Added up rather than replaced, unlike the reports below: each refusal is a
  // call that was stopped, and a second attempt does not undo one.
  let refused = 0;
  let held: RoundOutput = nothingReported;
  for (let attempts = 1; ; attempts += 1) {
    let ran: Attempt;
    let reviewerRan = false;
    try {
      ran = await attempt(
        adapter,
        invocation,
        variables,
        bound,
        { ...sessions, environment: sessions.environment ?? withoutPanes(process.env), boundEndsAt },
        () => {
          reviewerRan = true;
        },
      );
    } catch (cause) {
      // A throw here is this harness's own bug. The round is still a value, and
      // a reviewer that ran was paid for whatever the harness did next.
      if (reviewerRan) spent = plus(spent, await spentBy(adapter, invocation.reportsFile));
      return {
        outcome: "setup",
        cost: spent,
        reason: `the round could not be run: ${reasonFor(cause)}`,
        refusals: refused,
        ...held,
      };
    }
    spent = plus(spent, ran.cost);
    refused += ran.refusals;
    // Two attempts are two readings of the same change, so what the second
    // reported is what the first would have reported again. The first attempt's
    // reports stand only where the second got to none of its own.
    if (ran.reported.findings.length > 0 || ran.reported.verdicts.length > 0) {
      held = ran.reported;
    }

    if (ran.kind === "reviewed") {
      return {
        outcome: "reviewed",
        cost: spent,
        refusals: refused,
        findings: ran.findings,
        verdicts: ran.verdicts,
      };
    }
    if (ran.kind === "killed") {
      return { outcome: "timed-out", cost: spent, seconds, refusals: refused, ...held };
    }
    if (ran.kind === "unstartable" || ran.kind === "incomplete") {
      return { outcome: "setup", cost: spent, reason: withModel(ran.reason, invocation, spent), refusals: refused, ...held };
    }
    if (attempts > 1) {
      return { outcome: "unavailable", cost: spent, reason: ran.reason, refusals: refused, ...held };
    }
    if (bound.passed()) {
      return {
        outcome: "unavailable",
        cost: spent,
        reason: `${ran.reason}; no time was left in the round to run the reviewer again`,
        refusals: refused,
        ...held,
      };
    }
  }
}

/**
 * The reason a setup failure gives, naming the configured model where the run
 * completed no message.
 *
 * A CLI that refuses a model it does not offer exits before its first request,
 * and in a pane nothing it said reaches the round, so the model is named as one
 * cause the person can check.
 */
function withModel(reason: string, invocation: Invocation, spent: Spend): string {
  if (invocation.model === null || (spent?.messages ?? 0) > 0) return reason;
  return `${reason}; "model" in .squiz.json is "${invocation.model}", which the reviewer's CLI may not offer`;
}

/** No findings and no verdicts: what an attempt the reviewer told nothing carries. */
const nothingReported: RoundOutput = Object.freeze({ findings: [], verdicts: [] });

/**
 * What the round adds to the reviewer's environment, on every backend.
 *
 * `TMPDIR` is the harness's own temporary directory, where the snapshot is made.
 * A pane server may carry another, and Copilot's `--disallow-temp-dir` closes
 * whichever the reviewer has.
 *
 * **No GitHub credential reaches the reviewer through a variable or `gh`'s
 * configuration.** The token variables are set empty rather than left out,
 * because a pane starts with its server's environment and only a variable set
 * here overrides one the server has. `gh` reads an empty token as none.
 * `GH_CONFIG_DIR` names `github`, which the round has emptied. They come after
 * the confinement's, so no adapter puts a token back.
 */
function variablesOf(
  github: string,
  confinement: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return {
    TMPDIR: tmpdir(),
    ...confinement,
    ...Object.fromEntries(GITHUB_TOKENS.map((name) => [name, ""])),
    GH_CONFIG_DIR: github,
  };
}

/** Every variable `gh` reads a token from. */
const GITHUB_TOKENS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"] as const;

/** How one attempt ended, what it spent getting there, and what it got through. */
type Attempt = {
  readonly cost: Spend;
  /** How many of the reviewer's calls this attempt refused before they ran. */
  readonly refusals: number;
  /**
   * What the reviewer reported before the attempt ended, whether or not it
   * finished the review. On an attempt that reviewed it is that review; on
   * every other it is what an outcome carrying no review of its own keeps.
   */
  readonly reported: RoundOutput;
} & (
  | RunResult
  /** The time bound passed with no review finished, and the process was stopped. */
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

/** How often the report file is read while the reviewer runs. */
const FOLLOW_MS = 50;

/**
 * One reviewer, its report file read to the end or the reviewer stopped at the
 * bound.
 *
 * It runs in a pane where `sessions` offers one, and as a child with no terminal
 * otherwise. Two things confine it, and neither is conditional. It runs in the
 * work tree holding the change. A child's stdin is `/dev/null`: with stdin
 * inherited the reviewer blocks forever and emits nothing, and a silent hang
 * looks exactly like a reviewer thinking.
 *
 * Its output is not read. What it reported is in the report file, which is
 * emptied before it starts and read as it grows until the reviewer is gone. A
 * pane is closed once it is, whatever the attempt came to.
 */
async function attempt(
  adapter: Adapter,
  invocation: Invocation,
  variables: Readonly<Record<string, string>>,
  bound: Deadline,
  sessions: SessionsAt,
  reviewerRan: () => void,
): Promise<Attempt> {
  const unstartable = (reason: string, cost: Spend = unspent): Attempt => ({
    cost,
    refusals: 0,
    reported: nothingReported,
    kind: "unstartable",
    reason,
  });
  const detached = adapter.argv({ ...invocation, terminal: "none" });
  if (detached.stdin !== "/dev/null") {
    return unstartable(`${detached.command} was built to run in a terminal, and was asked for a line to run without one`);
  }
  // Asked for only where a pane may open, so an adapter builds no line that nothing could run.
  const inPane = offersPane(sessions.environment) ? adapter.argv({ ...invocation, terminal: "pane" }) : detached;
  const unprepared = emptied(invocation.reportsFile);
  if (unprepared !== null) return unstartable(unprepared);

  const start = await startSession(
    {
      name: sessions.name,
      directory: detached.directory,
      inPane: { program: inPane.command, arguments: inPane.args },
      withoutTerminal: { program: detached.command, arguments: detached.args },
      startsWithinMs: STARTS_MS,
      ...(sessions.workspace === undefined ? {} : { workspace: sessions.workspace }),
      // The round's own last, so the command line cannot hand the reviewer a token.
      variables: { ...detached.environment, ...inPane.environment, ...variables },
    },
    { environment: sessions.environment, boundMs: SESSION_BOUND_MS },
    sessions.backends,
  );
  if (start.outcome === "failed") {
    if (start.mayHaveRun === true) reviewerRan();
    // A failed start may have run the reviewer, so it is stopped and its pane
    // closed rather than another reviewer started beside it.
    await stopFailedStart(start.leftOpen, sessions.environment);
    const left = start.leftOpen === undefined ? undefined : closeLeftOpen(start.leftOpen, sessions.environment);
    const reason = `the reviewer could not be started: ${start.reason}${left === undefined ? "" : `; ${left}`}`;
    if (start.mayHaveRun !== true) return unstartable(reason);
    // Read once the reviewer is stopped, so the file holds all it will.
    return unstartable(reason, await spentBy(adapter, invocation.reportsFile));
  }
  reviewerRan();
  const { place, child } = start;
  try {
    sessions.started?.(place, sessions.boundEndsAt);
  } catch {
    // The caller's record of the reviewer is not the reviewer, which runs on.
  }

  // The reviewer leads its group, in a pane as with no terminal, so its
  // identifier names the group. What the round owns is the group rather than the
  // one process in it that it started.
  const owned: Owned = {
    group: place.identity.pid,
    gone: child === undefined ? () => !running(place.identity.pid) : () => hasStopped(child),
    alone: (sent) => {
      if (child === undefined) process.kill(place.identity.pid, sent);
      else child.kill(sent);
    },
    ...(child === undefined ? { groupRuns: () => groupHasLiving(place.identity.pid) } : {}),
  };

  const watching = new AbortController();
  try {
    // A startup failure never reaches the report file: the process exits non-zero
    // having written nothing, and a child's only account of itself is its stderr.
    // Both pipes are read as they arrive, because a pipe nobody drains fills and
    // stops the process writing to it. A reviewer in a pane writes to the pane.
    const complaint = child === undefined ? (): string => "" : drain(child.stderr);
    if (child !== undefined) discard(child.stdout);
    const exited = child === undefined ? exitOf(place.identity.pid, watching.signal) : exitOfChild(child);
    // The process has written everything it will once it has exited, so the file
    // is read once more then and that read is the last.
    const closing = child === undefined ? exited : ending(child);
    const abandoned = new AbortController();

    // The last the parse reported is the whole of what a killed round has, so it
    // is tracked here rather than taken from the parse's return, which a killed
    // attempt may not reach.
    let progress: RoundProgress = {
      cost: adapter.costAtExit === true ? undefined : unspent,
      refusals: 0,
      finished: false,
      broken: undefined,
      ...nothingReported,
    };

    const reports = follow(invocation.reportsFile, {
      ended: exited,
      pollMs: FOLLOW_MS,
      abandoned: abandoned.signal,
    });
    const parsing = read(adapter, reports, (reached) => {
      progress = reached;
    }).then(
      (run): Attempt => ({
        cost: run.cost,
        refusals: progress.refusals,
        reported: reportedIn(progress),
        ...run.result,
      }),
      // A read that failed left the rest of the file uncounted. A cost reported at
      // exit is the file's last line, so one that was read is whole.
      (cause): Attempt => ({
        cost: adapter.costAtExit === true ? progress.cost : atLeast(progress.cost),
        refusals: progress.refusals,
        reported: reportedIn(progress),
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

    if (ended === "expired") {
      await stop(owned);
      child?.stderr.destroy();
      // What the reviewer wrote between the last read and the stop is part of
      // what it reported, a finish included. A file that takes longer than the
      // grace to read is left where the read had got to.
      await within(parsing.then(() => {}), GRACE_MS);
      abandoned.abort();
      return atTheBound(progress, adapter.costAtExit === true);
    }

    // The reviewer is stopped before its account is read, and whatever the
    // account turns out to be. One still running would never close its output, so
    // there would be nothing to wait for; one already gone is not signalled at
    // all; and no reviewer outlives the round that started it.
    await stop(owned);
    // A child's exit status and the last of its stderr are both there only once
    // its output has closed.
    await within(closing, GRACE_MS);
    if (child === undefined || (ended.kind !== "unparsed" && ended.kind !== "incomplete")) return ended;

    // A run that completed a message explained itself in the report file, and
    // stderr would only say the same thing a second way.
    const said = complaint();
    if ((ended.cost?.messages ?? 0) > 0 || said === "") return ended;
    return {
      ...ended,
      reason: `${ended.reason}: ${endedAs(detached.command, child)}, and said: ${said}`,
    };
  } catch (cause) {
    // Nothing after this attempt stops the reviewer, and the caller reads what it
    // spent from a file it would otherwise still be writing.
    await stop(owned);
    throw cause;
  } finally {
    watching.abort();
    // The reviewer is stopped by now. Closing the pane takes it
    // off the person's screen, and is not relied on to stop anything.
    const left = closePlace(place, sessions.environment);
    if (left !== undefined) {
      try {
        sessions.paneLeftOpen?.(left);
      } catch {
        // Nothing more to do with a pane that would not close.
      }
    }
  }
}

/**
 * The adapter's read of the report file, as a promise however it fails.
 *
 * An adapter need not be written as an async function, and one that throws
 * before it returns its promise would otherwise throw past the bound and the
 * cleanup both, leaving a reviewer running and its cost unrecorded.
 */
async function read(
  adapter: Adapter,
  reports: AsyncIterable<Uint8Array>,
  soFar: ProgressSoFar,
): Promise<ParsedRun> {
  return adapter.parse(reports, soFar);
}

/**
 * What a reviewer the round did not watch to its end spent, as far as its report
 * file says.
 *
 * Never a figure that reads as a known zero. A request in flight when the
 * reviewer stopped, or was stopped, was spent and never reported, so the cost is
 * a floor. A CLI that reports its cost only as it exits by itself has reported
 * the whole of it or nothing, and nothing is a floor of zero: the reviewer ran
 * and may have spent what it never said.
 */
async function spentBy(adapter: Adapter, reportsFile: string): Promise<RoundCost> {
  let progress: Spend = adapter.costAtExit === true ? undefined : unspent;
  let cost: Spend;
  try {
    const run = await read(adapter, contentsOf(reportsFile), (reached) => {
      progress = reached.cost;
    });
    cost = run.cost;
  } catch {
    cost = progress;
  }
  if (adapter.costAtExit === true && cost !== undefined) return cost;
  return { ...(cost ?? unspent), floor: true };
}

/** The file's bytes as one chunk, or none where it cannot be read. */
async function* contentsOf(file: string): AsyncIterable<Uint8Array> {
  let contents: Uint8Array;
  try {
    contents = readFileSync(file);
  } catch {
    return;
  }
  yield contents;
}

/**
 * The report file made empty, or why it could not be.
 *
 * A file left by an earlier run would be read as this one's reports, a finish
 * included.
 */
function emptied(file: string): string | null {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "");
    return null;
  } catch (cause) {
    return `the report file ${file} could not be emptied: ${reasonFor(cause)}`;
  }
}

/** What the reviewer had reported, taken off everything else the round tracks. */
function reportedIn(progress: RoundProgress): RoundOutput {
  return { findings: progress.findings, verdicts: progress.verdicts };
}

/**
 * What an attempt the bound ended came to, from what the reviewer had reported
 * by then.
 *
 * The reviewer's declaration is what says a review is finished, so an attempt
 * holding one is that review however its process came to stop. A reviewer that
 * declares its review a moment before the deadline and writes its closing
 * message past it has reviewed, and an attempt that read the stop instead would
 * keep the findings and throw the review away.
 *
 * A line that could not be read comes first, declaration or not, and fails the
 * attempt on this path exactly as it fails one whose process exited: the same
 * file must not come to one thing when the process stopped and another when it
 * hung. Either way the reports that were readable are kept.
 *
 * The cost is a floor whatever the attempt came to. A request in flight when the
 * process was stopped was spent and is never reported. A CLI that reports its
 * cost only as it exits by itself, `costAtExit`, has either reported the whole
 * of it or none.
 */
function atTheBound(progress: RoundProgress, costAtExit: boolean): Attempt {
  const cost = costAtExit ? progress.cost : atLeast(progress.cost);
  const refusals = progress.refusals;
  const reported = reportedIn(progress);
  const { broken } = progress;
  if (broken !== undefined) return { cost, refusals, reported, kind: "unparsed", reason: broken };
  if (!progress.finished) return { cost, refusals, reported, kind: "killed" };
  return { cost, refusals, reported, kind: "reviewed", ...reported };
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

/** What one round owns: the reviewer and its own group. */
type Owned = {
  /** The group's identifier, which is the reviewer's own. */
  readonly group: number | undefined;
  /** Whether the reviewer itself is gone. */
  readonly gone: () => boolean;
  /** Send the signal to the reviewer alone. May throw. */
  readonly alone: (sent: NodeJS.Signals) => void;
  /**
   * Whether anything is still running in the reviewer's group, where the
   * group's own answer would count a zombie the round cannot reap.
   */
  readonly groupRuns?: () => boolean;
};

/**
 * Stop the reviewer's own process group, and do not return while any of it
 * might still be running.
 *
 * `SIGTERM` first, which makes the reviewer kill its own children and exit.
 * Anything of the group still there after the grace is killed outright, and each
 * wait is bounded, so a reviewer that answers neither signal cannot hold the
 * round open.
 *
 * **The reviewer's own exit does not end this.** A tool it started can outlive
 * it, whether because the reviewer finished first or because the reviewer took
 * the signal and the tool did not. The grant is the only thing keeping the round
 * off the code under review, and a tool that outlives the round is outside the
 * grant as much as outside the bound.
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
  if (owned.groupRuns !== undefined) return owned.groupRuns();
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
    owned.alone(sent);
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

/** The prompt written where the reviewer reads it, or why it could not be. */
function writePrompt(file: string, prompt: string): string | null {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, prompt, "utf8");
    return null;
  } catch (cause) {
    return `the reviewer's prompt could not be written to ${file}: ${reasonFor(cause)}`;
  }
}

/** Make `directory` and leave nothing in it, whatever an earlier run left there. */
function emptyDirectory(directory: string): string | null {
  try {
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
    return null;
  } catch (cause) {
    return `the reviewer's gh configuration ${directory} could not be emptied: ${reasonFor(cause)}`;
  }
}

/** `cost` marked a floor, where there is a cost to mark. */
function atLeast(cost: Spend): Spend {
  return cost === undefined ? undefined : { ...cost, floor: true };
}

/**
 * Two attempts' costs added: a retry spends a second process on the same round.
 *
 * A floor added to anything is a floor. No cost adds nothing, so a round has no
 * cost only where none of its attempts had one. The round ran on every model
 * either attempt named.
 */
function plus(total: Spend, more: Spend): Spend {
  if (total === undefined) return more;
  if (more === undefined) return total;
  const sum = {
    dollars: total.dollars + more.dollars,
    tokens: total.tokens + more.tokens,
    messages: total.messages + more.messages,
    ...(total.credits === undefined && more.credits === undefined
      ? {}
      : { credits: (total.credits ?? 0) + (more.credits ?? 0) }),
    ...(total.models === undefined && more.models === undefined
      ? {}
      : { models: [...new Set([...(total.models ?? []), ...(more.models ?? [])])] }),
  };
  return total.floor === true || more.floor === true ? { ...sum, floor: true } : sum;
}

/** `environment` with nothing in it that names a Herdr or tmux server. */
function withoutPanes(environment: NodeJS.ProcessEnv): Environment {
  const { HERDR_SOCKET_PATH: _herdr, TMUX: _tmux, ...rest } = environment;
  return rest;
}

/** Whether a session started in `environment` may open a pane. */
function offersPane(environment: Environment): boolean {
  return insideHerdr(environment) || (environment["TMUX"] ?? "") !== "";
}

/**
 * Whether the process holding `pid` is running, where a zombie is not.
 *
 * A reviewer in a pane is the pane server's child, and the server reaps it when
 * it gets to it. Until then it is a zombie that holds its pid and runs nothing,
 * which tmux on Linux has been seen to leave for seconds. A `ps` that could not
 * tell is read as running, so nothing is taken for stopped that may not be.
 */
function running(pid: number): boolean {
  try {
    // Signal 0 asks whether the process could be signalled, and sends nothing.
    process.kill(pid, 0);
  } catch (cause) {
    if (!refused(cause)) return false;
  }
  return identityOf(pid, SESSION_BOUND_MS).outcome !== "gone";
}

/**
 * Whether anything but a zombie is left in `group`.
 *
 * A group whose only member is a zombie leader runs nothing, though the system
 * still answers for it. A `ps` that could not tell is read as yes.
 */
function groupHasLiving(group: number): boolean {
  try {
    process.kill(-group, 0);
  } catch (cause) {
    if (!refused(cause)) return false;
  }
  const listed = spawnSync("ps", ["-A", "-o", "pgid=,stat="], { encoding: "utf8", timeout: SESSION_BOUND_MS });
  if (listed.error !== undefined || listed.status !== 0) return true;
  return listed.stdout.split("\n").some((row) => {
    const [pgid, stat] = row.trim().split(/\s+/u);
    return Number(pgid) === group && stat !== undefined && !stat.startsWith("Z");
  });
}

/** How often a reviewer in a pane is looked for, each look being a `ps`. */
const PANE_POLL_MS = 250;

/**
 * Resolves once `pid` runs nothing, or once `abandoned` is.
 *
 * A reviewer in a pane is not this process's child, so its exit arrives as no
 * event and is looked for instead.
 */
function exitOf(pid: number, abandoned: AbortSignal): Promise<void> {
  return new Promise((settle) => {
    const look = (): void => {
      if (abandoned.aborted || !running(pid)) {
        settle();
        return;
      }
      setTimeout(look, PANE_POLL_MS);
    };
    look();
  });
}

/** Resolves once the child has exited, however it ended. */
function exitOfChild(child: ChildProcessHandle): Promise<void> {
  return new Promise((settle) => {
    if (hasStopped(child)) settle();
    child.once("exit", () => settle());
    child.once("error", () => settle());
  });
}

/** Read the stream to its end and keep none of it. */
function discard(stream: Readable): void {
  stream.on("error", () => {});
  stream.resume();
}

/**
 * Close the pane the reviewer ran in, and say why where it could not be
 * confirmed closed. A child has no pane.
 *
 * tmux has closed a window whose command exited, and the close then finds it
 * gone. Herdr returns a pane to its shell instead, so its close is what removes it.
 */
function closePlace(place: SessionPlace, environment: Environment): string | undefined {
  if (place.backend === "child") return undefined;
  return closeLeftOpen(place, environment);
}

/**
 * Stop whatever a failed start may have left running, as a reviewer is stopped
 * at the bound.
 *
 * tmux closes a window with one `SIGHUP`, which a command may ignore, so the
 * window's command is found from tmux and its group signalled before the window
 * is closed. Herdr's own close escalates to `SIGKILL` across the pane's shell
 * session, which holds the command, so a Herdr pane has nothing to stop here.
 */
async function stopFailedStart(left: LeftOpen | undefined, environment: Environment): Promise<void> {
  const pid = left?.backend === "tmux" ? windowProcess(left.window, environment, SESSION_BOUND_MS) : undefined;
  if (pid === undefined) return;
  await stop({
    group: pid,
    gone: () => !running(pid),
    alone: (sent) => process.kill(pid, sent),
    groupRuns: () => groupHasLiving(pid),
  });
}

function closeLeftOpen(left: LeftOpen, environment: Environment): string | undefined {
  if (left.backend === "herdr") {
    const closed = closeHerdrPane(left.pane, { environment, boundMs: SESSION_BOUND_MS });
    return closed.outcome === "closed" ? undefined : `its pane ${left.pane} could not be closed: ${closed.reason}`;
  }
  const closed = closeWindow(left.window, environment, SESSION_BOUND_MS);
  if (closed.outcome === "closed") return undefined;
  const why = closed.outcome === "open" ? "tmux still has it" : closed.reason;
  return `its window ${left.window.id} could not be closed: ${why}`;
}

function reasonFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
