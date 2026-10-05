/**
 * `squiz review <number>`: trigger a review of the pull request's state, then
 * wait for that state's round and print what it reached.
 *
 * Three things here fail silently when wrong:
 *
 * - The result of another state. The run waits on the record for the state its
 *   trigger read, its head and its activity, and never on the newest record. The
 *   one exception is a state reviewed clean with a later one queued behind it,
 *   which waits for the state the queue ends on.
 * - A deadline read as a failure. A run whose deadline arrives while its state
 *   is queued or under review exits 4, and the round goes on in its host.
 * - A wait that spins. The state file is read without the lock, because every
 *   write replaces it whole, and read again only after a pause.
 *
 * Stopping the command ends only the wait: the round host was started in a
 * session of its own, and nothing here signals it.
 */

import { setTimeout as sleep } from "node:timers/promises";

import { loadConfig } from "../config/config.ts";
import { readComment } from "../findings/comment.ts";
import { listReviewThreads, type ReviewThread, type ThreadListing } from "../github/threads.ts";
import type { GhCall } from "../github/gh.ts";
import { failureLine } from "../hook/report.ts";
import { trigger as triggerReview, type HostCommand, type Triggered, type TriggerRequest } from "../host/trigger.ts";
import { readState, type EpisodeState } from "../loop/episode-state.ts";
import { namedStates } from "../loop/round-end.ts";
import { recordFor, sameState, type ClosingBound, type StateKey, type StateRecord } from "../loop/state-record.ts";
import { deadlineIn, type Deadline } from "../reviewers/deadline.ts";
import type { Presence, ProcessIdentity } from "../sessions/process.ts";
import { worktreeToplevel } from "../worktree/toplevel.ts";
import { printReview, type Printed, type ReviewResult } from "./output.ts";

// Claude Code gives a shell command at most 600 seconds, and the minute left
// covers the process starting and stopping.
const REVIEW_BUDGET_MS = 540_000;

const POLL_MS = 1_000;

// A result reached just before the deadline still has its threads read back,
// rather than becoming exit 4 for want of a listing.
const READ_BACK_FLOOR_MS = 10_000;

export type ReviewRequest = {
  /** Where the command ran. */
  readonly directory: string;
  readonly pullRequest: number;
  /** Read for `HERDR_WORKSPACE_ID`. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** The run's one deadline, counted from its start. 540 seconds from now where not given. */
  readonly until?: Deadline;
  /** The pause between readings of the state file. */
  readonly pollMs?: number;
  /** `trigger` where not given. */
  readonly trigger?: (request: TriggerRequest) => Triggered;
  /** `listReviewThreads` where not given. */
  readonly listThreads?: (pullRequestId: string, call: GhCall) => ThreadListing;
  readonly presence?: (identity: ProcessIdentity, boundMs: number) => Presence;
  readonly host?: (pullRequest: number) => HostCommand;
};

/** Trigger, wait and compose the run's output. Never throws for anything git, `gh` or the filesystem does. */
export async function runReview(request: ReviewRequest): Promise<Printed> {
  const until = request.until ?? deadlineIn(REVIEW_BUDGET_MS);
  const { directory, pullRequest } = request;
  const notRun = (reason: string): Printed => printReview({ outcome: "not run", pullRequest, reason }, directory);

  const toplevel = worktreeToplevel(directory, until);
  if (toplevel.outcome === "failed") return notRun(`the worktree could not be resolved: ${toplevel.reason}`);
  let cap: number;
  try {
    cap = loadConfig(toplevel.path).rounds;
  } catch (cause) {
    // The settings refuse a value they cannot use by throwing.
    return notRun(cause instanceof Error ? cause.message : String(cause));
  }

  const triggered = (request.trigger ?? triggerReview)({
    directory,
    trigger: "review",
    pullRequest,
    environment: request.environment,
    until,
    ...(request.presence === undefined ? {} : { presence: request.presence }),
    ...(request.host === undefined ? {} : { host: request.host }),
  });
  if (triggered.outcome !== "decided") return notRun(triggered.reason);

  const { episode, decision, state: own } = triggered;
  const print = (result: ReviewResult): Printed => printReview(result, episode.worktree);
  const read = (): EpisodeState | string => {
    const found = readState(episode);
    if (found.outcome === "unreadable") return found.reason;
    return found.outcome === "read" ? found.state : { rounds: [], spentOutsideRounds: { dollars: 0, tokens: 0, messages: 0 } };
  };
  const context: Context = { pullRequest, cap, own };
  const finish = (settled: Settled, threads: readonly ReviewThread[]): Printed =>
    print(settled.kind === "result" ? settled.result : settled.compose(threads));
  const hostNamed = (): string => {
    const state = read();
    const record = typeof state === "string" ? undefined : recordFor(state.records ?? [], own);
    return record?.status === "reviewing" ? `round host ${record.host.pid}` : "the round host";
  };

  switch (decision.outcome) {
    case "closed": {
      const state = read();
      if (typeof state === "string") return notRun(state);
      return print(closedResult(context, state, triggered.threads));
    }
    case "host-unknown":
      return notRun(`whether ${hostNamed()} for PR #${pullRequest} is still running could not be told: ${decision.reason}`);
    case "recover":
      // Nothing here recovers the round, so the run reports it killed, which is
      // what its record reads as. A new commit or reply is a state it never held.
      return print({
        outcome: "failed",
        pullRequest,
        reason: `${hostNamed()} for PR #${pullRequest} stopped before its round ended`,
        items: [],
      });
    case "result": {
      const state = read();
      if (typeof state === "string") return notRun(state);
      const settled = settle({ ...context, recorded: true }, state);
      if (settled !== undefined) return finish(settled, triggered.threads);
      break;
    }
    case "queue":
    case "start-host":
    case "in-hand":
    case "left-failed":
      if (triggered.host.outcome === "failed") return notRun(`the round host could not be started: ${triggered.host.reason}`);
      // A queue another writer's close stopped leaves the state's old record.
      if (decision.outcome === "queue" && !triggered.queued) {
        const state = read();
        if (typeof state === "string") return notRun(state);
        if (state.closeReported === true) return print(closedResult(context, state, triggered.threads));
      }
      break;
  }

  const waiting = { ...context, recorded: false };
  const pollMs = request.pollMs ?? POLL_MS;
  for (;;) {
    const state = read();
    if (typeof state === "string") return notRun(state);
    const settled = settle(waiting, state);
    if (settled !== undefined) {
      if (settled.kind === "result") return print(settled.result);
      const call = { directory, until: until.remaining() < READ_BACK_FLOOR_MS ? deadlineIn(READ_BACK_FLOOR_MS) : until };
      const listed = (request.listThreads ?? listReviewThreads)(triggered.pullRequest.nodeId, call);
      if (listed.outcome !== "listed") {
        const reason = `the threads on PR #${pullRequest} could not all be listed to print the review of ${own.head.slice(0, 7)}: ${listed.reason}`;
        return { exit: 1, stdout: "", stderr: failureLine(reason) };
      }
      return finish(settled, listed.threads);
    }
    if (until.passed()) return print(stillReviewing(context, state.records ?? []));
    await sleep(Math.max(1, Math.min(pollMs, until.remaining())));
  }
}

type Context = { readonly pullRequest: number; readonly cap: number; readonly own: StateKey };

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

/** `hops` counts the superseded states followed so far, which ends a loop of them. */
function settleRecord(waiting: Waiting, state: EpisodeState, record: StateRecord, hops = 0): Settled | undefined {
  switch (record.status) {
    case "queued":
    case "reviewing":
      return undefined;
    case "failed":
      return {
        kind: "result",
        result: { outcome: "failed", pullRequest: waiting.pullRequest, reason: record.reason, items: record.lines ?? [] },
      };
    case "reviewed":
      if (record.result === "exited") return compose((threads) => roundResult(waiting, state, record, threads));
      return afterClean(waiting, state, record);
    case "not reviewed":
      return notReviewed(waiting, state, record, hops);
  }
}

/**
 * The result the queue ends on, for a state reviewed clean with a later state
 * queued behind it, or `undefined` while a state is still queued or under review.
 */
function afterClean(waiting: Waiting, state: EpisodeState, clean: StateRecord): Settled | undefined {
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
  return settleRecord(following, state, last);
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
  const superseded = supersededBy(record);
  if (superseded !== undefined) {
    const newer = records.findLast((held) => !sameState(held, record) && superseded(held));
    if (newer === undefined || hops >= records.length) return undefined;
    return settleRecord({ ...waiting, recorded: false }, state, newer, hops + 1);
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
  const reason = `PR #${waiting.pullRequest} at ${record.head.slice(0, 7)} was not reviewed: ${record.reason}`;
  return { kind: "result", result: { outcome: "not run", pullRequest: waiting.pullRequest, reason } };
}

type NotReviewed = Extract<StateRecord, { readonly status: "not reviewed" }>;

/**
 * The state a superseded record names, as a test on records, and the name it is
 * printed by. `undefined` where the record was not superseded.
 */
function supersededBy(record: NotReviewed): ((held: StateRecord) => boolean) & { readonly named: string } | undefined {
  const found = /^superseded by ([0-9a-f]+)( with different replies)?$/u.exec(record.reason);
  const commit = found?.[1];
  if (found === null || commit === undefined) return undefined;
  // A state on the same commit differs only in its replies, which the reason does not name.
  const sameCommit = found[2] !== undefined;
  const test = (held: StateRecord): boolean => (sameCommit ? held.head === record.head : held.head.startsWith(commit));
  return Object.assign(test, { named: record.reason.slice("superseded by ".length) });
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
  // A record from before records kept the round's number: the count of rounds stands in.
  const round = record.round?.number ?? state.rounds.length;
  const unposted = record.unposted;
  // A round whose every finding GitHub refused reached nothing it could hand
  // over, so its clean exit would hide them all.
  if (unposted !== undefined && unposted.failed === unposted.of) {
    return { outcome: "unposted", pullRequest: waiting.pullRequest, round, findings: unposted.of };
  }
  const lost =
    unposted === undefined
      ? []
      : [`round ${round} could not post ${unposted.failed} of its ${unposted.of} findings to PR #${waiting.pullRequest}`];
  const problems = [...lost, ...(record.problems ?? [])];
  const base = {
    outcome: "reviewed" as const,
    pullRequest: waiting.pullRequest,
    commit: record.head.slice(0, 7),
    round,
    cap: waiting.cap,
    newFindings: record.newFindings ?? 0,
    threads: threads.filter((thread) => record.openThreads.includes(thread.id)),
    recorded: waiting.recorded,
    problems,
  };
  switch (record.exitStatus) {
    case 2:
      return { ...base, exit: 2, moved: record.moved };
    case 0:
      return { ...base, exit: 0, notReviewed: left };
    case 3:
      return {
        ...base,
        exit: 3,
        // A record written before records kept the bound: the cap where it is spent.
        closedAt: record.closedAt ?? (state.rounds.length >= waiting.cap ? "round cap" : "token bound"),
        moved: record.moved,
        notReviewed: left === undefined ? undefined : { state: left.state },
      };
  }
}

/** The close of an episode already over, exiting as it did. */
function closedResult(context: Context, state: EpisodeState, threads: readonly ReviewThread[]): ReviewResult {
  const closing = closingRecord(state.records ?? []);
  // An episode closed before any round ran left only the threads earlier attempts opened.
  const left =
    closing === undefined
      ? threads.filter((thread) => readComment(thread.comments[0]?.body ?? "").by === "reviewer")
      : threads.filter((thread) => closing.openThreads.includes(thread.id));
  const open = left.filter((thread) => !thread.isResolved);
  return {
    outcome: "closed",
    pullRequest: context.pullRequest,
    exit: (closing?.exitStatus ?? (open.length === 0 ? 0 : 3)) === 0 ? 0 : 3,
    rounds: state.rounds.length,
    threads: left,
  };
}

/** Exit 4, saying what the run's state is waiting on. */
function stillReviewing(context: Context, records: readonly StateRecord[]): ReviewResult {
  const record = recordFor(records, context.own);
  const commit = context.own.head.slice(0, 7);
  const about = { outcome: "reviewing" as const, pullRequest: context.pullRequest };
  const underway = records.find((held) => held.status === "reviewing" && !sameState(held, context.own));
  if (record?.status === "queued" && underway !== undefined) {
    return { ...about, wait: "queued", commit, reviewing: underway.head.slice(0, 7) };
  }
  if (record?.status === "reviewed") {
    const next = underway ?? records.find((held) => held.status === "queued");
    if (next !== undefined) return { ...about, wait: "clean", commit, reviewing: next.head.slice(0, 7) };
  }
  const superseded = record?.status === "not reviewed" ? supersededBy(record) : undefined;
  if (superseded !== undefined) return { ...about, wait: "superseded", commit, reviewing: superseded.named };
  return { ...about, wait: "under review", commit };
}
