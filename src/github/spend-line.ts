/**
 * The summary's spend line: the tokens each round of the episode spent, in the
 * order the rounds ran, with the episode's total and the dollars behind it.
 *
 * Tokens lead because every reviewer reports them and not every reviewer is
 * priced. A model run on a subscription has no dollar figure at all, and the
 * line carries none for it rather than standing in a zero.
 *
 * The rounds arrive on their own, and that is the whole of what this is given.
 * What an episode spent outside its rounds is a second ledger, it is not a
 * round, and it must not appear in the line as one.
 */

import type { RoundCost } from "../reviewers/adapter.ts";

/**
 * Dollars print to four places, so the total is carried as whole
 * ten-thousandths of a dollar.
 */
const unitsPerDollar = 10_000;

/**
 * The spend line for an episode whose rounds spent `rounds`, as one line with no
 * trailing newline.
 *
 * Every round is named, in order. A round that completed no assistant message is
 * named as unknown: nothing it spent was reported, and a zero there would say it
 * spent nothing. The dollars follow the tokens where at least one round was
 * priced, and the total covers the rounds that carry a price.
 */
export function renderSpendLine(rounds: readonly RoundCost[]): string {
  // An episode can close having run no round at all, and there is then no spend
  // to report rather than a spend of nothing.
  if (rounds.length === 0) return "No rounds ran";

  const over = `over ${rounds.length} ${rounds.length === 1 ? "round" : "rounds"}`;
  const reported = rounds.filter(wasReported);
  if (reported.length === 0) return `No spend was reported ${over}`;

  const total = grouped(reported.reduce((sum, round) => sum + round.tokens, 0));
  const each = rounds.map((round) => (wasReported(round) ? grouped(round.tokens) : "unknown"));
  return `${total} tokens ${over}: ${each.join(", ")}${dollars(reported)}`;
}

/**
 * Whether the round reported what it spent.
 *
 * A round killed before its first assistant message completed reports no
 * message, and its figures are absent rather than zero.
 */
function wasReported(round: RoundCost): boolean {
  return round.messages > 0;
}

/** ` · $0.0134`, or nothing at all where no round of the episode was priced. */
function dollars(reported: readonly RoundCost[]): string {
  const spent = reported.reduce((sum, round) => sum + round.dollars, 0);
  if (spent <= 0) return "";
  // An amount smaller than the last place printed rounds up into it. Rounding it
  // down would print the one figure this line must never print.
  const units = Math.max(1, Math.round(spent * unitsPerDollar));
  const whole = Math.trunc(units / unitsPerDollar);
  return ` · $${grouped(whole)}.${String(units % unitsPerDollar).padStart(4, "0")}`;
}

// The digits are grouped here rather than by a locale, so that the line a person
// reads does not depend on the locale data the runtime happens to carry.
function grouped(count: number): string {
  return String(count).replace(/\B(?=(?:\d{3})+$)/gu, ",");
}
