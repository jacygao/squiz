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
  /** The episode closes. Each queued state is recorded not reviewed, in queue order. */
  | {
      readonly outcome: "closed";
      readonly because: ClosingReason;
      readonly record: ReviewedRecord;
      readonly notReviewed: readonly NotReviewedRecord[];
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
  if (queued.length === 0) return closed(round, "nothing-open", []);

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
  stopped: readonly NotReviewedRecord[],
): RoundEnd {
  const exitStatus = round.openThreads.length === 0 ? 0 : 3;
  return { outcome: "closed", because, record: exited(round, exitStatus), notReviewed: stopped };
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
  bound: Exclude<ClosingReason, "nothing-open">,
  round: EndedRound,
): NotReviewedRecord[] {
  const at = bound === "round-cap" ? "the round cap" : "the token bound";
  const reason = `the episode closed at ${at}, after reviewing ${round.state.head.slice(0, 7)}`;
  return queued.map(({ status: _queued, ...state }) => ({ ...state, status: "not reviewed", reason }));
}
