/**
 * Every line is asserted whole. The failure this module exists to prevent is a
 * line that is perfectly well formed and says the wrong thing about what the
 * review spent, so a test that looked for each figure on its own would pass on
 * exactly the output worth catching.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { unspent, type RoundCost } from "../reviewers/adapter.ts";
import { renderSpendLine } from "./spend-line.ts";

function round(dollars: number, tokens: number, messages = 4): RoundCost {
  return { dollars, tokens, messages };
}

test("the rounds render as the line the specification shows", () => {
  const rounds = [round(0.0061, 20_100), round(0.0044, 16_400), round(0.0029, 11_700)];
  assert.equal(
    renderSpendLine(rounds),
    "48,200 tokens over 3 rounds: 20,100, 16,400, 11,700 · $0.0134",
  );
});

/**
 * A subscription puts no price on a round, so `pi` reports the tokens and no
 * dollars at all. The line ends at the tokens rather than standing in a zero, and
 * nothing tells the reader that cost was unavailable, because for that reader it
 * was never available and is not missing.
 */
test("an episode no round of which was priced ends at the tokens", () => {
  const line = renderSpendLine([round(0, 20_100), round(0, 16_400)]);
  assert.equal(line, "36,500 tokens over 2 rounds: 20,100, 16,400");
  assert.ok(!line.includes("$"), `an unpriced episode carried a dollar figure: ${line}`);
});

/**
 * A round killed before its first assistant message completed comes back as
 * `unspent`, which reports no message and so no figures. Zero tokens there would
 * say it spent none.
 */
test("a round that completed no message is unknown rather than zero", () => {
  const line = renderSpendLine([round(0.0061, 20_100), unspent]);
  assert.equal(line, "20,100 tokens over 2 rounds: 20,100, unknown · $0.0061");
  assert.ok(!line.includes(", 0"), `a round that reported nothing printed as zero: ${line}`);
});

// Half an episode priced is a total over the rounds that carry a price, and the
// tokens of every round that reported one.
test("a dollar total covers only the rounds that were priced", () => {
  assert.equal(
    renderSpendLine([round(0.0061, 20_100), round(0, 16_400)]),
    "36,500 tokens over 2 rounds: 20,100, 16,400 · $0.0061",
  );
});

test("one round reads as one round", () => {
  assert.equal(
    renderSpendLine([round(0.0061, 20_100)]),
    "20,100 tokens over 1 round: 20,100 · $0.0061",
  );
});

// Every round unreported leaves nothing to total and no figure to print per
// round, so the line says that once.
test("an episode no round of which reported anything says so once", () => {
  const line = renderSpendLine([unspent, unspent]);
  assert.equal(line, "No spend was reported over 2 rounds");
  assert.ok(!line.includes("unknown"), `the unreported rounds were listed: ${line}`);
});

// The state file can hold an empty list, and the composer hands it over as it
// stands.
test("an episode that ran no round reports no spend", () => {
  assert.equal(renderSpendLine([]), "No rounds ran");
});

// An amount below the last place printed is still an amount, and the one figure
// this line must never print is $0.0000.
test("a dollar total smaller than the last place printed rounds up into it", () => {
  assert.equal(renderSpendLine([round(0.000008, 40)]), "40 tokens over 1 round: 40 · $0.0001");
});

test("tokens and dollars both carry their thousands separators", () => {
  assert.equal(
    renderSpendLine([round(1234.5678, 1_200_000), round(0.4322, 34_567)]),
    "1,234,567 tokens over 2 rounds: 1,200,000, 34,567 · $1,235.0000",
  );
});

/**
 * A floor is at least what the round spent. Read as a total, it is a figure the
 * reader takes as complete, and the sum it goes into is understated by the same
 * amount. Tokens and dollars come from the same messages, so both are marked.
 */
test("a round whose cost is a floor is marked as one, and so is the total that holds it", () => {
  assert.equal(
    renderSpendLine([round(0.0061, 20_100), { ...round(0.0044, 16_400), floor: true }]),
    "At least 36,500 tokens over 2 rounds: 20,100, at least 16,400 · at least $0.0105",
  );
});

// A round killed before its first message completed is a floor with no figure
// of its own. The request it had in flight was spent and goes uncounted in the
// total, so the total is a floor even though the round reads as unknown.
test("a floor round that reported nothing leaves the total a floor", () => {
  assert.equal(
    renderSpendLine([round(0.0061, 20_100), { ...unspent, floor: true }]),
    "At least 20,100 tokens over 2 rounds: 20,100, unknown · at least $0.0061",
  );
});

// A floor in an unpriced episode has no dollars to mark, and the tokens still are.
test("a floor in an episode no round of which was priced marks the tokens", () => {
  assert.equal(
    renderSpendLine([{ ...round(0, 20_100), floor: true }]),
    "At least 20,100 tokens over 1 round: at least 20,100",
  );
});

/** A Copilot round: AI credits and no dollars, its messages being model requests. */
function copilotRound(tokens: number, credits: number): RoundCost {
  return { dollars: 0, tokens, messages: 5, credits };
}

test("Copilot rounds carry AI credits in place of dollars", () => {
  const line = renderSpendLine([copilotRound(18_200, 0.36), copilotRound(13_200, 0.48)]);
  assert.equal(line, "31,400 tokens over 2 rounds: 18,200, 13,200 · 0.84 AI credits");
  assert.ok(!line?.includes("$"), `a round Copilot priced in credits showed dollars: ${line}`);
});

/**
 * A round with no cost is not a round that spent nothing. Summed as zero, the
 * line would read "over 2 rounds" and claim a total for a round nothing was
 * reported for.
 */
test("a round with no cost is left out of the line, which says how many rounds it covers", () => {
  assert.equal(
    renderSpendLine([copilotRound(18_200, 0.36), undefined]),
    "18,200 tokens over 1 of 2 rounds · 0.36 AI credits",
  );
  assert.equal(
    renderSpendLine([undefined, copilotRound(18_200, 0.36)]),
    "18,200 tokens over 1 of 2 rounds · 0.36 AI credits",
  );
});

// No figure at all is not a figure of nothing, so "0 tokens" is the line this
// must never print.
test("an episode no round of which has a cost carries no spend line", () => {
  assert.equal(renderSpendLine([undefined, undefined]), null);
});

// An episode whose reviewer changed between rounds holds rounds priced each way,
// and each total covers the rounds that carry it.
test("credits sit beside dollars where some rounds carry each", () => {
  assert.equal(
    renderSpendLine([round(0.0061, 20_100), copilotRound(18_200, 0.36)]),
    "38,300 tokens over 2 rounds: 20,100, 18,200 · $0.0061 · 0.36 AI credits",
  );
});

// The one credit figure the line must never print for credits reported is 0.00.
test("a credit total smaller than the last place printed rounds up into it", () => {
  assert.equal(
    renderSpendLine([copilotRound(400, 0.004)]),
    "400 tokens over 1 round: 400 · 0.01 AI credits",
  );
});
