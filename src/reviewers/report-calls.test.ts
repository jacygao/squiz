/**
 * The reporting calls with no CLI around them, as whatever serves them sees
 * them. What each call accepts, refuses and answers is held by the `pi`
 * extension's tests, which drive these same calls through `pi`'s API; this
 * holds what any other server relies on besides.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { reportCalls } from "./report-calls.ts";
import type { Line, ReportFile } from "./report-file.ts";
import { FINISH_REVIEW, REPORT_FINDING, reportingTools } from "./reporting.ts";

/** A file that keeps its lines in memory. */
function kept(): { file: ReportFile; lines: Line[] } {
  const lines: Line[] = [];
  return { file: { record: (line) => lines.push(line) }, lines };
}

const refusing: ReportFile = {
  record: () => {
    throw new Error("disk full");
  },
};

const finding = {
  scope: "change",
  severity: "low",
  headline: "The retry has no bound",
  reasoning: ["Nothing stops the loop once the network is gone."],
  suggestedFix: "Bound the retries.",
};

test("the calls are the ones the grant carries, each with a schema", () => {
  const { calls } = reportCalls(kept().file);
  assert.deepEqual(
    calls.map((call) => call.name),
    reportingTools,
  );
  for (const call of calls) {
    assert.equal(typeof call.parameters, "object", `${call.name} carries no schema`);
    assert.notEqual(call.description, "", `${call.name} carries no description`);
  }
});

test("a call answers with the reviewer's text and the harness's details, once recorded", () => {
  const { file, lines } = kept();
  const call = reportCalls(file).calls.find((each) => each.name === REPORT_FINDING);
  const answer = call?.answer(finding);
  assert.equal(answer?.text, `Reported: ${finding.headline}`);
  assert.deepEqual(answer?.details, finding);
  assert.deepEqual(lines, [{ type: "report", call: REPORT_FINDING, value: finding }]);
});

test("a call stopped before it ran is recorded, and answered with its reason as given", () => {
  const { file, lines } = kept();
  assert.equal(reportCalls(file).stopped("bash", "no"), "no");
  assert.deepEqual(lines, [{ type: "refused", call: "bash", reason: "no", stopped: true }]);
});

test("a stopped call the file refused says so after its reason", () => {
  assert.equal(
    reportCalls(refusing).stopped("bash", "no"),
    "no The refusal could not be recorded (disk full).",
  );
});

test("the review is finished only once the finish is recorded", () => {
  const unrecorded = reportCalls(refusing);
  const finish = unrecorded.calls.find((each) => each.name === FINISH_REVIEW);
  assert.throws(() => finish?.answer({}), /could not be recorded/u);
  assert.equal(unrecorded.finished(), false);

  const recorded = reportCalls(kept().file);
  recorded.calls.find((each) => each.name === FINISH_REVIEW)?.answer({});
  assert.equal(recorded.finished(), true);
});
