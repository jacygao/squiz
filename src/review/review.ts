/**
 * `squiz review <key>`: trigger a review of the change's state, then
 * wait for that state's round and print what it reached.
 *
 * Five things here fail silently when wrong:
 *
 * - The result of another state. The run waits on the record for the state its
 *   trigger read, its head and its activity, and never on the newest record. The
 *   one exception is a state reviewed clean with a later one queued behind it,
 *   which waits for the state the queue ends on.
 * - A deadline read as a failure. A run whose deadline arrives while its state
 *   is queued or under review exits 4, and the round goes on in its host.
 * - A wait that spins. The state file is read without the lock, because every
 *   write replaces it whole, and read again only after a pause.
 * - A newer state nobody queued. The round host can be the first to read one,
 *   when GitHub answered the trigger with the head from before a push, and a
 *   run waiting on the state it superseded would wait out its deadline with no
 *   round running. The run triggers again, which queues it.
 * - A host whose start was unknown. It may never have started, and then nothing
 *   takes the state, so the run waits on it only once a live host holds the lock.
 *
 * Stopping the command ends only the wait: the round host was started in a
 * session of its own, and nothing here signals it.
 */

import { join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { defaultsLine, findProjectConfig, type Config, type ProjectConfig } from "../config/config.ts";
import { readComment } from "../findings/comment.ts";
import { failureLine } from "../hook/report.ts";
import { trigger as triggerReview, type HostCommand, type Triggered, type TriggerRequest } from "../host/trigger.ts";
import { episodeOver, readState, type EpisodeState } from "../loop/episode-state.ts";
import { archivedEpisodes } from "../loop/archive.ts";
import { episodeAt, type Episode } from "../loop/episode.ts";
import { lastReviewed, namedStates } from "../loop/round-end.ts";
import { recordFor, sameState, type ClosedBeforeReview, type ClosingBound, type StateKey, type StateRecord } from "../loop/state-record.ts";
import { deadlineIn, type Deadline } from "../reviewers/deadline.ts";
import { lockHolder } from "../sessions/lock-file.ts";
import { stillRunning, type Presence, type ProcessIdentity } from "../sessions/process.ts";
import { venueFor, type Change, type ReviewThread, type Venue } from "../venues/venue.ts";
import { worktreeToplevel } from "../worktree/toplevel.ts";
import { printReview, unprinted, type Printed, type ReviewResult } from "./output.ts";

// Claude Code gives a shell command at most 600 seconds, and the minute left
// covers the process starting and stopping.
export const REVIEW_BUDGET_MS = 540_000;

const POLL_MS = 1_000;

// A result reached just before the deadline still has its threads read back,
// rather than becoming exit 4 for want of a listing.
const READ_BACK_FLOOR_MS = 10_000;

// A host that started takes its lock within a second or two of starting.
const HOST_START_MS = 10_000;

export type ReviewRequest = {
  /** Where the command ran. */
  readonly directory: string;
  readonly key: string;
  /** Read for `HERDR_WORKSPACE_ID`. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** The run's one deadline, counted from its start. 540 seconds from now where not given. */
  readonly until?: Deadline;
  /** The pause between readings of the state file. */
  readonly pollMs?: number;
  /** How long a host whose start was unknown has to take its lock. 10 seconds where not given. */
  readonly hostStartMs?: number;
  /** `trigger` where not given. */
  readonly trigger?: (request: TriggerRequest) => Triggered;
  /** The venue the main worktree's `.squiz.json` names where not given. */
  readonly venue?: Venue;
  readonly presence?: (identity: ProcessIdentity, boundMs: number) => Presence;
  readonly host?: (key: string) => HostCommand;
};

/** Trigger, wait and compose the run's output. Never throws for anything git, `gh` or the filesystem does. */
export async function runReview(request: ReviewRequest): Promise<Printed> {
  const until = request.until ?? deadlineIn(REVIEW_BUDGET_MS);
  const { directory } = request;
  // Nothing is written for a run that exits 1, so no episode is needed to print one.
  const notRun = (reason: string): Printed => unprinted(`no review ran: ${reason}`);

  const toplevel = worktreeToplevel(directory, until);
  if (toplevel.outcome === "failed") return notRun(`the worktree could not be resolved: ${toplevel.reason}`);
  let project: ProjectConfig;
  try {
    project = findProjectConfig(toplevel.path, until);
  } catch (cause) {
    // The settings refuse a value they cannot use by throwing.
    return notRun(cause instanceof Error ? cause.message : String(cause));
  }

  const printed = await reviewUnder(request, toplevel.path, until, project.config);
  // Running on the defaults changes neither the outcome nor the status, and is
  // otherwise told from running on a file only by the summary's reviewer line.
  const note = defaultsLine(project);
  return note === undefined ? printed : { ...printed, stderr: failureLine(note) + printed.stderr };
}

/** The run once `config` is read for `worktree`. */
async function reviewUnder(request: ReviewRequest, worktree: string, until: Deadline, config: Config): Promise<Printed> {
  const { directory, key } = request;
  const cap = config.rounds;
  const venue = request.venue ?? venueFor(config);
  // Named before the change is read, so a key that names no episode reads
  // nothing and makes nothing.
  const named = episodeAt(venue, worktree, key);
  if (named.outcome === "failed") return unprinted(`no review ran: ${named.reason}`);
  const { episode } = named;
  const print = (result: ReviewResult): Printed => printReview(result, episode);
  const notRun = (reason: string): Printed => print({ outcome: "not run", key, reason });

  const triggerNow = (): Triggered =>
    (request.trigger ?? triggerReview)({
      directory,
      trigger: "review",
      key,
      venue,
      environment: request.environment,
      until,
      ...(request.presence === undefined ? {} : { presence: request.presence }),
      ...(request.host === undefined ? {} : { host: request.host }),
    });
  const first = triggerNow();
  if (first.outcome === "held") return print({ outcome: "held", key, line: first.line });
  if (first.outcome !== "decided") return notRun(first.reason);

  let triggered = first;
  let context: Context = { key, name: first.change.name, rerun: first.change.rerun, summaryAt: first.change.summaryAt, cap, own: first.state, followUp: first.change.followUp };
  const read = (): EpisodeState | string => {
    const found = readState(episode);
    if (found.outcome === "unreadable") return found.reason;
    return found.outcome === "read" ? found.state : { rounds: [], spentOutsideRounds: { dollars: 0, tokens: 0, messages: 0 } };
  };
  const finish = (settled: Settled, threads: readonly ReviewThread[]): Printed =>
    print(settled.kind === "result" ? settled.result : settled.compose(threads));
  const hostNamed = (): string => {
    const state = read();
    const record = typeof state === "string" ? undefined : recordFor(state.records ?? [], context.own);
    return record?.status === "reviewing" ? `round host ${record.host.pid}` : "the round host";
  };

  /** What the run prints from the latest trigger's decision alone, or `undefined` where it waits. */
  const decided = (): Printed | undefined => {
    const { decision, threads, host } = triggered;
    switch (decision.outcome) {
      case "closed": {
        // The close the trigger decided from, which a new head may have archived
        // and a later episode replaced since.
        const state = triggered.read ?? read();
        if (typeof state === "string") return notRun(state);
        return print(closedResult(context, state, threads));
      }
      case "host-unknown":
        return notRun(`whether ${hostNamed()} for ${context.name} is still running could not be told: ${decision.reason}`);
      case "recover":
        // Nothing here recovers the round, so the run reports it killed, which is
        // what its record reads as. A new commit or reply is a state it never held.
        return print({
          outcome: "failed",
          key,
          name: context.name, rerun: context.rerun, summaryAt: context.summaryAt,
          reason: `${hostNamed()} for ${context.name} stopped before its round ended`,
          items: [],
        });
      case "result": {
        const live = read();
        if (typeof live === "string") return notRun(live);
        const state = holding(episode, live, context.own);
        if (typeof state === "string") return notRun(state);
        const settled = settle({ ...context, recorded: true }, state);
        return settled === undefined ? undefined : finish(settled, threads);
      }
      case "queue":
      case "start-host":
      case "in-hand":
      case "left-failed":
        if (host.outcome === "failed") return notRun(`the round host could not be started: ${host.reason}`);
        // A queue another writer's close stopped leaves the state's old record.
        if (decision.outcome === "queue" && !triggered.queued) {
          const state = read();
          if (typeof state === "string") return notRun(state);
          if (episodeOver(state, context.own)) return print(closedResult(context, state, threads));
        }
        return undefined;
    }
  };

  const now = decided();
  if (now !== undefined) return now;

  const pollMs = request.pollMs ?? POLL_MS;
  let startUnknown = triggered.host.outcome === "unknown" ? triggered.host.reason : undefined;
  let startBy = deadlineIn(request.hostStartMs ?? HOST_START_MS);
  for (;;) {
    const live = read();
    if (typeof live === "string") return notRun(live);
    const state = holding(episode, live, context.own);
    if (typeof state === "string") return notRun(state);
    const settled = settle({ ...context, recorded: false }, state);
    if (settled !== undefined) {
      if (settled.kind === "result") return print(settled.result);
      const listed = venue.listThreads(triggered.change, until.remaining() < READ_BACK_FLOOR_MS ? deadlineIn(READ_BACK_FLOOR_MS) : until);
      if (listed.outcome !== "listed") {
        const reason = `the threads on ${context.name} could not all be listed to print the review of ${context.own.head.slice(0, 7)}: ${listed.reason}`;
        return unprinted(reason);
      }
      return finish(settled, listed.threads);
    }
    const unqueued = unqueuedSuccessor(state, context.own);
    if (unqueued !== undefined && !until.passed()) {
      const again = triggerNow();
      if (again.outcome === "held") return print({ outcome: "held", key, line: again.line });
      if (again.outcome !== "decided") {
        // A trigger the run's own deadline cut off is the deadline arriving, not a review that could not run.
        return until.passed() ? print(stillReviewing(context, state.records ?? [])) : notRun(again.reason);
      }
      triggered = again;
      context = { ...context, name: again.change.name, rerun: again.change.rerun, summaryAt: again.change.summaryAt, followUp: again.change.followUp };
      // A trigger that read a state other than the one the record names waits on what it read.
      if (!sameState(again.state, unqueued)) context = { ...context, own: again.state };
      const acted = decided();
      if (acted !== undefined) return acted;
      if (again.host.outcome === "unknown") {
        startUnknown = again.host.reason;
        startBy = deadlineIn(request.hostStartMs ?? HOST_START_MS);
      }
    }
    // A host that may not have started is waited on once a live one holds the
    // lock, and reported once its time to take the lock has passed. A `ps` that
    // hangs is cut off with that time, so it cannot spend the run's deadline.
    const window = Math.min(startBy.remaining(), until.remaining());
    if (startUnknown !== undefined && hostRunning(episode.directory, request.presence ?? stillRunning, window)) {
      startUnknown = undefined;
    }
    if (startUnknown !== undefined && (startBy.passed() || until.passed())) {
      return print({
        outcome: "not run",
        key,
        reason: `whether the round host for ${context.name} started could not be told, and none has taken the review since: ${startUnknown}`,
        problems: [`\`squiz status ${key}\` shows whether one takes it later, and ${relative(episode.worktree, join(episode.directory, "host.log"))} holds what the host wrote`],
      });
    }
    if (until.passed()) return print(stillReviewing(context, state.records ?? []));
    const pause = Math.min(pollMs, startUnknown === undefined ? until.remaining() : Math.min(startBy.remaining(), until.remaining()));
    await sleep(Math.max(1, pause));
  }
}

/**
 * The state file holding `own`'s record: `live` where it does, and otherwise
 * the newest closed episode archived beside it that does. A round can close the
 * episode clean, and a new head start the next one, between two readings.
 */
function holding(episode: Episode, live: EpisodeState, own: StateKey): EpisodeState | string {
  if (recordFor(live.records ?? [], own) !== undefined) return live;
  const archives = archivedEpisodes(episode);
  if (archives.outcome === "failed") return archives.reason;
  for (const archive of [...archives.episodes].reverse()) {
    const read = readState(archive);
    // An archive that does not read may be the one holding the record.
    if (read.outcome === "unreadable") return read.reason;
    if (read.outcome === "read" && recordFor(read.state.records ?? [], own) !== undefined) return read.state;
  }
  return live;
}

/**
 * The state `own` was superseded by, followed to the last one, where no record
 * for it has been written. `undefined` once the episode has closed.
 */
function unqueuedSuccessor(state: EpisodeState, own: StateKey): StateKey | undefined {
  if (state.closeReported === true) return undefined;
  const records = state.records ?? [];
  let record = recordFor(records, own);
  // The count of records ends a loop of states superseding each other.
  for (let hops = 0; hops <= records.length && record?.status === "not reviewed" && record.supersededBy !== undefined; hops += 1) {
    const newer = recordFor(records, record.supersededBy);
    if (newer === undefined) return record.supersededBy;
    record = newer;
  }
  return undefined;
}

/** Whether a live process holds the episode's host lock, asked within `boundMs`. One nobody can tell running is not. */
function hostRunning(
  directory: string,
  presence: (identity: ProcessIdentity, boundMs: number) => Presence,
  boundMs: number,
): boolean {
  const holder = lockHolder(directory, "host.lock");
  return holder.outcome === "named" && presence(holder.holder, Math.max(1, boundMs)).outcome === "running";
}

type Context = {
  readonly key: string;
  readonly name: Change["name"];
  readonly rerun: Change["rerun"];
  readonly summaryAt: Change["summaryAt"];
  readonly cap: number;
  readonly own: StateKey;
  readonly followUp: Change["followUp"];
};

/** Whether the run was handed a result already recorded, rather than one it waited for. */
type Waiting = Context & { readonly recorded: boolean };

/** What the run ends on. A result that prints threads is composed once they are read as they stand now. */
type Settled =
  | { readonly kind: "compose"; readonly compose: (threads: readonly ReviewThread[]) => ReviewResult }
  | { readonly kind: "result"; readonly result: ReviewResult };

type Reviewed = Extract<StateRecord, { readonly status: "reviewed"; readonly result: "exited" }>;

/** What the run's state has reached, or `undefined` while it is queued or under review. */
function settle(waiting: Waiting, state: EpisodeState): Settled | undefined {
  const records = state.records ?? [];
  const record = recordFor(records, waiting.own);
  if (record === undefined) return state.closeReported === true ? closed(waiting, state) : undefined;
  return settleRecord(waiting, state, record);
}

/**
 * `hops` counts the states followed so far, from a clean state to the last
 * record and from a superseded state to its successor. A walk that visits each
 * record once takes fewer hops than there are records, so one that reaches that
 * many has come round to a state it already read, and waits.
 */
function settleRecord(waiting: Waiting, state: EpisodeState, record: StateRecord, hops = 0): Settled | undefined {
  if (hops >= (state.records ?? []).length) return undefined;
  switch (record.status) {
    case "queued":
    case "reviewing":
      return undefined;
    case "failed":
      return {
        kind: "result",
        result: { outcome: "failed", key: waiting.key, name: waiting.name, rerun: waiting.rerun, summaryAt: waiting.summaryAt, reason: record.reason, items: record.lines ?? [] },
      };
    case "reviewed":
      if (record.result === "exited") return compose((threads) => roundResult(waiting, state, record, threads));
      return afterClean(waiting, state, record, hops);
    case "not reviewed":
      return notReviewed(waiting, state, record, hops);
  }
}

/**
 * The result the queue ends on, for a state reviewed clean with a later state
 * queued behind it, or `undefined` while a state is still queued or under review.
 */
function afterClean(waiting: Waiting, state: EpisodeState, clean: StateRecord, hops: number): Settled | undefined {
  const records = state.records ?? [];
  const following = { ...waiting, recorded: false };
  if (state.closeReported === true) {
    const closing = closingRecord(records);
    if (closing !== undefined) return compose((threads) => roundResult(following, state, closing, threads));
    return closed(following, state);
  }
  if (records.some((record) => record.status === "queued" || record.status === "reviewing")) return undefined;
  const after = records.slice(records.findIndex((record) => sameState(record, clean)) + 1);
  const last = after.at(-1);
  // A last state reviewed clean has a later one queued behind it, still to be written.
  if (last === undefined || (last.status === "reviewed" && last.result === "clean, episode open")) return undefined;
  return settleRecord(following, state, last, hops + 1);
}

/**
 * A state no round took. One a later state superseded follows that state, or is
 * `undefined` until a trigger has queued it. One the close stopped is handed the
 * close, and one queued after the close is handed the close alone.
 */
function notReviewed(
  waiting: Waiting,
  state: EpisodeState,
  record: NotReviewed,
  hops: number,
): Settled | undefined {
  const records = state.records ?? [];
  if (supersededName(record) !== undefined) {
    // Followed by its full key alone, because the reason names only a commit
    // other states can share.
    const newer = record.supersededBy === undefined ? undefined : recordFor(records, record.supersededBy);
    if (newer === undefined) return undefined;
    return settleRecord({ ...waiting, recorded: false }, state, newer, hops + 1);
  }
  const before = records.find((held): held is ClosedFirst => held.status === "not reviewed" && held.closed !== undefined);
  if (state.closeReported === true && before !== undefined && record.reason === before.reason) {
    return compose((threads) => closedUnreviewed(waiting, records, before, record, threads));
  }
  const closing = closingRecord(records);
  const stopped = /^the episode closed at the (round cap|token bound), after reviewing /u.exec(record.reason);
  if (state.closeReported === true && closing !== undefined && stopped !== null) {
    const closedAt = stopped[1] as ClosingBound;
    const left = records.filter((held) => held.status === "not reviewed" && held.reason === record.reason);
    const names = namedStates(closing, left);
    const name = names[left.findIndex((held) => sameState(held, record))] ?? record.head.slice(0, 7);
    return compose((threads) => roundResult(waiting, state, closing, threads, { state: name, closedAt }));
  }
  if (state.closeReported === true) return closed(waiting, state);
  const reason = `${waiting.name} at ${record.head.slice(0, 7)} was not reviewed: ${record.reason}`;
  return { kind: "result", result: { outcome: "not run", key: waiting.key, reason } };
}

type NotReviewed = Extract<StateRecord, { readonly status: "not reviewed" }>;

/** The state a close before the review was reached on, which carries the close. */
type ClosedFirst = NotReviewed & { readonly closed: ClosedBeforeReview };

/**
 * The close before the review, for `record`: the state that close was reached
 * on, or one queued behind it. Each is named as the close named them, after the
 * last state the episode reviewed.
 */
function closedUnreviewed(
  waiting: Waiting,
  records: readonly StateRecord[],
  first: ClosedFirst,
  record: NotReviewed,
  threads: readonly ReviewThread[],
): ReviewResult {
  const left = records.filter((held) => held.status === "not reviewed" && held.reason === first.reason);
  const names = namedStates(lastReviewed(records), left);
  const { closed } = first;
  const problems = closed.problems ?? [];
  return {
    outcome: "closed unreviewed",
    key: waiting.key,
    name: waiting.name, rerun: waiting.rerun, summaryAt: waiting.summaryAt,
    exit: 3,
    state: names[left.findIndex((held) => sameState(held, record))] ?? record.head.slice(0, 7),
    reason: record.reason,
    closedAt: closed.closedAt,
    threads: threads.filter((thread) => closed.openThreads.includes(thread.id)),
    // The close records a problem only where its summary is not on the pull request.
    summarised: problems.length === 0,
    problems,
  };
}

const SUPERSEDED = "superseded by ";

/** The state that superseded `record` as its reason names it, or `undefined` where none did. */
function supersededName(record: NotReviewed): string | undefined {
  return record.reason.startsWith(SUPERSEDED) ? record.reason.slice(SUPERSEDED.length) : undefined;
}

function compose(build: (threads: readonly ReviewThread[]) => ReviewResult): Settled {
  return { kind: "compose", compose: build };
}

function closed(context: Context, state: EpisodeState): Settled {
  return compose((threads) => closedResult(context, state, threads));
}

/** The round that closed the episode: the last reviewed record with an exit that closes. */
function closingRecord(records: readonly StateRecord[]): Reviewed | undefined {
  return records.findLast(
    (record): record is Reviewed => record.status === "reviewed" && record.result === "exited" && record.exitStatus !== 2,
  );
}

function roundResult(
  waiting: Waiting,
  state: EpisodeState,
  record: Reviewed,
  threads: readonly ReviewThread[],
  left?: { readonly state: string; readonly closedAt: ClosingBound },
): ReviewResult {
  const round = record.round.number;
  const unposted = record.unposted;
  const lost =
    unposted === undefined
      ? []
      : [`round ${round} could not post ${unposted.failed} of its ${unposted.of} findings to ${waiting.name}`];
  // A round that left the episode open posted no summary, so stderr is where the
  // coding agent working it reads what no thread holds.
  const unthreaded = (record.unthreaded ?? []).map((note) => `round ${round} raised this on no thread: ${note}`);
  const problems = [...lost, ...unthreaded, ...(record.problems ?? [])];
  const base = {
    outcome: "reviewed" as const,
    key: waiting.key,
    name: waiting.name, rerun: waiting.rerun, summaryAt: waiting.summaryAt,
    commit: record.head.slice(0, 7),
    round,
    cap: waiting.cap,
    newFindings: record.newFindings,
    threads: threads.filter((thread) => record.openThreads.includes(thread.id)),
    recorded: waiting.recorded,
    problems,
  };
  switch (record.exitStatus) {
    case 2:
      return { ...base, exit: 2, followUp: waiting.followUp };
    case 0:
      // A close that left the run's own state unreviewed exits 3, though nothing is open.
      if (left !== undefined) return { ...base, exit: 3, closedAt: left.closedAt, notReviewed: { state: left.state } };
      return { ...base, exit: 0 };
    case 3:
      return {
        ...base,
        exit: 3,
        // A record written before records kept the bound: the cap where it is spent.
        closedAt: record.closedAt ?? (state.rounds.length >= waiting.cap ? "round cap" : "token bound"),
        notReviewed: left === undefined ? undefined : { state: left.state },
      };
  }
}

/** The close of an episode already over, exiting as it did, with what the close recorded failing. */
function closedResult(context: Context, state: EpisodeState, threads: readonly ReviewThread[]): ReviewResult {
  const records = state.records ?? [];
  const closing = closingRecord(records);
  const first = records.find((held): held is ClosedFirst => held.status === "not reviewed" && held.closed !== undefined);
  // An episode closed before a round took its last state has no last round, and its threads are all the reviewer opened.
  const left =
    closing === undefined
      ? threads.filter((thread) => readComment(thread.comments[0]?.body ?? "").by === "reviewer")
      : threads.filter((thread) => closing.openThreads.includes(thread.id));
  const open = left.filter((thread) => !thread.isResolved);
  // Named, because the close can be about a head other than the one the run read.
  const head = state.cleanClose?.head ?? closing?.head ?? first?.head;
  const unreviewed = state.cleanClose === undefined ? unreviewedBy(context, state, closing, first) : undefined;
  return {
    outcome: "closed",
    key: context.key,
    name: context.name, rerun: context.rerun, summaryAt: context.summaryAt,
    exit: unreviewed !== undefined || (closing?.exitStatus ?? (open.length === 0 ? 0 : 3)) !== 0 ? 3 : 0,
    ...(head === undefined ? {} : { commit: head.slice(0, 7) }),
    ...(unreviewed === undefined ? {} : { unreviewed }),
    reopens: state.cleanClose !== undefined,
    rounds: state.rounds.length,
    threads: left,
    problems: (closing === undefined ? first?.closed.problems : closing.problems) ?? [],
  };
}

/**
 * The run's own state as a close at a bound left it, and why, or `undefined`
 * where a round reviewed it. A state the close recorded is named and given its
 * reason as the run that waited on it was. Any other arrived after the close.
 */
function unreviewedBy(
  context: Context,
  state: EpisodeState,
  closing: Reviewed | undefined,
  first: ClosedFirst | undefined,
): { readonly state: string; readonly reason: string } | undefined {
  const records = state.records ?? [];
  const own = recordFor(records, context.own);
  if (own?.status === "reviewed") return undefined;
  if (own?.status === "not reviewed" && supersededName(own) === undefined) {
    const left = records.filter((held) => held.status === "not reviewed" && held.reason === own.reason);
    const name = namedStates(lastReviewed(records), left)[left.findIndex((held) => sameState(held, own))];
    return { state: name ?? own.head.slice(0, 7), reason: own.reason };
  }
  const name = namedStates(null, [...records, context.own]).at(-1) ?? context.own.head.slice(0, 7);
  const bound = closing?.closedAt ?? first?.closed.closedAt ?? (state.rounds.length >= context.cap ? "round cap" : "token bound");
  const reason =
    closing === undefined
      ? `the episode closed at the ${bound} before a round took this state`
      : `the episode closed at the ${bound}, after reviewing ${closing.head.slice(0, 7)}`;
  return { state: name, reason };
}

/** Exit 4, saying what the run's state is waiting on. */
function stillReviewing(context: Context, records: readonly StateRecord[]): ReviewResult {
  const record = recordFor(records, context.own);
  const commit = context.own.head.slice(0, 7);
  const about = { outcome: "reviewing" as const, key: context.key, name: context.name, rerun: context.rerun, summaryAt: context.summaryAt };
  const underway = records.find((held) => held.status === "reviewing" && !sameState(held, context.own));
  if (record?.status === "queued" && underway !== undefined) {
    return { ...about, wait: "queued", commit, reviewing: underway.head.slice(0, 7) };
  }
  if (record?.status === "reviewed") {
    const next = underway ?? records.find((held) => held.status === "queued");
    if (next !== undefined) return { ...about, wait: "clean", commit, reviewing: next.head.slice(0, 7) };
  }
  const superseded = record?.status === "not reviewed" ? supersededName(record) : undefined;
  if (superseded !== undefined) return { ...about, wait: "superseded", commit, reviewing: superseded };
  return { ...about, wait: "under review", commit };
}
