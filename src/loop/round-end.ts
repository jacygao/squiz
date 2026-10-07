/**
 * What a finished round records, for its own state and for every state queued
 * behind it, and whether the episode closes.
 *
 * A state accepted into the queue is never dropped: it is reviewed next, or the
 * close gives it a record of its own saying why it was not reviewed. With
 * nothing queued, this closes exactly where the round decision does.
 *
 * This decides and performs nothing.
 */

import {
  decideAfterRound,
  type ClosingReason,
  type EpisodeBounds,
} from "./round-decision.ts";
import type { StateKey, StateRecord } from "./state-record.ts";

export type QueuedRecord = Extract<StateRecord, { readonly status: "queued" }>;

export type ReviewedRecord = Extract<StateRecord, { readonly status: "reviewed" }>;

export type NotReviewedRecord = Extract<StateRecord, { readonly status: "not reviewed" }>;

/** A bound that can stop a queued state from being reviewed. */
export type StoppingBound = Exclude<ClosingReason, "nothing-open">;

/**
 * The queued states a close recorded not reviewed, in queue order, the bound
 * that left no round for them, and the state reviewed before them.
 *
 * The bound is not always the close's reason. A last round that left nothing
 * open closes as `nothing-open`, and the cap or the token bound still stopped
 * the states behind it.
 */
export type LeftNotReviewed = {
  readonly bound: StoppingBound;
  /**
   * The state reviewed before them, which `namedStates` names the others after.
   * `null` where the episode reviewed no state at all.
   */
  readonly after: StateKey | null;
  readonly states: readonly NotReviewedRecord[];
};

/**
 * The last state the episode reviewed, which a close before the review names the
 * states it left not reviewed after, or `null` where it reviewed none.
 *
 * Read off the round's number rather than the record's place. A state that
 * `squiz review` retried keeps its place, so the last record reviewed need not
 * be the last state reviewed. A record with no number, written before records
 * kept one, ranks below every numbered one, and the later of two such wins.
 */
export function lastReviewed(records: readonly StateRecord[]): StateKey | null {
  let reviewed: StateRecord | undefined;
  let highest = -1;
  for (const record of records) {
    if (record.status !== "reviewed") continue;
    const number = record.round?.number ?? 0;
    if (number < highest) continue;
    reviewed = record;
    highest = number;
  }
  return reviewed === undefined ? null : { head: reviewed.head, activity: reviewed.activity };
}

/** Why a state was not reviewed, where the episode's bound was spent before a round took it. */
export function closedBeforeReview(bound: StoppingBound): string {
  return `the episode closed at ${bound === "round-cap" ? "the round cap" : "the token bound"} before a round took this state`;
}

/** The round that has just finished, as its own state's record needs it. */
export type EndedRound = {
  /** The state the round reviewed, with the owner its record carries where it has one. */
  readonly state: StateKey & Pick<StateRecord, "owner">;
  /** The node ids of the reviewer's threads left open now the round's verdicts are applied. */
  readonly openThreads: readonly string[];
  /** Rounds the episode has finished, counting from 1 and including this one. */
  readonly roundsRun: number;
  readonly tokens: number;
};

/** What the round ended on. */
export type RoundEnd =
  /**
   * Threads are open and a round remains. The oldest queued state is reviewed
   * next, or the coding agent is handed the threads where nothing is queued.
   */
  | { readonly outcome: "threads open"; readonly record: ReviewedRecord }
  /**
   * Nothing is open, a later state is queued, and a round remains for it. There
   * is no close, no summary and no note for the owner.
   */
  | { readonly outcome: "reviewed clean, episode open"; readonly record: ReviewedRecord }
  /**
   * The episode closes. Each queued state is recorded not reviewed, and
   * `leftNotReviewed` is `null` exactly where nothing was queued.
   */
  | {
      readonly outcome: "closed";
      readonly because: ClosingReason;
      readonly record: ReviewedRecord;
      readonly leftNotReviewed: LeftNotReviewed | null;
    };

/**
 * Rule on the round that has just finished, and on the states queued behind it.
 *
 * Nothing left open does not close the episode while a later state is queued and
 * a round remains for it, because that state may leave threads open. The
 * episode closes from the last round with nothing queued behind it.
 */
export function decideRoundEnd(
  round: EndedRound,
  bounds: EpisodeBounds,
  queued: readonly QueuedRecord[],
): RoundEnd {
  const decision = decideAfterRound(
    { openThreads: round.openThreads.length, roundsRun: round.roundsRun, tokens: round.tokens },
    bounds,
  );
  if (decision.next === "block") return { outcome: "threads open", record: exited(round, 2) };
  if (decision.because !== "nothing-open") {
    return closed(round, decision.because, notReviewed(queued, decision.because, round));
  }
  if (queued.length === 0) return closed(round, "nothing-open", null);

  // Asked as though the round had left work, the decision says whether the cap
  // and the bound allow the round the queued state needs.
  const next = decideAfterRound(
    { openThreads: 1, roundsRun: round.roundsRun, tokens: round.tokens },
    bounds,
  );
  if (next.next === "block") {
    return {
      outcome: "reviewed clean, episode open",
      record: { ...round.state, status: "reviewed", result: "clean, episode open" },
    };
  }
  // The episode still closed with nothing open, which is what its summary says.
  // Only the queued states were stopped by a bound, and a close the decision
  // gave no bound for reads as the cap rather than keeping the episode open.
  const bound = next.because === "token-bound" ? "token-bound" : "round-cap";
  return closed(round, "nothing-open", notReviewed(queued, bound, round));
}

function closed(
  round: EndedRound,
  because: ClosingReason,
  leftNotReviewed: LeftNotReviewed | null,
): RoundEnd {
  const exitStatus = round.openThreads.length === 0 ? 0 : 3;
  return { outcome: "closed", because, record: exited(round, exitStatus), leftNotReviewed };
}

function exited(round: EndedRound, exitStatus: 0 | 2 | 3): ReviewedRecord {
  return {
    ...round.state,
    status: "reviewed",
    result: "exited",
    exitStatus,
    openThreads: round.openThreads,
  };
}

function notReviewed(
  queued: readonly QueuedRecord[],
  bound: StoppingBound,
  round: EndedRound,
): LeftNotReviewed | null {
  if (queued.length === 0) return null;
  const at = bound === "round-cap" ? "the round cap" : "the token bound";
  const reason = `the episode closed at ${at}, after reviewing ${round.state.head.slice(0, 7)}`;
  const states = queued.map(
    ({ status: _queued, ...state }): NotReviewedRecord => ({ ...state, status: "not reviewed", reason }),
  );
  return { bound, after: { head: round.state.head, activity: round.state.activity }, states };
}

/**
 * How a person is told each of `states` apart, in order: its short head commit,
 * and, where states before it share that head, how many times its replies
 * differ from theirs.
 *
 * `after` is the state reviewed before them, and counts as before every one of
 * them. Where it is `null`, the first of `states` is named by its commit alone. A
 * state sharing a head with one before it differs from it only in its
 * replies, because no two records are for the same state. A reply added and a
 * reply deleted both do that, and nothing here can tell which, so the name says
 * only that they differ. Counting the states before it, rather than marking it
 * once, keeps two such states on one commit from reading as one state named
 * twice:
 *
 * - `8d21a4f`, where no state before it has that head
 * - `8d21a4f with different replies`, where one does
 * - `8d21a4f with different replies a second time`, where two do
 */
export function namedStates(after: StateKey | null, states: readonly StateKey[]): string[] {
  const earlier = after === null ? [] : [after];
  return states.map((state, index) => {
    const before = [...earlier, ...states.slice(0, index)].filter((held) => held.head === state.head).length;
    const commit = state.head.slice(0, 7);
    if (before === 0) return commit;
    if (before === 1) return `${commit} with different replies`;
    return `${commit} with different replies a ${ordinal(before)} time`;
  });
}

const ordinalWords = ["second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];

/** `2` as `second`, and so on, in figures past `tenth`. */
function ordinal(n: number): string {
  const word = ordinalWords[n - 2];
  if (word !== undefined) return word;
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}
