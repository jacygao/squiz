/**
 * The summary's spend line: the tokens each round of the episode spent, in the
 * order the rounds ran, with the episode's total and the dollars and AI credits
 * behind it.
 *
 * Tokens lead because every reviewer reports them and not every reviewer is
 * priced. A model run on a subscription has no dollar figure at all, and the
 * line carries none for it rather than standing in a zero.
 *
 * The rounds arrive on their own, and that is the whole of what this is given.
 * What an episode spent outside its rounds is a second ledger, it is not a
 * round, and it must not appear in the line as one.
 */

import type { RoundCost, Spend } from "../reviewers/adapter.ts";

/**
 * Dollars print to four places, so the total is carried as whole
 * ten-thousandths of a dollar.
 */
const unitsPerDollar = 10_000;

/** AI credits print to two places. */
const unitsPerCredit = 100;

/**
 * The spend line for an episode whose rounds spent `rounds`, as one line with no
 * trailing newline, or `null` where no round has a cost.
 *
 * Every round is named, in order. A round that completed no assistant message is
 * named as unknown: nothing it spent was reported, and a zero there would say it
 * spent nothing. The dollars follow the tokens where at least one round was
 * priced, and the AI credits where at least one round reported them. Each total
 * covers the rounds that carry it.
 *
 * A round with no cost has no figure, and the line covers only the rounds that
 * have one: "over 1 of 2 rounds". It names no round on its own then, because a
 * list shorter than the rounds would not say which rounds its figures were.
 *
 * A round whose cost is a floor reads "at least", and so does every total of an
 * episode holding one, tokens, dollars and credits alike. That includes a floor
 * round named as unknown: it spent something the totals do not count.
 */
export function renderSpendLine(rounds: readonly Spend[]): string | null {
  // An episode can close having run no round at all, and there is then no spend
  // to report rather than a spend of nothing.
  if (rounds.length === 0) return "No rounds ran";

  const costed = rounds.filter((round) => round !== undefined);
  if (costed.length === 0) return null;

  const over =
    costed.length === rounds.length
      ? `over ${rounds.length} ${rounds.length === 1 ? "round" : "rounds"}`
      : `over ${costed.length} of ${rounds.length} rounds`;
  const reported = costed.filter(wasReported);
  if (reported.length === 0) return `No spend was reported ${over}`;

  const floor = costed.some((round) => round.floor === true);
  const total = grouped(reported.reduce((sum, round) => sum + round.tokens, 0));
  const each =
    costed.length === rounds.length
      ? `: ${costed
          .map((round) => (wasReported(round) ? `${atLeast(round.floor === true)}${grouped(round.tokens)}` : "unknown"))
          .join(", ")}`
      : "";
  const lead = floor ? "At least " : "";
  return `${lead}${total} tokens ${over}${each}${dollars(reported, floor)}${credits(reported, floor)}`;
}

function atLeast(floor: boolean): string {
  return floor ? "at least " : "";
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

/** ` · $0.0134`, or ` · at least $0.0134` for a floor, or nothing at all where no round of the episode was priced. */
function dollars(reported: readonly RoundCost[], floor: boolean): string {
  const spent = reported.reduce((sum, round) => sum + round.dollars, 0);
  if (spent <= 0) return "";
  return ` · ${atLeast(floor)}$${inPlaces(spent, unitsPerDollar)}`;
}

/** ` · 0.84 AI credits`, marked for a floor, or nothing where no round reported credits. */
function credits(reported: readonly RoundCost[], floor: boolean): string {
  const carrying = reported.filter((round) => round.credits !== undefined);
  if (carrying.length === 0) return "";
  const spent = carrying.reduce((sum, round) => sum + (round.credits ?? 0), 0);
  return ` · ${atLeast(floor)}${inPlaces(spent, unitsPerCredit)} AI credits`;
}

/**
 * `amount` to as many places as `units` has zeros.
 *
 * An amount smaller than the last place printed rounds up into it. Rounding it
 * down would print zero for something that was spent.
 */
function inPlaces(amount: number, units: number): string {
  const places = String(units).length - 1;
  const counted = amount > 0 ? Math.max(1, Math.round(amount * units)) : 0;
  const whole = Math.trunc(counted / units);
  return `${grouped(whole)}.${String(counted % units).padStart(places, "0")}`;
}

// The digits are grouped here rather than by a locale, so that the line a person
// reads does not depend on the locale data the runtime happens to carry.
export function grouped(count: number): string {
  return String(count).replace(/\B(?=(?:\d{3})+$)/gu, ",");
}
