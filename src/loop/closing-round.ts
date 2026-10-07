/**
 * The closing round: the one round an episode the round cap closed with threads
 * open may still run, for a new state after the close.
 *
 * Two answers here fail silently when wrong. A closing round that remains after
 * one has run reviews the episode again on every push, with no cap to stop it.
 * One that never remains leaves a fix pushed after the cap unread, and the
 * thread reads to a person as a dispute.
 *
 * This decides and performs nothing.
 */

import type { EpisodeState, RoundRecord } from "./episode-state.ts";
import { recordFor, type StateKey } from "./state-record.ts";
import { notReviewedBehind, type EndedRound, type QueuedRecord, type RoundEnd } from "./round-end.ts";
import type { RoundTally } from "./round.ts";

/**
 * Whether the episode's closing round is still to run.
 *
 * Read from the mark the close itself wrote, never from the round's record,
 * which the round host writes only after the summary is posted. Once the
 * closing round's entry is in the state, none remains, however its review ended.
 */
export function closingRoundRemains(state: EpisodeState): boolean {
  return state.closeReported === true && state.closingRoundDue === true && !closingRoundRan(state.rounds);
}

/**
 * Whether the close `ends` decided leaves a closing round.
 *
 * Only a round that reviewed and reached the cap with threads open leaves one. A
 * close at the token bound leaves none, nor does the closing round's own close.
 * A close before any reviewer ran never asks.
 */
export function leavesClosingRound(tally: RoundTally, ends: RoundEnd): boolean {
  return (
    !tally.closing &&
    ends.outcome === "closed" &&
    ends.because === "round-cap" &&
    ends.record.result === "exited" &&
    ends.record.exitStatus === 3
  );
}

/**
 * Whether the episode is over for `key`: its close is reported, no closing round
 * remains to start, and `key` is not the state the closing round has queued or
 * is reviewing.
 *
 * The closing round's entry is written before it posts, and its state waits on
 * the record that follows rather than reading the close before it.
 */
export function episodeOver(state: EpisodeState, key: StateKey): boolean {
  if (state.closeReported !== true || closingRoundRemains(state)) return false;
  const record = recordFor(state.records ?? [], key);
  return record?.status !== "queued" && record?.status !== "reviewing";
}

/** Whether one of `rounds` is the closing round. */
export function closingRoundRan(rounds: readonly RoundRecord[]): boolean {
  return rounds.some((round) => round.closing === true);
}

/** How many of `rounds` the round cap counts, which is every one but the closing round. */
export function cappedRounds(rounds: readonly RoundRecord[]): number {
  return rounds.filter((round) => round.closing !== true).length;
}

/**
 * The end of the closing round, which is always the episode's close.
 *
 * It exits 3 where threads are still open, and 0 where none are. Every state
 * queued behind it is recorded not reviewed, as one behind a round that reached
 * the cap is.
 */
export function decideClosingEnd(round: EndedRound, queued: readonly QueuedRecord[]): RoundEnd {
  const open = round.openThreads.length > 0;
  return {
    outcome: "closed",
    because: open ? "round-cap" : "nothing-open",
    record: {
      ...round.state,
      status: "reviewed",
      result: "exited",
      exitStatus: open ? 3 : 0,
      openThreads: round.openThreads,
      closingRound: true,
    },
    leftNotReviewed: notReviewedBehind(queued, "round-cap", round),
  };
}
