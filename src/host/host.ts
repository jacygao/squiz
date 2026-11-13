/**
 * The round host: the process that runs one episode's rounds, one at a time,
 * outside every trigger.
 *
 * It holds `host.lock` for as long as it runs. For each round it takes the
 * oldest queued state, writes the reviewing record naming itself, runs the round
 * under the lock it already holds, and records what the round reached. It exits
 * when nothing is left queued, and when its worktree is gone.
 *
 * **No review runs for a state without a record saying so.** The reviewing record
 * is written before the reviewer starts, because it is what a second trigger
 * reads to find the round. A record that cannot be written runs no review.
 *
 * What it did goes to `host.log` in the episode's directory, one line each,
 * because nothing waits on the host to be told.
 *
 * **A note for a state's owner is written only once its result is recorded**,
 * because the note reports that result. Where the owner's hook
 * recorded a messaging socket, the host then wakes it there. A note that cannot
 * be written, or a wake that does not arrive, goes to `host.log` and changes
 * nothing else.
 *
 * **Where `.squiz.json` names a fixer, the run is headless, and nothing is woken.**
 * A round that leaves threads open with a round remaining starts the fixer on
 * its handoff instead, and a round that closes the episode writes `closed.json`
 * for whoever started the run to wait on. A fixer that does not start is
 * recorded on the round's state as well as in `host.log`, because otherwise it
 * reads exactly as a round that needed none.
 */

import { appendFileSync, existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { unthreadedNotes } from "../loop/summary-body.ts";
import type { Change, ReviewThread, Venue } from "../venues/venue.ts";
import { unappliedRulings, unpostedReasons } from "../loop/verdicts.ts";
import { CLOSE_FILE, startNextEpisode, type NextEpisode } from "../loop/archive.ts";
import { closedRecords, readState, type EpisodeState } from "../loop/episode-state.ts";
import { episodeAt, roundDirectory, type Episode } from "../loop/episode.ts";
import type { Config, FixerAgent } from "../config/config.ts";
import type { ClosedBy } from "../loop/failure-body.ts";
import {
  closedBeforeReview,
  decideRoundEnd,
  lastReviewed,
  namedStates,
  type EndedRound,
  type NotReviewedRecord,
  type QueuedRecord,
  type RoundEnd,
} from "../loop/round-end.ts";
import type { EpisodeSummary } from "../loop/post-summary.ts";
import { runRoundThen, type RoundConclusion, type RoundSetup } from "../loop/round.ts";
import {
  putRecord,
  sameState,
  type ClosedBeforeReview,
  type ClosingBound,
  type FixerStart,
  type ReviewerPlace,
  type RoundReport,
  type StateKey,
  type StateRecord,
} from "../loop/state-record.ts";
import { updateState, type StateUpdate } from "../loop/state-update.ts";
import { deadlineIn } from "../reviewers/deadline.ts";
import { writeNote } from "../sessions/notes.ts";
import { stillRunning, type ProcessIdentity } from "../sessions/process.ts";
import { startFixer } from "./fixer.ts";
import { handoffFor, handsBack } from "./handoff.ts";
import { takeEpisodeHostLock, type HostLock } from "./lock.ts";
import { ownerNote, threadsToPrint } from "./owner-note.ts";
import { wakeOwner } from "./wake.ts";

// Each `ps` run that tells whether the lock's holder is still running.
const LOCK_BOUND_MS = 5_000;

// Another writer holds the state lock for one read and one write, so a wait this
// long is a holder that has stopped.
const STATE_WAIT_MS = 5_000;

// Listing the threads for the notes, every page of them.
const LISTING_WAIT_MS = 30_000;

const ALREADY_CLOSED = "the episode had closed before a round took this state";

// Starting the fixer, and reading back what started. A start cut short at this
// bound is recorded as a failure, and the next round's start is not held up.
const FIXER_START_MS = 5_000;

// A reviewed record must name where its reviewer ran. This stands in only where
// a round reviewed without saying where its reviewer started, which is a defect.
const UNREPORTED: ReviewerPlace = { backend: "detached" };

export type HostSetup = {
  /** The worktree whose episode the host serves. */
  readonly worktree: string;
  /** The key of the change whose episode it serves, as `squiz host` was given it. */
  readonly key: string;
  /** What every round runs with, less what the host decides for each. */
  readonly round: Omit<RoundSetup, "worktree" | "held" | "endsOn">;
  /** What changes the state file. `updateState` where not given. */
  readonly update?: typeof updateState;
  /** What takes the host lock. `takeEpisodeHostLock` where not given. */
  readonly lock?: typeof takeEpisodeHostLock;
  /** A line for `host.log` once the host holds the lock, such as one saying the defaults are in use. */
  readonly note?: string;
  /** The environment a fixer's is made from. The host's own where not given. */
  readonly environment?: NodeJS.ProcessEnv;
};

/** Why the host exited. */
export type HostEnd =
  /** The venue names no episode for the key. Nothing was made, and nothing was logged. */
  | { readonly outcome: "no episode"; readonly reason: string }
  | { readonly outcome: "nothing queued" }
  | { readonly outcome: "worktree gone" }
  | { readonly outcome: "lock held"; readonly holder: ProcessIdentity }
  | { readonly outcome: "lock unknown"; readonly reason: string }
  | { readonly outcome: "state unreadable"; readonly reason: string }
  /**
   * A record the host had to write could not be written. Taking the next state
   * would fail the same way, and leave the state it took queued.
   */
  | { readonly outcome: "state unwritable"; readonly reason: string };

/**
 * Run the episode's queued states until none is left, and say why the host
 * stopped.
 *
 * A host that finds the lock held by a live process exits at once, so two
 * triggers that each start one leave one running.
 */
export async function runHost(setup: HostSetup): Promise<HostEnd> {
  // Taking the lock makes the episode's directory, which would make the
  // worktree's directory again where it has gone.
  if (worktreeGone(setup.worktree)) return { outcome: "worktree gone" };
  const named = episodeAt(setup.round.venue, setup.worktree, setup.key);
  if (named.outcome === "failed") return { outcome: "no episode", reason: named.reason };
  const { episode } = named;
  const log = logIn(episode);

  for (let first = true; ; first = false) {
    const taking = (setup.lock ?? takeEpisodeHostLock)(episode, { boundMs: LOCK_BOUND_MS });
    if (taking.outcome === "held") {
      const { pid, startedAt } = taking.holder;
      log(`exiting: process ${pid}, started at ${startedAt}, holds the host lock`);
      return { outcome: "lock held", holder: taking.holder };
    }
    if (taking.outcome === "unknown") {
      log(`exiting: whether another host is running could not be told: ${taking.reason}`);
      return { outcome: "lock unknown", reason: taking.reason };
    }

    let end: HostEnd;
    try {
      if (first && setup.note !== undefined) log(setup.note);
      end = await hostRounds(setup, episode, taking.lock, log);
    } finally {
      taking.lock.release();
    }
    // A trigger that queued a state while this host still held the lock saw it
    // running and started none, so the queue is read again once the lock is free.
    const after = end.outcome === "nothing queued" ? readState(episode) : undefined;
    if (after?.outcome === "read" && queuedIn(after.state).length > 0) {
      log("a state was queued as this host exited: taking the host lock again");
      continue;
    }
    const final: HostEnd = after?.outcome === "unreadable" ? { outcome: "state unreadable", reason: after.reason } : end;
    log(endLine(final));
    return final;
  }
}

type Log = (line: string) => void;

async function hostRounds(setup: HostSetup, episode: Episode, lock: HostLock, log: Log): Promise<HostEnd> {
  const update = setup.update ?? updateState;
  const write = (change: (state: EpisodeState) => EpisodeState): StateUpdate =>
    update(episode, change, { until: deadlineIn(STATE_WAIT_MS) });

  for (;;) {
    if (worktreeGone(episode.worktree)) return { outcome: "worktree gone" };
    const read = readState(episode);
    if (read.outcome === "unreadable") return { outcome: "state unreadable", reason: read.reason };
    const oldest = read.outcome === "read" ? queuedIn(read.state)[0] : undefined;
    if (oldest === undefined) return { outcome: "nothing queued" };

    const startedAt = nowSeconds();
    let taken: { readonly record: QueuedRecord; readonly number: number } | undefined;
    let closed: readonly Recorded[] = [];
    let started: NextEpisode | undefined;
    const took = write((state) => {
      taken = undefined;
      closed = [];
      started = undefined;
      let current = state;
      // The close is checked again here, under the state lock, so a round that
      // closed the episode after this host read the file runs nothing more.
      if (state.closeReported === true) {
        // After a clean close, the records past the closed episode's own were
        // queued for the episode that follows. After any other close there are none.
        const own = closedRecords(state);
        const next = queuedIn({ ...state, records: (state.records ?? []).slice(own.length) });
        // A round of the closed episode still recorded under review keeps its
        // snapshot at the path the new episode's round of that number would use,
        // and its reviewer may still run, so no new episode starts over it.
        const underway = own.find((record) => record.status === "reviewing");
        const blocked = underway?.status === "reviewing" && next.length > 0
          ? `no review ran: round ${underway.round.number} of the closed episode is still recorded under review by round host ${underway.host.pid}`
          : undefined;
        closed = inOrder([
          ...queuedIn({ ...state, records: own }).map((record) => notReviewed(keyOf(record), ALREADY_CLOSED)),
          ...(blocked === undefined ? [] : next.map((record) => failedRecord(keyOf(record), blocked))),
        ]);
        const ended = withRecords(state, closed.map(({ record }) => record));
        if (next.length === 0 || blocked !== undefined) return ended;
        started = startNextEpisode(episode, ended);
        if (started.outcome === "failed") {
          closed = [];
          return state;
        }
        current = started.state;
      }
      const record = queuedIn(current)[0];
      if (record === undefined) return current;
      taken = { record, number: current.rounds.length + 1 };
      const reviewing: StateRecord = {
        ...keyOf(record),
        status: "reviewing",
        host: lock.holder,
        round: { number: taken.number },
      };
      return withRecords(current, [reviewing]);
    });

    const failure =
      took.outcome === "failed"
        ? `the reviewing record could not be written: ${took.reason}`
        : started?.outcome === "failed"
          ? started.reason
          : undefined;
    if (failure !== undefined) {
      const reason = `no review ran: ${failure}`;
      log(`${named(oldest)}: ${reason}`);
      let failed: readonly Recorded[] = [];
      const recorded = write((state) => {
        failed = [];
        const record = queuedIn(state).find((queued) => sameState(queued, oldest));
        if (record === undefined) return state;
        failed = inOrder([failedRecord(keyOf(record), reason)]);
        return withRecords(state, failed.map(({ record: written }) => written));
      });
      if (recorded.outcome === "failed") {
        log(`${named(oldest)}: could not be recorded failed either: ${recorded.reason}`);
        return { outcome: "state unwritable", reason: recorded.reason };
      }
      log(`${named(oldest)}: recorded failed`);
      await noteOwners(episode, failed, log, setup.round.config.fixer !== null);
      continue;
    }
    if (started?.outcome === "started") log(`a new episode starts on a state the clean close never recorded: the closed one is in ${started.directory}`);
    if (closed.length > 0) {
      const unreviewed = closed.filter(({ record }) => record.status === "not reviewed").length;
      if (unreviewed > 0) log(`${unreviewed === 1 ? "1 queued state" : `${unreviewed} queued states`} recorded not reviewed: ${ALREADY_CLOSED}`);
      // A state queued for the next episode that a closed round still blocks failed, and says why.
      for (const { record } of closed) if (record.status === "failed") log(`${named(record)}: recorded failed: ${record.reason}`);
      await noteOwners(episode, closed, log, setup.round.config.fixer !== null);
    }
    const round = taken;
    if (round === undefined) continue;

    log(`round ${round.number}: reviewing ${named(round.record)}`);
    const endsOn = endsOnFor(keyOf(round.record), setup.round.config);
    let ended: RoundEnd | undefined;
    let reviewer: ReviewerPlace | undefined;
    const roundSetup: RoundSetup = {
      ...setup.round,
      worktree: episode.worktree,
      held: { key: episode.key, lock },
      state: { head: round.record.head, activity: round.record.activity },
      ...(round.record.herdrWorkspace === undefined ? {} : { workspace: round.record.herdrWorkspace }),
      reviewerStarted: (session) => {
        reviewer = session.pane === undefined ? { backend: session.backend } : { backend: session.backend, pane: session.pane };
        const noted = write((state) => {
          const record = (state.records ?? []).find((held) => sameState(held, round.record));
          if (record?.status !== "reviewing") return state;
          return withRecords(state, [{ ...record, reviewer: session }]);
        });
        // The review goes on without it. The record is how a person or a later
        // recovery finds the reviewer, and the reviewer runs either way.
        if (noted.outcome === "failed") log(`round ${round.number}: the reviewer's session could not be recorded: ${noted.reason}`);
      },
      paneLeftOpen: (reason) => log(`round ${round.number}: the reviewer's pane was left open: ${reason}`),
      snapshotLeft: (reason) => log(`round ${round.number}: ${reason}; it stays on disk until it is deleted`),
      postingTimeUnwritten: (reason) => log(`round ${round.number}: its posting time could not be written: ${reason}`),
      resumeUnwritten: (reason) => log(`round ${round.number}: its resume command could not be written: ${reason}`),
      endsOn: (tally, queued) => {
        ended = endsOn(tally, queued);
        return ended;
      },
    };
    const end = await runRoundThen(
      roundSetup,
      async (conclusion, change, diff): Promise<HostEnd | undefined> => {
        // Recording the result would make the worktree's directory again.
        if (worktreeGone(episode.worktree)) return { outcome: "worktree gone" };
        const result = resultOf(
          conclusion,
          episodeChange(episode, change),
          ended,
          round.record,
          { number: round.number, startedAt, endedAt: nowSeconds() },
          reviewer,
        );
        let written: readonly Recorded[] = [];
        const recorded = write((state) => {
          written = result.records(state);
          return withRecords(state, written.map(({ record }) => record));
        });
        if (recorded.outcome === "failed") {
          log(`round ${round.number}: ${result.line}, and could not be recorded: ${recorded.reason}`);
          for (const problem of result.problems) log(`round ${round.number}: ${problem}`);
          return { outcome: "state unwritable", reason: recorded.reason };
        }
        log(`round ${round.number}: ${result.line}`);
        for (const problem of result.problems) log(`round ${round.number}: ${problem}`);
        // Listed once, for the notes and the handoff alike, and only where one needs it.
        let listing: Listing | undefined;
        const read = change === undefined ? undefined : { change, listed: () => (listing ??= threadsOf(setup.round.venue, change)) };
        const agent = setup.round.config.fixer;
        await noteOwners(episode, written, log, agent !== null, read);
        const thisRound: Round = { directory: roundDirectory(episode, round.number), label: `round ${round.number}`, log };
        const records = recorded.state.records ?? [];
        const handoffs = read === undefined ? new Map<StateRecord, string>() : handOff(thisRound, written, records, read, diff);
        if (agent !== null) {
          const environment = setup.environment ?? process.env;
          startFixers(episode, thisRound, written, records, handoffs, { agent, environment }, write);
          const close = written.map(({ record }) => closeOf(record)).find((each) => each !== undefined);
          if (close !== undefined) writeClose(episode, close, thisRound);
        }
        return undefined;
      },
    );
    if (end !== undefined) return end;
  }
}

/**
 * How a round decides its end: from the state it reviewed, the configured round
 * cap and token bound, and the states queued behind it.
 */
export function endsOnFor(
  state: EndedRound["state"],
  config: Pick<Config, "rounds" | "tokens">,
): RoundSetup["endsOn"] {
  return (tally, queued) =>
    decideRoundEnd({ ...tally, state }, { rounds: config.rounds, tokens: config.tokens }, queued);
}

/**
 * A record the host wrote, and how a note to its owner names its state.
 *
 * `closed` is the bound a failed round left spent. It goes to the note and not
 * to the record, because the next run reads the bounds from the state anyway.
 */
type Recorded = { readonly record: StateRecord; readonly name: string; readonly closed?: ClosedBy };

/**
 * `records` with the name each is told apart by, in order: its short commit,
 * and where a state before it has that commit, that its replies differ.
 *
 * `after` is the state reviewed before them, where one was.
 */
function inOrder(records: readonly StateRecord[], after: StateKey | null = null): Recorded[] {
  const names = namedStates(after, records);
  return records.map((record, index) => ({ record, name: names[index] ?? record.head.slice(0, 7) }));
}

/** The change a round read, and the threads on it as they stand once its result is recorded. */
type Read = { readonly change: Change; readonly listed: () => Listing };

/**
 * Write a note for the owner of each of `recorded` that gets one, and wake each
 * owner that has a socket. `read` lists the threads a note prints, and its
 * change gives the note's follow-up.
 *
 * Without one, no note prints threads or a follow-up: only a round that read
 * its change records threads open. A `headless` run wakes no one: its session
 * has ended by the time its review does.
 */
async function noteOwners(episode: Episode, recorded: readonly Recorded[], log: Log, headless: boolean, read?: Read): Promise<void> {
  const notes = join(episode.directory, "notes");
  const change = episodeChange(episode, read?.change);
  for (const { record, name, closed } of recorded) {
    const listed = printsThreads(record) && read !== undefined ? read.listed() : undefined;
    if (listed !== undefined && "reason" in listed) {
      log(`${named(record)}: the threads could not be listed for its note: ${listed.reason}`);
    }
    const threads = listed !== undefined && "threads" in listed ? listed.threads : undefined;
    if (threads !== undefined && record.status === "reviewed" && record.result === "exited" && threadsToPrint(record.openThreads, threads).length === 0) {
      log(`${named(record)}: none of the threads the round left open is open on ${change.name}, so its note points to squiz review`);
    }
    const note = ownerNote(change, record, name, read?.change.followUp ?? "", closed, threads);
    if (note === undefined) continue;
    const written = writeNote(notes, note.sessionId, note.fields);
    if (written.outcome === "failed") {
      log(`${named(record)}: ${written.reason}`);
      continue;
    }
    log(`${named(record)}: noted its owner, ${note.sessionId}`);

    const socket = record.owner?.messagingSocket;
    const text = note.fields["text"];
    if (socket === undefined || text === undefined) continue;
    if (headless) {
      log(`${named(record)}: no wake: .squiz.json names a fixer, so the run is headless`);
      continue;
    }
    const woken = await wakeOwner({ notes, sessionId: note.sessionId, name: written.name, socket, text });
    if (woken.outcome === "woken") log(`${named(record)}: woke its owner through ${socket}`);
    else if (woken.outcome === "already delivered") log(`${named(record)}: its note was delivered before the host could post it`);
    else log(`${named(record)}: did not wake its owner: ${woken.reason}`);
  }
}

/**
 * Write `handoff.md` into `directory`, the round's own, for each of `recorded`
 * that gets a handoff, and say in host.log what was written or why nothing was.
 *
 * `records` is the episode's records once the round's result is recorded, and
 * `diff` the diff the round's reviewer read. Where the threads cannot be listed,
 * or the diff was not kept, no handoff is written, because one without them
 * would read as whole. Returns the path written for each record that got one.
 */
function handOff(
  { directory, label: round, log }: Round,
  recorded: readonly Recorded[],
  records: readonly StateRecord[],
  read: Read,
  diff: string | undefined,
): Map<StateRecord, string> {
  const written = new Map<StateRecord, string>();
  for (const { record } of recorded) {
    if (!handsBack(record)) continue;
    const listed = read.listed();
    if ("reason" in listed) {
      log(`${round}: wrote no handoff: the threads could not be listed: ${listed.reason}`);
      continue;
    }
    if (diff === undefined) {
      log(`${round}: wrote no handoff: the round kept no diff`);
      continue;
    }
    const path = join(directory, "handoff.md");
    // The result is recorded by now, and a throw here would stop the host
    // before the states queued behind it.
    try {
      const handoff = handoffFor(read.change, record, listed.threads, diff, records);
      if (handoff.outcome === "none") continue;
      if (handoff.outcome === "no open thread listed") {
        log(`${round}: wrote no handoff: none of the threads the round left open is open on ${read.change.name}`);
        continue;
      }
      writeFileSync(path, handoff.text, "utf8");
      written.set(record, path);
      log(`${round}: wrote the handoff to ${path}`);
    } catch (cause) {
      log(`${round}: wrote no handoff to ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  return written;
}

/** A round's directory, how `host.log` names it, and the log. */
type Round = { readonly directory: string; readonly label: string; readonly log: Log };

/**
 * Start a fixer on the handoff of each of `recorded` that hands its threads
 * back, and record on its state how the start went.
 *
 * A state that got no handoff gets no fixer, and its record says so. That
 * record, and `host.log`, are what tell a fixer that did not start from a
 * round that needed none.
 */
function startFixers(
  episode: Episode,
  { directory, label, log }: Round,
  recorded: readonly Recorded[],
  records: readonly StateRecord[],
  handoffs: ReadonlyMap<StateRecord, string>,
  { agent, environment }: { readonly agent: FixerAgent; readonly environment: NodeJS.ProcessEnv },
  write: (change: (state: EpisodeState) => EpisodeState) => StateUpdate,
): void {
  const logPath = join(directory, "fixer.log");
  const put = (record: StateRecord, fixer: FixerStart): StateUpdate =>
    write((state) => {
      const held = (state.records ?? []).find((each) => sameState(each, record));
      if (held?.status !== "reviewed" || held.result !== "exited") return state;
      return withRecords(state, [{ ...held, fixer }]);
    });
  for (const { record } of recorded) {
    if (!handsBack(record)) continue;
    const handoff = handoffs.get(record);
    const held = handoff === undefined ? { outcome: "not started" as const, reason: "no handoff was written" } : runningFixer(records, record);
    if (held !== undefined) {
      log(`${label}: ${fixerLine(held, logPath)}`);
      const noted = put(record, held);
      if (noted.outcome === "failed") log(`${label}: why no fixer started could not be recorded: ${noted.reason}`);
      continue;
    }
    // Reserved before the start, so a start the state file then refuses still
    // holds back every later fixer, as one that cannot be told gone does.
    const reserved = put(record, { outcome: "unknown", agent, reason: "its start was never recorded" });
    if (reserved.outcome === "failed") {
      log(`${label}: no fixer started: its start could not be reserved: ${reserved.reason}`);
      continue;
    }
    const fixer = fixerStarted(agent, startFixer({ agent, handoff: handoff ?? "", worktree: episode.worktree, logPath, environment }, FIXER_START_MS));
    log(`${label}: ${fixerLine(fixer, logPath)}`);
    const noted = put(record, fixer);
    if (noted.outcome === "failed") log(`${label}: the fixer's start could not be recorded: ${noted.reason}`);
  }
}

/**
 * Why no fixer is started for `record`: a fixer an earlier round started is
 * still running. Its own stop starts the next round, and a second fixer beside
 * it would edit the same tree. `undefined` where none is.
 */
function runningFixer(records: readonly StateRecord[], record: StateRecord): FixerStart | undefined {
  for (const earlier of records) {
    if (earlier === record || earlier.status !== "reviewed" || earlier.result !== "exited") continue;
    if (earlier.fixer?.outcome === "unknown") {
      return { outcome: "not started", reason: `whether the fixer round ${earlier.round.number} started could not be told, so it may still be running` };
    }
    if (earlier.fixer?.outcome !== "started") continue;
    // One that cannot be told running or gone is left to run, and none is started beside it.
    if (stillRunning(earlier.fixer.process, FIXER_START_MS).outcome === "gone") continue;
    return { outcome: "not started", reason: `the fixer round ${earlier.round.number} started, process ${earlier.fixer.process.pid}, is still running` };
  }
  return undefined;
}

function fixerStarted(agent: FixerAgent, detached: ReturnType<typeof startFixer>): FixerStart {
  switch (detached.outcome) {
    case "started":
      return { outcome: "started", agent, process: detached.identity };
    case "exited":
      return { outcome: "exited", agent, pid: detached.pid };
    case "failed":
      return { outcome: "failed", agent, reason: detached.reason };
    case "unknown":
      return { outcome: "unknown", agent, reason: detached.reason };
  }
}

function fixerLine(fixer: FixerStart, output: string): string {
  switch (fixer.outcome) {
    case "started":
      return `started the fixer, ${fixer.agent}, as process ${fixer.process.pid}, writing to ${output}`;
    case "exited":
      return `started the fixer, ${fixer.agent}, as process ${fixer.pid}, writing to ${output}; it had exited before it could be checked`;
    case "failed":
      return `the fixer, ${fixer.agent}, did not start: ${fixer.reason}`;
    case "unknown":
      return `whether the fixer, ${fixer.agent}, started could not be told: ${fixer.reason}`;
    case "not started":
      return `no fixer started: ${fixer.reason}`;
  }
}

/** What `closed.json` holds: the close a round recorded on its state. */
type Close = {
  readonly head: string;
  readonly exitStatus: 0 | 3;
  readonly openThreads: readonly string[];
  readonly closedAt?: ClosingBound;
};

/** The close `record` carries, where it is one. */
function closeOf(record: StateRecord): Close | undefined {
  if (record.status === "reviewed" && record.result === "exited" && record.exitStatus !== 2) {
    const { head, exitStatus, openThreads, closedAt } = record;
    return { head, exitStatus, openThreads, ...(closedAt === undefined ? {} : { closedAt }) };
  }
  if (record.status === "not reviewed" && record.closed !== undefined) {
    const { exitStatus, openThreads, closedAt } = record.closed;
    return { head: record.head, exitStatus, openThreads, closedAt };
  }
  return undefined;
}

/**
 * Write `close` to the episode's `closed.json`, whole or not at all, so a caller
 * waiting on the file never reads half of it.
 */
function writeClose(episode: Episode, close: Close, { label: round, log }: Round): void {
  const path = join(episode.directory, CLOSE_FILE);
  try {
    writeFileSync(`${path}.${process.pid}`, `${JSON.stringify(close, null, 2)}\n`, "utf8");
    renameSync(`${path}.${process.pid}`, path);
    log(`${round}: wrote the close to ${path}`);
  } catch (cause) {
    log(`${round}: wrote no close to ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/**
 * The episode's change as its records and notes name it: the change the round
 * read, where it read the episode's own.
 *
 * Where it read none, or another, the venue has named nothing, and the name and
 * the rerun are made from the key alone, as a pull request's would be.
 */
function episodeChange(episode: Episode, read: Change | undefined): Pick<Change, "key" | "name" | "rerun"> {
  if (read !== undefined && read.key === episode.key) return read;
  return { key: episode.key, name: `PR #${episode.key}`, rerun: `squiz review ${episode.key}` };
}

type Listing = { readonly threads: readonly ReviewThread[] } | { readonly reason: string };

/** Whether the note for `record` carries threads, and so needs them listed. */
function printsThreads(record: StateRecord): boolean {
  return record.owner !== undefined && record.status === "reviewed" && record.result === "exited" && record.openThreads.length > 0;
}

/** The threads on `change` as they stand now. */
function threadsOf(venue: Venue, change: Change): Listing {
  const listed = venue.listThreads(change, deadlineIn(LISTING_WAIT_MS));
  return listed.outcome === "listed" ? { threads: listed.threads } : { reason: listed.reason };
}

/** When a round started and ended, and its number. */
type Timing = { readonly number: number; readonly startedAt: number; readonly endedAt: number };

/**
 * The records a round's conclusion writes into the state it finds, the line
 * host.log says it in, and a line each for what failed beside the result.
 */
type Result = {
  readonly records: (state: EpisodeState) => readonly Recorded[];
  readonly line: string;
  readonly problems: readonly string[];
};

/**
 * The records a round's conclusion leaves, for its own state and for the states
 * queued behind it.
 *
 * `ended` is what the round decided where it reviewed. A close before the review
 * decides none, and its state was never reviewed.
 */
function resultOf(
  conclusion: RoundConclusion,
  change: Pick<Change, "name">,
  ended: RoundEnd | undefined,
  taken: QueuedRecord,
  timing: Timing,
  reviewer: ReviewerPlace | undefined,
): Result {
  const key = keyOf(taken);
  switch (conclusion.outcome) {
    case "block":
    case "clean, episode open":
    case "close": {
      if (conclusion.outcome === "close" && conclusion.beforeReview !== undefined) {
        return closedUnreviewed(conclusion, change, conclusion.beforeReview.openThreads, taken);
      }
      if (ended === undefined) {
        // A round that reviewed always asks for its end, so only a defect reaches this.
        const reason = "the round reviewed and reached no end";
        return {
          records: () => inOrder([{ ...failedRecord(key, reason), round: timing }]),
          line: `${named(taken)} failed: ${reason}`,
          problems: [],
        };
      }
      const round = { ...timing, reviewer: reviewer ?? UNREPORTED };
      const report = reportOf(conclusion, change, ended);
      const reviewed: Recorded = {
        record: { ...ended.record, round, ...report },
        name: taken.head.slice(0, 7),
      };
      const left = ended.outcome === "closed" ? ended.leftNotReviewed : null;
      const behind = left === null ? [] : inOrder(left.states, left.after);
      return {
        records: () => [reviewed, ...behind],
        line: `${named(taken)} ${endedLine(ended)}`,
        problems: report.problems ?? [],
      };
    }
    case "superseded": {
      const reason = `superseded by ${supersededBy(taken, conclusion.by)}`;
      const by = { head: conclusion.by.head, activity: conclusion.by.activity };
      const record = { ...notReviewed(key, reason), supersededBy: by };
      const line = `${named(taken)} not reviewed: ${reason}`;
      if (conclusion.closing === undefined) return { records: () => inOrder([record]), line, problems: [] };
      const problems = summaryProblems(change, conclusion.closing.summary);
      return {
        // The clean round the pull request returned to closed the episode, so its
        // record becomes the close, and its owner is told.
        records: (state) => {
          const clean = (state.records ?? []).find((held) => sameState(held, by));
          if (clean?.status !== "reviewed" || clean.result !== "clean, episode open") return inOrder([record]);
          // A close names the findings no thread holds in its summary, so its record keeps none.
          const { result: _clean, unthreaded: _named, problems: earlier = [], ...kept } = clean;
          const all = [...earlier, ...problems];
          const closed: StateRecord = {
            ...kept,
            result: "exited",
            exitStatus: 0,
            openThreads: [],
            ...(all.length === 0 ? {} : { problems: all }),
          };
          return [...inOrder([record]), { record: closed, name: clean.head.slice(0, 7) }];
        },
        line: `${line}, and the episode closed on it`,
        problems,
      };
    }
    case "episode-over":
      return {
        records: (state) => inOrder([key, ...queuedIn(state).map(keyOf)].map((left) => notReviewed(left, ALREADY_CLOSED))),
        line: `${named(taken)} not reviewed: ${ALREADY_CLOSED}`,
        problems: [],
      };
    case "failed":
    case "no-pull-request":
    case "round-running": {
      const reason = failureOf(conclusion, change);
      const round = reviewer === undefined ? timing : { ...timing, reviewer };
      const lines = conclusion.outcome === "failed" ? failureLinesOf(conclusion, change) : [];
      const failed = { ...failedRecord(key, reason), round, ...(lines.length === 0 ? {} : { lines }) };
      const closed = conclusion.outcome === "failed" ? conclusion.closed : undefined;
      return {
        records: () => inOrder([failed]).map((written) => (closed === undefined ? written : { ...written, closed })),
        line: `${named(taken)} failed: ${reason}`,
        problems: [],
      };
    }
  }
}

/**
 * The records of a close reached before the review: the state the round took,
 * carrying the close, and every state queued behind it, each not reviewed.
 */
function closedUnreviewed(
  conclusion: Extract<RoundConclusion, { readonly outcome: "close" }>,
  change: Pick<Change, "name">,
  openThreads: readonly string[],
  taken: QueuedRecord,
): Result {
  const bound = conclusion.because === "token-bound" ? "token-bound" : "round-cap";
  const reason = closedBeforeReview(bound);
  const problems = summaryProblems(change, conclusion.summary);
  const closed: ClosedBeforeReview = {
    exitStatus: 3,
    openThreads,
    closedAt: bound === "token-bound" ? "token bound" : "round cap",
    ...(problems.length === 0 ? {} : { problems }),
  };
  return {
    records: (state) => {
      const behind = queuedIn(state).map((record) => notReviewed(keyOf(record), reason));
      return inOrder([{ ...notReviewed(keyOf(taken), reason), closed }, ...behind], lastReviewed(state.records ?? []));
    },
    line: `${named(taken)} not reviewed: ${reason}`,
    problems,
  };
}

/** The line `squiz review` prints on stderr for a close with no summary on the pull request, or none. */
function summaryProblems(change: Pick<Change, "name">, summary: EpisodeSummary): readonly string[] {
  if (summary.outcome === "posted") return [];
  return [`the review of ${change.name} closed without its summary: ${summary.reason}`];
}

/** What a round that reviewed did beside its result, as `squiz review` prints it. */
function reportOf(
  conclusion: Extract<RoundConclusion, { readonly outcome: "block" | "clean, episode open" | "close" }>,
  change: Pick<Change, "name">,
  ended: RoundEnd,
): RoundReport & { readonly closedAt?: ClosingBound } {
  const problems = [
    ...unpostedReasons(conclusion.verdicts),
    ...unappliedRulings(conclusion.verdicts),
    ...(conclusion.outcome === "close" ? summaryProblems(change, conclusion.summary) : []),
  ];
  // Only a close that left threads open is printed with its bound.
  const bound = ended.outcome === "closed" && ended.record.result === "exited" && ended.record.exitStatus === 3 ? ended.because : undefined;
  const outcomes = conclusion.findings.outcomes;
  const failed = outcomes.filter((outcome) => outcome.outcome === "failed").length;
  // A close names them in its summary. A round that left the episode open posts
  // none, so this record is where they are kept until the close reads them.
  const unthreaded = conclusion.outcome === "close" ? [] : unthreadedNotes(conclusion.findings);
  return {
    newFindings: conclusion.posted.length,
    ...(failed === 0 ? {} : { unposted: { failed, of: outcomes.length } }),
    ...(problems.length === 0 ? {} : { problems }),
    ...(unthreaded.length === 0 ? {} : { unthreaded }),
    ...(bound === "round-cap" ? { closedAt: "round cap" } : bound === "token-bound" ? { closedAt: "token bound" } : {}),
  };
}

/** Where a failed round's comment went, as `squiz review` prints it after the reason. */
export function failureLinesOf(
  conclusion: Extract<RoundConclusion, { readonly outcome: "failed" }>,
  change: Pick<Change, "name">,
): readonly string[] {
  const comment = conclusion.failureComment;
  const went =
    comment === undefined
      ? []
      : [
          comment.posting.outcome === "posted"
            ? `the failure is posted on ${change.name}`
            : `the failure could not be posted on ${change.name}: ${comment.posting.reason}`,
        ];
  const verdicts = conclusion.salvaged?.verdicts;
  return [...(verdicts === undefined ? [] : [...unpostedReasons(verdicts), ...unappliedRulings(verdicts)]), ...went];
}

/** Why a round that reviewed nothing for its state failed. */
function failureOf(
  conclusion: Extract<RoundConclusion, { readonly outcome: "failed" | "no-pull-request" | "round-running" }>,
  change: Pick<Change, "name">,
): string {
  switch (conclusion.outcome) {
    case "failed":
      return conclusion.reason;
    case "no-pull-request":
      return `no review ran: ${conclusion.reason}`;
    case "round-running":
      // The round runs under the host's own lock, so only a defect reaches this.
      return `no review ran: a round is already running on ${change.name}`;
  }
}

/**
 * The state that superseded `taken`, as a person tells it apart: its short head
 * commit, and on the same commit, that its replies differ.
 */
function supersededBy(taken: StateKey, by: StateKey): string {
  const commit = by.head.slice(0, 7);
  return by.head === taken.head ? `${commit} with different replies` : commit;
}

function endedLine(ended: RoundEnd): string {
  switch (ended.outcome) {
    case "threads open":
      return `reviewed, ${ended.record.result === "exited" ? ended.record.openThreads.length : 0} threads open`;
    case "reviewed clean, episode open":
      return "reviewed clean, episode open";
    case "closed": {
      const behind = ended.leftNotReviewed?.states.length ?? 0;
      return `reviewed, episode closed (${ended.because})${behind === 0 ? "" : `, ${behind} queued behind it not reviewed`}`;
    }
  }
}

function endLine(end: HostEnd): string {
  switch (end.outcome) {
    case "nothing queued":
      return "exiting: nothing is left queued";
    case "worktree gone":
      return "exiting: the worktree is gone";
    case "no episode":
    case "state unreadable":
      return `exiting: ${end.reason}`;
    case "state unwritable":
      return `exiting: the state file could not be written: ${end.reason}`;
    case "lock held":
    case "lock unknown":
      return `exiting: ${end.outcome}`;
  }
}

/** The states still queued, oldest first, as the state file keeps them. */
function queuedIn(state: EpisodeState): readonly QueuedRecord[] {
  return (state.records ?? []).filter((record): record is QueuedRecord => record.status === "queued");
}

/** A record's state and what the trigger knew of it, without where its review has got to. */
function keyOf(record: QueuedRecord): Omit<QueuedRecord, "status"> {
  const { status: _queued, ...key } = record;
  return key;
}

function notReviewed(key: Omit<QueuedRecord, "status">, reason: string): NotReviewedRecord {
  return { ...key, status: "not reviewed", reason };
}

/**
 * A failed record, marked noted wherever it has an owner.
 *
 * The mark goes in with the failure, before the note is written, so a note that
 * then cannot be written leaves it set. The state is queued again only by
 * `squiz review`, which records no owner, so a retry that fails again gets no
 * second note.
 */
function failedRecord(key: Omit<QueuedRecord, "status">, reason: string): Extract<StateRecord, { readonly status: "failed" }> {
  return { ...key, status: "failed", reason, ownerNoted: key.owner !== undefined };
}

function withRecords(state: EpisodeState, records: readonly StateRecord[]): EpisodeState {
  return { ...state, records: records.reduce(putRecord, state.records ?? []) };
}

function named(key: StateKey): string {
  return key.activity === null ? key.head.slice(0, 7) : `${key.head.slice(0, 7)} with reply ${key.activity}`;
}

/**
 * Whether the worktree the host serves is gone.
 *
 * Asked of its `.git` rather than of its directory: a round's state writes make
 * the episode's directory where it is missing, so a directory removed during a
 * round can be back, holding nothing but `.squiz/`.
 */
function worktreeGone(worktree: string): boolean {
  return !existsSync(join(worktree, ".git"));
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

/**
 * A writer of lines to the episode's `host.log`.
 *
 * A line that cannot be written is dropped. The log is the host's only
 * channel, and a worktree that has gone takes it with it.
 */
function logIn(episode: Episode): Log {
  const file = join(episode.directory, "host.log");
  return (line) => {
    try {
      if (existsSync(episode.directory)) appendFileSync(file, `${new Date().toISOString()} ${line}\n`, "utf8");
    } catch {
      // Nowhere else to say it.
    }
  };
}
