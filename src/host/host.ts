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
 */

import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { unthreadedNotes } from "../loop/summary-body.ts";
import type { Change, ReviewThread, Venue } from "../venues/venue.ts";
import { unappliedRulings, unpostedReasons } from "../loop/verdicts.ts";
import { readState, type EpisodeState } from "../loop/episode-state.ts";
import { episodeAt, type Episode } from "../loop/episode.ts";
import type { Config } from "../config/config.ts";
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
  type ReviewerPlace,
  type RoundReport,
  type StateKey,
  type StateRecord,
} from "../loop/state-record.ts";
import { updateState, type StateUpdate } from "../loop/state-update.ts";
import { deadlineIn } from "../reviewers/deadline.ts";
import { writeNote } from "../sessions/notes.ts";
import type { ProcessIdentity } from "../sessions/process.ts";
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
    const took = write((state) => {
      taken = undefined;
      closed = [];
      // The close is checked again here, under the state lock, so a round that
      // closed the episode after this host read the file runs nothing more.
      if (state.closeReported === true) {
        closed = inOrder(queuedIn(state).map((record) => notReviewed(keyOf(record), ALREADY_CLOSED)));
        return withRecords(state, closed.map(({ record }) => record));
      }
      const record = queuedIn(state)[0];
      if (record === undefined) return state;
      taken = { record, number: state.rounds.length + 1 };
      const reviewing: StateRecord = {
        ...keyOf(record),
        status: "reviewing",
        host: lock.holder,
        round: { number: taken.number },
      };
      return withRecords(state, [reviewing]);
    });

    if (took.outcome === "failed") {
      const reason = `no review ran: the reviewing record could not be written: ${took.reason}`;
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
      await noteOwners(episode, failed, log);
      continue;
    }
    if (closed.length > 0) {
      log(`${closed.length === 1 ? "1 queued state" : `${closed.length} queued states`} recorded not reviewed: ${ALREADY_CLOSED}`);
      await noteOwners(episode, closed, log);
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
      async (conclusion, change): Promise<HostEnd | undefined> => {
        // Recording the result would make the worktree's directory again.
        if (worktreeGone(episode.worktree)) return { outcome: "worktree gone" };
        const result = resultOf(
          conclusion,
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
        await noteOwners(episode, written, log, change === undefined ? undefined : { venue: setup.round.venue, change });
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

/**
 * Write a note for the owner of each of `recorded` that gets one, and wake each
 * owner that has a socket. `read` is the change a round read and its venue,
 * which list the threads a note prints and give its follow-up.
 *
 * Without one, no note prints threads or a follow-up: only a round that read
 * its change records threads open.
 */
async function noteOwners(
  episode: Episode,
  recorded: readonly Recorded[],
  log: Log,
  read?: { readonly venue: Venue; readonly change: Change },
): Promise<void> {
  const notes = join(episode.directory, "notes");
  // Listed once for all the notes, and only where one prints threads.
  let listing: Listing | undefined;
  for (const { record, name, closed } of recorded) {
    const listed = printsThreads(record) && read !== undefined ? (listing ??= threadsOf(read.venue, read.change)) : undefined;
    if (listed !== undefined && "reason" in listed) {
      log(`${named(record)}: the threads could not be listed for its note: ${listed.reason}`);
    }
    const threads = listed !== undefined && "threads" in listed ? listed.threads : undefined;
    if (threads !== undefined && record.status === "reviewed" && record.result === "exited" && threadsToPrint(record.openThreads, threads).length === 0) {
      log(`${named(record)}: none of the threads the round left open is open on PR #${episode.key}, so its note points to squiz review`);
    }
    const note = ownerNote(episode.key, record, name, read?.change.followUp ?? "", closed, threads);
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
    const woken = await wakeOwner({ notes, sessionId: note.sessionId, name: written.name, socket, text });
    if (woken.outcome === "woken") log(`${named(record)}: woke its owner through ${socket}`);
    else if (woken.outcome === "already delivered") log(`${named(record)}: its note was delivered before the host could post it`);
    else log(`${named(record)}: did not wake its owner: ${woken.reason}`);
  }
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
        return closedUnreviewed(conclusion, conclusion.beforeReview.openThreads, taken);
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
      const report = reportOf(conclusion, ended);
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
      const problems = summaryProblems(conclusion.key, conclusion.closing.summary);
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
      const reason = failureOf(conclusion);
      const round = reviewer === undefined ? timing : { ...timing, reviewer };
      const lines = conclusion.outcome === "failed" ? failureLinesOf(conclusion) : [];
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
  openThreads: readonly string[],
  taken: QueuedRecord,
): Result {
  const bound = conclusion.because === "token-bound" ? "token-bound" : "round-cap";
  const reason = closedBeforeReview(bound);
  const problems = summaryProblems(conclusion.key, conclusion.summary);
  const closed: ClosedBeforeReview = {
    exitStatus: openThreads.length === 0 ? 0 : 3,
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
function summaryProblems(key: string, summary: EpisodeSummary): readonly string[] {
  if (summary.outcome === "posted") return [];
  return [`the review of PR #${key} closed without its summary: ${summary.reason}`];
}

/** What a round that reviewed did beside its result, as `squiz review` prints it. */
function reportOf(
  conclusion: Extract<RoundConclusion, { readonly outcome: "block" | "clean, episode open" | "close" }>,
  ended: RoundEnd,
): RoundReport & { readonly closedAt?: ClosingBound } {
  const problems = [
    ...unpostedReasons(conclusion.verdicts),
    ...unappliedRulings(conclusion.verdicts),
    ...(conclusion.outcome === "close" ? summaryProblems(conclusion.key, conclusion.summary) : []),
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
export function failureLinesOf(conclusion: Extract<RoundConclusion, { readonly outcome: "failed" }>): readonly string[] {
  const comment = conclusion.failureComment;
  const went =
    comment === undefined
      ? []
      : [
          comment.posting.outcome === "posted"
            ? `the failure is posted on PR #${comment.key}`
            : `the failure could not be posted on PR #${comment.key}: ${comment.posting.reason}`,
        ];
  const verdicts = conclusion.salvaged?.verdicts;
  return [...(verdicts === undefined ? [] : [...unpostedReasons(verdicts), ...unappliedRulings(verdicts)]), ...went];
}

/** Why a round that reviewed nothing for its state failed. */
function failureOf(conclusion: Extract<RoundConclusion, { readonly outcome: "failed" | "no-pull-request" | "round-running" }>): string {
  switch (conclusion.outcome) {
    case "failed":
      return conclusion.reason;
    case "no-pull-request":
      return `no review ran: ${conclusion.reason}`;
    case "round-running":
      // The round runs under the host's own lock, so only a defect reaches this.
      return `no review ran: a round is already running on PR #${conclusion.key}`;
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
