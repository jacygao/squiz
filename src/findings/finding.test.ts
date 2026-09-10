import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bySeverity,
  type ChangeFinding,
  type Finding,
  hasReference,
  type LineFinding,
  orderBySeverity,
  type Scope,
  type Severity,
} from "./finding.ts";

/**
 * A finding of the given severity, carrying its headline so that a sequence of
 * findings can be asserted as a sequence of headlines.
 *
 * The anchor is the headline's, and the tests that pin the tie hand it lines
 * that descend. A comparator breaking a tie on `file:line` therefore reorders
 * them, which is what the sequence assertion catches.
 */
function finding(severity: Severity, headline: string, line = 12): Finding {
  return {
    scope: "line",
    file: `src/${headline}.ts`,
    line,
    severity,
    headline,
    reasoning: ["The one point beneath the headline."],
    suggestedFix: "Do the other thing.",
  };
}

function headlines(findings: readonly Finding[]): string[] {
  return findings.map((found) => found.headline);
}

test("a finding scoped to a line carries the anchor its comment is placed on", () => {
  const anchored: LineFinding = {
    scope: "line",
    file: "src/ui/card.ts",
    line: 88,
    severity: "high",
    headline: "Card can be placed off-screen once the explanation expands",
    reasoning: ["`placeCard()` clamps before the animation runs.", "Triggers at 150% zoom."],
    suggestedFix: "Re-run `placeCard()` from the completion callback.",
    reference: "`AGENTS.md`: re-run placement whenever the card's height changes.",
  };
  assert.equal(anchored.file, "src/ui/card.ts");
  assert.equal(anchored.line, 88);
});

test("a finding scoped to the change carries no anchor", () => {
  const whole: ChangeFinding = {
    scope: "change",
    severity: "medium",
    headline: "The feature duplicates one the project already has",
    reasoning: ["`src/config/config.ts` already loads this file."],
    suggestedFix: "Call the existing loader.",
  };
  assert.equal("file" in whole, false, "a finding scoped to the change names no file");
  assert.equal("line" in whole, false, "a finding scoped to the change names no line");
});

// The illegal shapes below are checked by `npm run typecheck`, not by this run:
// `@ts-expect-error` is a compile-time assertion, and a shape that becomes
// legal fails the check as an unused directive. Each directive sits on the line
// the error is reported at, so it silences that one error and no other.

test("the type refuses a finding scoped to the change that carries an anchor", () => {
  // @ts-expect-error a finding scoped to the change carries no line
  const withLine: Finding = {
    scope: "change",
    severity: "low",
    headline: "Named for the shape it must not have",
    reasoning: ["A finding about the change as a whole has nowhere to put a line."],
    suggestedFix: "Scope it to the line instead.",
    line: 12,
  };

  // @ts-expect-error a finding scoped to the change carries no file
  const withFile: Finding = {
    scope: "change",
    severity: "low",
    headline: "Named for the shape it must not have",
    reasoning: ["A finding about the change as a whole has nowhere to put a file."],
    suggestedFix: "Scope it to the line instead.",
    file: "src/place.ts",
  };

  assert.equal(withLine.scope, "change");
  assert.equal(withFile.scope, "change");
});

test("the refusal holds for a finding that reaches the type as a variable", () => {
  // The case `file?: never` exists for: excess property checking bars only a
  // fresh object literal, and this one is not fresh by the time it is widened.
  const built = {
    scope: "change" as const,
    severity: "high" as const,
    headline: "Built elsewhere, then widened",
    reasoning: ["The anchor came from a line-scoped finding it was copied from."],
    suggestedFix: "Drop the anchor.",
    file: "src/place.ts",
    line: 3,
  };
  // @ts-expect-error the anchor survives the widening, and the type refuses it
  const widened: Finding = built;
  assert.equal(widened.scope, "change");
});

test("the type refuses a finding scoped to a line with no anchor", () => {
  // @ts-expect-error a finding scoped to a line carries a file and a line
  const unanchored: Finding = {
    scope: "line",
    severity: "high",
    headline: "Scoped to a line it never names",
    reasoning: ["The comment has nowhere to go."],
    suggestedFix: "Name the file and the line.",
  };
  assert.equal(unanchored.scope, "line");
});

test("the type refuses a scope or a severity outside its union", () => {
  const scope: Finding = {
    // @ts-expect-error the scopes are "line" and "change"
    scope: "file",
    severity: "high",
    headline: "A scope the router has no branch for",
    reasoning: ["Nothing routes it."],
    suggestedFix: "Scope it to the line or to the change.",
  };

  const severity: Finding = {
    scope: "change",
    // @ts-expect-error the severities are "high", "medium" and "low"
    severity: "critical",
    headline: "A severity the order has no place for",
    reasoning: ["Nothing orders it."],
    suggestedFix: "Call it high.",
  };

  assert.equal(scope.severity, "high");
  assert.equal(severity.scope, "change");
});

test("`Scope` names the two scopes a finding declares and no third", () => {
  const both: readonly Scope[] = ["line", "change"];
  // @ts-expect-error a scope no finding declares is not a `Scope`
  const third: Scope = "hunk";
  assert.equal(both.includes(third), false, "`hunk` is not one of the two scopes");
});

test("the type refuses reasoning written as one paragraph", () => {
  const paragraph: Finding = {
    scope: "change",
    severity: "low",
    headline: "Reasoning as prose",
    // @ts-expect-error the reasoning is a list of bullets, one point each
    reasoning: "One string is not a list of bullets.",
    suggestedFix: "Write the points as bullets.",
  };
  assert.equal(paragraph.severity, "low");
});

// A comparator compared only against its opposite passes when it is reversed,
// so every pair of the three severities is checked, and the order is asserted
// as a whole sequence. (review-harness-spec, "Findings")

test("severity orders findings high, medium, low", () => {
  const shuffled = [
    finding("low", "low"),
    finding("high", "high"),
    finding("medium", "medium"),
  ];
  assert.deepEqual(headlines(orderBySeverity(shuffled)), ["high", "medium", "low"]);
});

test("the order is the same whatever order the findings arrive in", () => {
  const arrivals: ReadonlyArray<readonly Severity[]> = [
    ["high", "medium", "low"],
    ["high", "low", "medium"],
    ["medium", "high", "low"],
    ["medium", "low", "high"],
    ["low", "high", "medium"],
    ["low", "medium", "high"],
  ];
  for (const arrival of arrivals) {
    const ordered = orderBySeverity(arrival.map((severity) => finding(severity, severity)));
    assert.deepEqual(
      headlines(ordered),
      ["high", "medium", "low"],
      `findings arriving as ${arrival.join(", ")} must be ordered high, medium, low`,
    );
  }
});

test("the comparator ranks every pair of severities, and ties at zero", () => {
  const expected: ReadonlyArray<readonly [Severity, Severity, number]> = [
    ["high", "high", 0],
    ["high", "medium", -1],
    ["high", "low", -1],
    ["medium", "high", 1],
    ["medium", "medium", 0],
    ["medium", "low", -1],
    ["low", "high", 1],
    ["low", "medium", 1],
    ["low", "low", 0],
  ];
  for (const [left, right, sign] of expected) {
    assert.equal(
      Math.sign(bySeverity(finding(left, left), finding(right, right))),
      sign,
      `${left} against ${right} must compare as ${sign}`,
    );
  }
});

// Two findings of one severity keep the order the reviewer returned them in,
// which a comparator breaking the tie on anything at all would lose.
// (review-harness-spec, "Findings")

test("findings of one severity keep the order the reviewer returned them in", () => {
  const returned = [
    finding("medium", "zulu", 40),
    finding("medium", "alpha", 30),
    finding("medium", "mike", 20),
    finding("medium", "bravo", 10),
  ];
  assert.deepEqual(headlines(orderBySeverity(returned)), ["zulu", "alpha", "mike", "bravo"]);
});

test("the returned order survives inside each severity when the severities mix", () => {
  const returned = [
    finding("low", "low-tango", 80),
    finding("high", "high-zulu", 70),
    finding("medium", "medium-yankee", 60),
    finding("low", "low-charlie", 50),
    finding("high", "high-alpha", 40),
    finding("low", "low-delta", 30),
    finding("medium", "medium-bravo", 20),
    finding("high", "high-mike", 10),
  ];
  assert.deepEqual(headlines(orderBySeverity(returned)), [
    "high-zulu",
    "high-alpha",
    "high-mike",
    "medium-yankee",
    "medium-bravo",
    "low-tango",
    "low-charlie",
    "low-delta",
  ]);
});

test("ordering leaves the findings it was handed as they were", () => {
  const returned = [finding("low", "low"), finding("high", "high")];
  const ordered = orderBySeverity(returned);
  assert.deepEqual(headlines(returned), ["low", "high"]);
  assert.notEqual(ordered, returned, "the ordered findings are a new array");
});

// A reference that is absent and one that is empty must not collapse: a caller
// that took the empty string for absence would emit an empty quote block.
// (review-harness-spec, "The comment format")

test("a reference that is absent is not a reference that is empty", () => {
  const absent: Finding = {
    scope: "change",
    severity: "low",
    headline: "No convention to quote",
    reasoning: ["The reviewer had nothing to cite."],
    suggestedFix: "Do the other thing.",
  };
  const empty: Finding = { ...absent, reference: "" };
  const quoted: Finding = { ...absent, reference: "`AGENTS.md`: name the file." };

  assert.equal(hasReference(absent), false, "an absent reference is no reference");
  assert.equal(hasReference(empty), true, "an empty reference is a reference that is empty");
  assert.equal(hasReference(quoted), true);

  assert.equal("reference" in absent, false, "absence is the property not being there");
  assert.equal("reference" in empty, true);
  assert.notDeepEqual(absent, empty, "the two must stay distinguishable as values");
});

test("a reference set to undefined reads as absent", () => {
  // JSON has no undefined, so this is the shape a finding takes when it is
  // built in code rather than parsed. It must read the same as an absent one.
  const unset: Finding = {
    scope: "change",
    severity: "low",
    headline: "No convention to quote",
    reasoning: ["The reviewer had nothing to cite."],
    suggestedFix: "Do the other thing.",
    reference: undefined,
  };
  assert.equal(hasReference(unset), false);
});
