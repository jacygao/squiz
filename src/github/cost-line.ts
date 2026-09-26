/**
 * The summary's cost line: what each round of the episode spent, in the order
 * the rounds ran, with the episode's total and the tokens behind it.
 *
 * Zero dollars is not free. A reviewer CLI that cannot price its model reports
 * no cost against real tokens, so a round printed as `$0.0000` would state
 * something untrue about money while looking perfectly well formed. Such a
 * round prints as unknown, and an episode where no round was priced says once
 * that cost is unavailable for the model rather than repeating unknown for
 * every round of it.
 *
 * The rounds arrive on their own, and that is the whole of what this is given.
 * What an episode spent outside its rounds is a second ledger, it is not a
 * round, and it must not appear in the line as one.
 */

import type { RoundCost } from "../reviewers/adapter.ts";

/**
 * The line prints dollars to four places, so every figure is carried as whole
 * ten-thousandths of a dollar. The total is then exactly the sum of the figures
 * printed beside it, which a sum of the raw amounts need not be.
 */
const unitsPerDollar = 10_000;

/**
 * The cost line for an episode whose rounds spent `rounds`, as one line with no
 * trailing newline.
 *
 * Every round is named, in order, and a round the CLI reported no dollars for is
 * named as unknown. The total is the sum of the figures printed, so it never
 * disagrees with the parts beside it, and it counts only the rounds that carry
 * one: a total over unknown rounds understates the episode.
 *
 * The tokens are reported whatever could be priced, because the reviewer reports
 * them either way.
 */
export function renderCostLine(rounds: readonly RoundCost[]): string {
  // An episode can close having run no round at all, and the only honest line
  // then reports no figure: zero tokens would read as a round that spent none.
  if (rounds.length === 0) return "No rounds ran, so no cost was reported";

  const over = `over ${rounds.length} ${rounds.length === 1 ? "round" : "rounds"}`;
  const consumed = `${grouped(rounds.reduce((total, round) => total + round.tokens, 0))} tokens`;
  const amounts = rounds.map(unitsFor);
  const priced = amounts.filter((amount) => amount !== undefined);

  // A model the CLI cannot price reports nothing for every round of every
  // episode, which is a setup problem rather than a fact about any one round.
  if (priced.length === 0) return `Cost unavailable for this model ${over} · ${consumed}`;

  const total = asDollars(priced.reduce((sum, amount) => sum + amount, 0));
  const each = amounts.map((amount) => (amount === undefined ? "unknown" : asDollars(amount)));
  return `Cost ${total} ${over}: ${each.join(", ")} · ${consumed}`;
}

/** What the round cost, or `undefined` where the CLI priced none of it. */
function unitsFor(round: RoundCost): number | undefined {
  // Zero dollars is a price that was never quoted, whatever the tokens say, and
  // a round that reported nothing at all is a round killed before its first
  // message completed. Both are unknown, and neither is free.
  if (round.dollars <= 0) return undefined;
  // An amount smaller than the last place printed rounds up into it. Rounding it
  // down would print the one figure this line must never print.
  return Math.max(1, Math.round(round.dollars * unitsPerDollar));
}

function asDollars(units: number): string {
  const whole = Math.trunc(units / unitsPerDollar);
  const fraction = String(units % unitsPerDollar).padStart(4, "0");
  return `$${grouped(whole)}.${fraction}`;
}

// The digits are grouped here rather than by a locale, so that the line a person
// reads does not depend on the locale data the runtime happens to carry.
function grouped(count: number): string {
  return String(count).replace(/\B(?=(?:\d{3})+$)/gu, ",");
}
