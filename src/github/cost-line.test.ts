/**
 * Every line is asserted whole. The failure this module exists to prevent is a
 * line that is perfectly well formed and says the wrong thing about money, so a
 * test that looked for each figure on its own would pass on exactly the output
 * worth catching.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { unspent, type RoundCost } from "../reviewers/adapter.ts";
import { renderCostLine } from "./cost-line.ts";

function round(dollars: number, tokens: number, messages = 4): RoundCost {
  return { dollars, tokens, messages };
}

test("the rounds render as the line the specification shows", () => {
  const rounds = [round(0.0061, 20_000), round(0.0044, 16_000), round(0.0029, 12_200)];
  assert.equal(
    renderCostLine(rounds),
    "Cost $0.0134 over 3 rounds: $0.0061, $0.0044, $0.0029 · 48,200 tokens",
  );
});

/**
 * A model `pi` cannot price reports no dollars against the tokens it really
 * spent. The round is unknown rather than free, and the total counts only the
 * rounds that carry a figure.
 */
test("a round with tokens and no dollars is unknown rather than zero", () => {
  const line = renderCostLine([round(0.0061, 20_000), round(0, 16_000), round(0.0029, 12_200)]);
  assert.equal(line, "Cost $0.0090 over 3 rounds: $0.0061, unknown, $0.0029 · 48,200 tokens");
  assert.ok(!line.includes("$0.0000"), `a round priced at nothing printed as free: ${line}`);
});

// A round killed before its first assistant message completed comes back as
// `unspent`, which reports no figures at all and is unknown for that reason.
test("a round that reported nothing at all is unknown too", () => {
  assert.equal(
    renderCostLine([round(0.0061, 20_000), unspent]),
    "Cost $0.0061 over 2 rounds: $0.0061, unknown · 20,000 tokens",
  );
});

/**
 * Every round unpriced is a setup problem rather than a fact about any round, so
 * the line says it once. The tokens are still reported, because the reviewer
 * reports them whether or not anything can price them.
 */
test("an episode where no round was priced says so once, and still reports the tokens", () => {
  const line = renderCostLine([round(0, 20_000), round(0, 16_000), round(0, 12_200)]);
  assert.equal(line, "Cost unavailable for this model over 3 rounds · 48,200 tokens");
  assert.ok(!line.includes("unknown"), `the unpriced model was reported per round: ${line}`);
});

test("one round reads as one round", () => {
  assert.equal(
    renderCostLine([round(0.0061, 20_000)]),
    "Cost $0.0061 over 1 round: $0.0061 · 20,000 tokens",
  );
  assert.equal(
    renderCostLine([round(0, 20_000)]),
    "Cost unavailable for this model over 1 round · 20,000 tokens",
  );
});

// The state file can hold an empty list, and the composer hands it over as it
// stands.
test("an episode that ran no round reports no figure", () => {
  assert.equal(renderCostLine([]), "No rounds ran, so no cost was reported");
});

/**
 * Two rounds of $0.00025 print as $0.0003 each. A total summed from the raw
 * amounts and then rounded would print $0.0005 beside two figures that add to
 * $0.0006, and a reader checking the arithmetic would find the line wrong.
 */
test("the total is the sum of the figures printed beside it", () => {
  assert.equal(
    renderCostLine([round(0.00025, 900), round(0.00025, 900)]),
    "Cost $0.0006 over 2 rounds: $0.0003, $0.0003 · 1,800 tokens",
  );
});

// An amount below the last place printed is still an amount, and the one figure
// this line must never print is $0.0000.
test("an amount smaller than the last place printed rounds up into it", () => {
  assert.equal(
    renderCostLine([round(0.000008, 40)]),
    "Cost $0.0001 over 1 round: $0.0001 · 40 tokens",
  );
});

test("dollars and tokens both carry their thousands separators", () => {
  assert.equal(
    renderCostLine([round(1234.5678, 1_200_000), round(0.4322, 34_567)]),
    "Cost $1,235.0000 over 2 rounds: $1,234.5678, $0.4322 · 1,234,567 tokens",
  );
});
