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
