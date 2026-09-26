import assert from "node:assert/strict";
import { test } from "node:test";

import { type Reading, readFinding, readVerdict } from "./reported.ts";

/**
 * A well-formed line-scoped finding, which the malformed cases are built by
 * breaking one field of.
 */
const lineFinding = {
  scope: "line",
  file: "src/cards/place.ts",
  line: 128,
  severity: "high",
  headline: "Card can be placed off-screen once the explanation expands",
  reasoning: ["`placeCard()` clamps against `window.innerHeight` before the animation runs."],
  suggestedFix: "Re-run `placeCard()` from the animation's completion callback.",
};

const fileFinding = {
  scope: "file",
  file: "src/cards/place.ts",
  severity: "medium",
  headline: "The module has no test at all",
  reasoning: ["Nothing exercises the placement path."],
  suggestedFix: "Add a test beside it.",
};

const changeFinding = {
  scope: "change",
  severity: "low",
  headline: "The change duplicates the existing placement helper",
  reasoning: ["`src/cards/clamp.ts` already does this."],
  suggestedFix: "Call the existing helper.",
};

function valueOf<T>(reading: Reading<T>): T {
  const said = "reason" in reading ? reading.reason : "";
  assert.ok(!("reason" in reading), `expected a reading, and it was refused: ${said}`);
  return reading.value;
}

function refusalOf<T>(reading: Reading<T>): string {
  assert.ok("reason" in reading, "expected a refusal, and the value was read");
  return reading.reason;
}

/** The finding with `field` left out of it, which is how an omission is built. */
function without(finding: Readonly<Record<string, unknown>>, field: string): unknown {
  const { [field]: dropped, ...rest } = finding;
  assert.notEqual(dropped, undefined, `${field} was already absent, so nothing was broken`);
  return rest;
}

test("each of the three scopes reads as the finding it is", () => {
  for (const finding of [lineFinding, fileFinding, changeFinding]) {
    assert.deepEqual(valueOf(readFinding(finding)), finding);
  }
});

test("a reference is carried where the finding has one", () => {
  const cited = { ...lineFinding, reference: "`AGENTS.md`: re-run placement on a height change." };
  assert.deepEqual(valueOf(readFinding(cited)), cited);
});

test("a finding with no reference carries none rather than an empty one", () => {
  assert.equal(Object.hasOwn(valueOf(readFinding(lineFinding)), "reference"), false);
});

test("a reference that is present and empty is malformed", () => {
  const empty = { ...lineFinding, reference: "" };
  assert.match(refusalOf(readFinding(empty)), /carries an empty reference/);
});

test("a mistyped field is caught rather than carried", () => {
  const mistyped = { ...lineFinding, line: "128" };
  assert.match(refusalOf(readFinding(mistyped)), /is scoped to a line and carries no line number/);
});

test("a line that is not finite is caught", () => {
  // JSON has no NaN, so a reviewer reaching for one writes the string.
  const mistyped = { ...lineFinding, line: "NaN" };
  assert.match(refusalOf(readFinding(mistyped)), /carries no line number/);
});

test("a finding missing a field the comment is composed from is caught", () => {
  const cases = [
    ["severity", /names no severity/],
    ["headline", /carries no headline/],
    ["reasoning", /carries no reasoning/],
    ["suggestedFix", /carries no suggested fix/],
  ] as const;
  for (const [field, expected] of cases) {
    const broken = without(lineFinding, field);
    assert.match(refusalOf(readFinding(broken)), expected, `a finding with no ${field} was read`);
  }
});

test("reasoning that is not a list of text is caught", () => {
  const flattened = { ...lineFinding, reasoning: "one long paragraph" };
  assert.match(refusalOf(readFinding(flattened)), /carries no reasoning/);
});

test("a scope carrying an anchor it must not is refused rather than trimmed", () => {
  const cases = [
    [{ ...fileFinding, line: 12 }, /is scoped to a file and carries a line/],
    [{ ...changeFinding, file: "src/a.ts" }, /is scoped to the change and carries a file/],
    [{ ...changeFinding, line: 12 }, /is scoped to the change and carries a line/],
    [without(lineFinding, "file"), /is scoped to a line and carries no file/],
    [without(fileFinding, "file"), /is scoped to a file and carries no file/],
  ] as const;
  for (const [broken, expected] of cases) {
    assert.match(refusalOf(readFinding(broken)), expected);
  }
});

test("a null anchor is not read as an absent one", () => {
  const nulled = { ...fileFinding, line: null };
  assert.match(refusalOf(readFinding(nulled)), /is scoped to a file and carries a line/);
});

test("a scope outside the three is caught", () => {
  const unknown = { ...lineFinding, scope: "lines" };
  assert.match(refusalOf(readFinding(unknown)), /names no scope of line, file or change/);
});

test("a verdict reads as the thread it names and the ruling it gives", () => {
  const ruling = { thread: "PRRT_kwDOAbc123", verdict: "withdrawn" };
  assert.deepEqual(valueOf(readVerdict(ruling)), ruling);
});

test("a verdict outside the three is caught", () => {
  const ruling = { thread: "PRRT_kwDOAbc123", verdict: "resolved" };
  assert.match(
    refusalOf(readVerdict(ruling)),
    /is none of fixed, withdrawn or open, on thread PRRT_kwDOAbc123/,
  );
});

test("a verdict naming no thread is caught", () => {
  assert.match(refusalOf(readVerdict({ verdict: "fixed" })), /names no thread/);
});

test("nothing throws on whatever arrives", () => {
  const reported = [undefined, null, 0, "", "a finding", [], [lineFinding], { scope: "line" }];
  for (const value of reported) {
    assert.ok("reason" in readFinding(value), `${JSON.stringify(value)} was read as a finding`);
    assert.ok("reason" in readVerdict(value), `${JSON.stringify(value)} was read as a verdict`);
  }
});
