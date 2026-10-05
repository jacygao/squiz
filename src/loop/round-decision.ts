/**
 * What a finished round does next: leave its threads open for another round, or
 * close the episode.
 *
 * An episode whose threads are open runs another round on every push or reply,
 * so the cap and the token bound here are what end it. A round that leaves the
 * episode open when it should have closed it is a billed loop with no end, so
 * the choice is made only from counts this can do arithmetic on, and every
 * doubt closes.
 *
 * Nothing the runtime supplies decides it. The cap is counted from the
 * episode's own rounds.
 *
 * This decides and performs nothing. It returns what the round concluded, and
 * the caller records it.
 */

/** What the decision needs to know about the round that has just finished. */
export type FinishedRound = {
  /** Threads left open on the pull request now the round's verdicts are applied. */
  readonly openThreads: number;
  /** Rounds the episode has finished, counting from 1 and including this one. */
  readonly roundsRun: number;
  /** Tokens this round spent, which is the figure the token bound is on. */
  readonly tokens: number;
};

/** The two bounds an episode runs under: how many rounds, and what one may spend. */
export type EpisodeBounds = {
  /** The round cap: how many rounds the episode may run. */
  readonly rounds: number;
  /** Tokens one round may spend. */
  readonly tokens: number;
};

/** Why an episode closed rather than running another round. */
export type ClosingReason =
  /** Nothing is open for another round to work. */
  | "nothing-open"
  /** The cap is spent. Whatever is still open stays open, for a person to read. */
  | "round-cap"
  /** The token bound was reached, and the episode closes with the findings it has. */
  | "token-bound";

/** What the round concluded. */
export type RoundDecision =
  /** Threads are open, and the episode stays open for another round. */
  | { readonly next: "block" }
  | { readonly next: "close"; readonly because: ClosingReason };

/**
 * Rule on the round that has just finished.
 *
 * Nothing left open closes the episode whatever the cap and the token bound
 * allow, because a block with nothing open asks the coding agent to do nothing.
 * A round that reached the token bound closes it next: the bound stops the round
 * after this one and never the round that has just run. Otherwise the cap
 * decides.
 */
export function decideAfterRound(
  round: FinishedRound,
  bounds: EpisodeBounds,
): RoundDecision {
  if (!hasOpenThreads(round.openThreads)) return closing("nothing-open");
  if (tokenBoundIsReached(round.tokens, bounds.tokens)) return closing("token-bound");
  if (!blocksRemain(round.roundsRun, bounds.rounds)) return closing("round-cap");
  return { next: "block" };
}

function closing(because: ClosingReason): RoundDecision {
  return { next: "close", because };
}

/**
 * Whether the round left the coding agent something to work.
 *
 * A test for work rather than for its absence, so that a count which is not a
 * usable number reads as nothing to work rather than as work to do.
 */
function hasOpenThreads(count: number): boolean {
  return count >= 1;
}

/**
 * Whether one attempt's tokens reached the bound. At the figure counts as
 * reaching it.
 *
 * A tally the reviewer reports rather than a price something else put on it, so
 * a model no catalogue can price is bounded exactly like one it can.
 *
 * Exported because the same comparison rules on a round before it starts, from
 * the figures the episode's state file holds.
 */
export function tokenBoundIsReached(tokens: number, bound: number): boolean {
  return tokens >= bound;
}

/**
 * Whether the cap leaves a block after this round.
 *
 * A cap of R allows R−1 blocks: every round but the last blocks, and the last
 * closes instead, so a cap of 1 reviews once and never blocks. Both counts are
 * whole numbers from 1, and a count that is neither leaves no block, because
 * nothing here may block on a number it cannot count.
 */
function blocksRemain(roundsRun: number, cap: number): boolean {
  if (!Number.isInteger(roundsRun) || !Number.isInteger(cap)) return false;
  const blocksSpent = roundsRun - 1;
  const blocksAllowed = cap - 1;
  return blocksSpent >= 0 && blocksSpent < blocksAllowed;
}
