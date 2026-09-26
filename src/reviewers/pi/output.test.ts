import assert from "node:assert/strict";
import { test } from "node:test";

import type { Reported, RoundOutput } from "../adapter.ts";
import { type OutputRead, readOutput, verdictFor } from "./output.ts";
import { FINISH_REVIEW, REPORT_FINDING, REPORT_VERDICT } from "./reporting.ts";
import { type PiEvent, readEvents } from "./stream.ts";

const lineFinding = {
  scope: "line",
  file: "src/cards/place.ts",
  line: 128,
  severity: "high",
  headline: "Card can be placed off-screen once the explanation expands",
  reasoning: ["`placeCard()` clamps against `window.innerHeight` before the animation runs."],
  suggestedFix: "Re-run `placeCard()` from the animation's completion callback.",
};

const changeFinding = {
  scope: "change",
  severity: "low",
  headline: "The change duplicates the existing placement helper",
  reasoning: ["`src/cards/clamp.ts` already does this."],
  suggestedFix: "Call the existing helper.",
};

const ruling = { thread: "PRRT_kwDOAbc123", verdict: "fixed" };

let nextCall = 0;

/** One reporting call answered, as the extension answers it. */
function reported(toolName: string, details: unknown): PiEvent {
  nextCall += 1;
  return {
    type: "tool_execution_end",
    toolCallId: `call_${nextCall}`,
    toolName,
    isError: false,
    result: { content: [{ type: "text", text: "Reported" }], details },
  };
}

/** One reporting call the extension refused, which is what the reviewer was told. */
function refused(toolName: string, said: string): PiEvent {
  nextCall += 1;
  return {
    type: "tool_execution_end",
    toolCallId: `call_${nextCall}`,
    toolName,
    isError: true,
    result: { content: [{ type: "text", text: said }], details: {} },
  };
}

const finished = reported(FINISH_REVIEW, {});

async function* streamed(events: readonly PiEvent[]): AsyncGenerator<PiEvent> {
  for (const event of events) yield event;
}

function read(events: readonly PiEvent[]): Promise<OutputRead> {
  return readOutput(streamed(events));
}

function readingOf(result: OutputRead): RoundOutput {
  const said = result.outcome === "failed" ? result.reason : "";
  assert.ok(result.outcome === "read", `expected a reading, and the output failed: ${said}`);
  return result;
}

function failureOf(result: OutputRead): string {
  assert.ok(result.outcome === "failed", "expected a failure, and the output read as a result");
  return result.reason;
}

test("a finding reported by a call comes back as the finding it carried", async () => {
  const output = readingOf(await read([reported(REPORT_FINDING, lineFinding), finished]));
  assert.deepEqual(output.findings, [lineFinding]);
});

test("the findings come back in the order they were reported", async () => {
  const output = readingOf(
    await read([
      reported(REPORT_FINDING, lineFinding),
      reported(REPORT_FINDING, changeFinding),
      finished,
    ]),
  );
  assert.deepEqual(output.findings, [lineFinding, changeFinding]);
});

test("a review that reported nothing and finished is an empty review rather than a failure", async () => {
  const output = readingOf(await read([finished]));
  assert.deepEqual(output.findings, []);
  assert.deepEqual(output.verdicts, []);
});

/**
 * The distinction the failed-round decision rests on: silence is a reviewer
 * that found nothing and a reviewer that never reached the end of its review,
 * and only the reviewer can say which.
 */
test("a review that reported nothing and did not finish fails rather than reading as empty", async () => {
  const reason = failureOf(await read([]));
  assert.match(reason, /reported nothing and did not finish its review/);
});

test("a review cut short after reporting names how much it got through", async () => {
  const reason = failureOf(
    await read([
      reported(REPORT_FINDING, lineFinding),
      reported(REPORT_FINDING, changeFinding),
      reported(REPORT_VERDICT, ruling),
    ]),
  );
  assert.match(reason, /reported 2 findings and 1 verdict and did not finish its review/);
});

test("a call the reviewer got wrong is passed over, and the calls around it stand", async () => {
  const output = readingOf(
    await read([
      reported(REPORT_FINDING, lineFinding),
      refused(REPORT_FINDING, "the finding names no severity of high, medium or low"),
      reported(REPORT_FINDING, changeFinding),
      finished,
    ]),
  );
  assert.deepEqual(output.findings, [lineFinding, changeFinding]);
});

test("a call that was answered and cannot be read back fails the output", async () => {
  const reason = failureOf(
    await read([
      reported(REPORT_FINDING, lineFinding),
      reported(REPORT_FINDING, { ...changeFinding, severity: "critical" }),
      finished,
    ]),
  );
  assert.match(reason, /a finding the reviewer reported names no severity/);
});

test("a finish the extension refused does not finish the review", async () => {
  const reason = failureOf(await read([refused(FINISH_REVIEW, "no")]));
  assert.match(reason, /did not finish its review/);
});

test("a verdict comes back for each thread the reviewer ruled on", async () => {
  const other = { thread: "PRRT_kwDOAbc456", verdict: "open" };
  const output = readingOf(
    await read([reported(REPORT_VERDICT, ruling), reported(REPORT_VERDICT, other), finished]),
  );
  assert.deepEqual(output.verdicts, [ruling, other]);
  assert.equal(verdictFor(output.verdicts, "PRRT_kwDOAbc456"), "open");
});

test("a thread the reviewer passed over reports no verdict rather than open", async () => {
  const output = readingOf(await read([reported(REPORT_VERDICT, ruling), finished]));
  assert.equal(verdictFor(output.verdicts, "PRRT_kwDOAbc999"), null);
});

test("a second ruling on one thread leaves the first standing", async () => {
  const output = readingOf(
    await read([
      reported(REPORT_VERDICT, ruling),
      reported(REPORT_VERDICT, { thread: ruling.thread, verdict: "open" }),
      finished,
    ]),
  );
  assert.deepEqual(output.verdicts, [ruling]);
});

test("a tool the reviewer read the code with reports nothing", async () => {
  const output = readingOf(
    await read([
      reported("read", { content: "the whole file" }),
      reported(REPORT_FINDING, lineFinding),
      finished,
    ]),
  );
  assert.deepEqual(output.findings, [lineFinding]);
});

test("each report is told to the caller as it arrives", async () => {
  const told: Reported[] = [];
  const result = await readOutput(
    streamed([
      reported(REPORT_FINDING, lineFinding),
      reported(REPORT_VERDICT, ruling),
      reported(REPORT_FINDING, changeFinding),
      finished,
    ]),
    (output) => told.push(output),
  );

  readingOf(result);
  assert.deepEqual(
    told.map((output) => [output.findings.length, output.verdicts.length, output.finished]),
    [
      [1, 0, false],
      [1, 1, false],
      [2, 1, false],
      [2, 1, true],
    ],
    "a caller stopped mid-stream keeps what it was last told",
  );
  assert.deepEqual(told.at(-1)?.findings, [lineFinding, changeFinding]);
});

/**
 * What a caller stopped at its time bound reads the round as a review from. It is
 * told separately from the reports, because a review finished with nothing found
 * adds no report to tell.
 */
test("the caller is told when the reviewer reports the review complete", async () => {
  const told: boolean[] = [];
  await readOutput(streamed([finished]), (output) => told.push(output.finished));
  assert.deepEqual(told, [true]);
});

/**
 * The other half of what a caller stopped at its time bound reads the round from.
 * A declaration says the review is finished; it says nothing about a report that
 * was accepted and could not be read back, so the two are told together.
 */
test("a report that cannot be read back is told to the caller with the declaration", async () => {
  const told: Reported[] = [];
  await readOutput(
    streamed([reported(REPORT_FINDING, { ...changeFinding, severity: "critical" }), finished]),
    (output) => told.push(output),
  );
  assert.match(told.at(-1)?.broken ?? "", /a finding the reviewer reported names no severity/u);
  assert.equal(told.at(-1)?.finished, true, "the declaration stands beside the failure");
});

test("what the caller was told is not changed by what arrives after it", async () => {
  const told: Reported[] = [];
  await readOutput(
    streamed([reported(REPORT_FINDING, lineFinding), reported(REPORT_FINDING, changeFinding)]),
    (output) => told.push(output),
  );
  assert.deepEqual(told[0]?.findings, [lineFinding]);
});

test("a line the reader dropped does not fail a review it could read", async () => {
  const dropped: PiEvent = { type: "unreadable", reason: "a line is not JSON: {" };
  const output = readingOf(await read([dropped, reported(REPORT_FINDING, lineFinding), finished]));
  assert.deepEqual(output.findings, [lineFinding]);
});

test("a failure names how many lines the reader dropped", async () => {
  const dropped: PiEvent = { type: "unreadable", reason: "a line is not JSON: {" };
  const reason = failureOf(await read([dropped, dropped]));
  assert.match(reason, /did not finish its review; 2 lines of the stream could not be read/);
});

test("nothing throws on whatever a call carried", async () => {
  const carried = [undefined, null, 0, "", [], { scope: "line" }, { findings: [] }];
  for (const details of carried) {
    const result = await read([reported(REPORT_FINDING, details), finished]);
    assert.equal(result.outcome, "failed", `${JSON.stringify(details)} was read as a finding`);
  }
});

test("a call carrying no result at all fails rather than throwing", async () => {
  const empty: PiEvent = {
    type: "tool_execution_end",
    toolCallId: "call_0",
    toolName: REPORT_FINDING,
    isError: false,
    result: undefined,
  };
  assert.match(failureOf(await read([empty, finished])), /a finding the reviewer reported/);
});

/** The events as the reader really yields them, to hold the seam between the two. */
test("the reports are read out of a stream of pi's own lines", async () => {
  const lines = [
    { type: "agent_start" },
    { type: "message_end", message: { role: "user", content: [{ type: "text", text: "go" }] } },
    { type: "tool_execution_start", toolCallId: "1", toolName: "read", args: {} },
    {
      type: "tool_execution_end",
      toolCallId: "1",
      toolName: "read",
      isError: false,
      result: { content: [{ type: "text", text: "the whole file" }] },
    },
    {
      type: "tool_execution_start",
      toolCallId: "2",
      toolName: REPORT_FINDING,
      args: lineFinding,
    },
    {
      type: "tool_execution_end",
      toolCallId: "2",
      toolName: REPORT_FINDING,
      isError: false,
      result: { content: [{ type: "text", text: "Reported" }], details: lineFinding },
    },
    {
      type: "tool_execution_end",
      toolCallId: "3",
      toolName: REPORT_VERDICT,
      isError: false,
      result: { content: [{ type: "text", text: "Ruled" }], details: ruling },
    },
    {
      type: "tool_execution_end",
      toolCallId: "4",
      toolName: FINISH_REVIEW,
      isError: false,
      result: { content: [{ type: "text", text: "done" }], details: {} },
    },
    { type: "agent_end", messages: [] },
  ];
  const stdout = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
  async function* chunks(): AsyncGenerator<string> {
    for (let at = 0; at < stdout.length; at += 17) yield stdout.slice(at, at + 17);
  }
  const output = readingOf(await readOutput(readEvents(chunks())));
  assert.deepEqual(output.findings, [lineFinding]);
  assert.equal(verdictFor(output.verdicts, ruling.thread), "fixed");
});
