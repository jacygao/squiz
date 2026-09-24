import assert from "node:assert/strict";
import { test } from "node:test";

import type { RoundOutput } from "../adapter.ts";
import { type OutputRead, readOutput, verdictFor } from "./output.ts";
import { type PiEvent, readEvents } from "./stream.ts";

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

async function* streamed(events: readonly PiEvent[]): AsyncGenerator<PiEvent> {
  for (const event of events) yield event;
}

/** A finished message from `role`, whose one text block carries `text`. */
function saidBy(role: string, text: string): PiEvent {
  return {
    type: "message_end",
    message: { role, content: [{ type: "text", text }], stopReason: "stop" },
  };
}

function read(events: readonly PiEvent[]): Promise<OutputRead> {
  return readOutput(streamed(events));
}

/** The output of a run whose reviewer's last message said `text`. */
function returning(text: string): Promise<OutputRead> {
  return read([saidBy("assistant", text)]);
}

/** The output of a run whose reviewer returned `payload` as its object. */
function returningObject(payload: unknown): Promise<OutputRead> {
  return returning(JSON.stringify(payload));
}

function readingOf(result: OutputRead): RoundOutput {
  const said = result.outcome === "failed" ? result.reason : "";
  assert.ok(result.outcome === "read", `expected a reading, and the output failed: ${said}`);
  return result;
}

function failureOf(result: OutputRead): string {
  assert.ok(result.outcome === "failed", `expected a failure, and the output read as a result`);
  return result.reason;
}

/** The finding with `field` left out of it, which is how an omission is built. */
function without(finding: Readonly<Record<string, unknown>>, field: string): unknown {
  const { [field]: dropped, ...rest } = finding;
  assert.notEqual(dropped, undefined, `${field} was already absent, so nothing was broken`);
  return rest;
}

test("a review that found nothing reads as an empty list rather than a failure", async () => {
  const output = readingOf(await returningObject({ findings: [], verdicts: [] }));
  assert.deepEqual(output.findings, []);
  assert.deepEqual(output.verdicts, []);
});

test("output carrying no findings list fails rather than reading as no findings", async () => {
  const reason = failureOf(await returningObject({ verdicts: [] }));
  assert.match(reason, /no list of findings/);
});

test("output carrying no verdicts list fails", async () => {
  const reason = failureOf(await returningObject({ findings: [] }));
  assert.match(reason, /no list of verdicts/);
});

test("a findings list that is not a list fails", async () => {
  const reason = failureOf(await returningObject({ findings: {}, verdicts: [] }));
  assert.match(reason, /no list of findings/);
});

test("the findings come back in the order they were returned", async () => {
  const returned = [lineFinding, fileFinding, changeFinding];
  const output = readingOf(await returningObject({ findings: returned, verdicts: [] }));
  assert.deepEqual(output.findings, returned);
});

test("a reference is carried where the finding has one", async () => {
  const cited = { ...lineFinding, reference: "`AGENTS.md`: re-run placement on a height change." };
  const output = readingOf(await returningObject({ findings: [cited], verdicts: [] }));
  assert.deepEqual(output.findings, [cited]);
});

test("a finding with no reference carries none rather than an empty one", async () => {
  const output = readingOf(await returningObject({ findings: [lineFinding], verdicts: [] }));
  assert.equal(Object.hasOwn(output.findings[0] ?? {}, "reference"), false);
});

test("a reference that is present and empty is malformed", async () => {
  const empty = { ...lineFinding, reference: "" };
  const reason = failureOf(await returningObject({ findings: [empty], verdicts: [] }));
  assert.match(reason, /finding 1 carries an empty reference/);
});

test("a mistyped field is caught rather than carried", async () => {
  const mistyped = { ...lineFinding, line: "128" };
  const reason = failureOf(await returningObject({ findings: [mistyped], verdicts: [] }));
  assert.match(reason, /finding 1 is scoped to a line and carries no line number/);
});

test("a line that is not finite is caught", async () => {
  // JSON has no NaN, so a reviewer reaching for one writes the string.
  const mistyped = { ...lineFinding, line: "NaN" };
  const reason = failureOf(await returningObject({ findings: [mistyped], verdicts: [] }));
  assert.match(reason, /carries no line number/);
});

test("a finding missing a field the comment is composed from is caught", async () => {
  const cases = [
    ["severity", /names no severity/],
    ["headline", /carries no headline/],
    ["reasoning", /carries no reasoning/],
    ["suggestedFix", /carries no suggested fix/],
  ] as const;
  for (const [field, expected] of cases) {
    const broken = without(lineFinding, field);
    const reason = failureOf(await returningObject({ findings: [broken], verdicts: [] }));
    assert.match(reason, expected, `a finding with no ${field} was read as a finding`);
  }
});

test("reasoning that is not a list of text is caught", async () => {
  const flattened = { ...lineFinding, reasoning: "one long paragraph" };
  const reason = failureOf(await returningObject({ findings: [flattened], verdicts: [] }));
  assert.match(reason, /carries no reasoning/);
});

test("a scope carrying an anchor it must not is refused rather than trimmed", async () => {
  const cases = [
    [{ ...fileFinding, line: 12 }, /finding 1 is scoped to a file and carries a line/],
    [{ ...changeFinding, file: "src/a.ts" }, /is scoped to the change and carries a file/],
    [{ ...changeFinding, line: 12 }, /is scoped to the change and carries a line/],
  ] as const;
  for (const [broken, expected] of cases) {
    const reason = failureOf(await returningObject({ findings: [broken], verdicts: [] }));
    assert.match(reason, expected);
  }
});

test("a null anchor is not read as an absent one", async () => {
  const nulled = { ...fileFinding, line: null };
  const reason = failureOf(await returningObject({ findings: [nulled], verdicts: [] }));
  assert.match(reason, /is scoped to a file and carries a line/);
});

test("a scope outside the three is caught", async () => {
  const unknown = { ...lineFinding, scope: "lines" };
  const reason = failureOf(await returningObject({ findings: [unknown], verdicts: [] }));
  assert.match(reason, /finding 1 names no scope of line, file or change/);
});

test("one malformed finding fails the output rather than being dropped from it", async () => {
  const findings = [lineFinding, { ...fileFinding, headline: "" }, changeFinding];
  const reason = failureOf(await returningObject({ findings, verdicts: [] }));
  assert.match(reason, /finding 2 carries no headline/);
});

test("a verdict comes back for each thread the reviewer ruled on", async () => {
  const verdicts = [
    { thread: "PRRT_kwDOAbc123", verdict: "fixed" },
    { thread: "PRRT_kwDOAbc456", verdict: "withdrawn" },
    { thread: "PRRT_kwDOAbc789", verdict: "open" },
  ];
  const output = readingOf(await returningObject({ findings: [], verdicts }));
  assert.deepEqual(output.verdicts, verdicts);
  assert.equal(verdictFor(output.verdicts, "PRRT_kwDOAbc456"), "withdrawn");
});

test("a thread the reviewer passed over reports no verdict rather than open", async () => {
  const verdicts = [{ thread: "PRRT_kwDOAbc123", verdict: "open" }];
  const output = readingOf(await returningObject({ findings: [], verdicts }));
  assert.equal(verdictFor(output.verdicts, "PRRT_kwDOAbc999"), null);
});

test("a verdict outside the three is caught", async () => {
  const verdicts = [{ thread: "PRRT_kwDOAbc123", verdict: "resolved" }];
  const reason = failureOf(await returningObject({ findings: [], verdicts }));
  assert.match(reason, /verdict 1 is none of fixed, withdrawn or open, on thread PRRT_kwDOAbc123/);
});

test("a verdict naming no thread is caught", async () => {
  const verdicts = [{ verdict: "fixed" }];
  const reason = failureOf(await returningObject({ findings: [], verdicts }));
  assert.match(reason, /verdict 1 names no thread/);
});

test("two verdicts on one thread fail rather than one of them winning", async () => {
  const verdicts = [
    { thread: "PRRT_kwDOAbc123", verdict: "fixed" },
    { thread: "PRRT_kwDOAbc123", verdict: "open" },
  ];
  const reason = failureOf(await returningObject({ findings: [], verdicts }));
  assert.match(reason, /thread PRRT_kwDOAbc123 carries more than one verdict/);
});

test("prose around the object fails rather than being read past", async () => {
  const object = JSON.stringify({ findings: [], verdicts: [] });
  const reason = failureOf(await returning(`Here is my review:\n\n${object}`));
  assert.match(reason, /is not JSON/);
});

test("a code fence around the object fails", async () => {
  const object = JSON.stringify({ findings: [], verdicts: [] });
  const reason = failureOf(await returning(`\`\`\`json\n${object}\n\`\`\``));
  assert.match(reason, /is not JSON/);
});

test("a last message that is not an object fails", async () => {
  const reason = failureOf(await returning("[]"));
  assert.match(reason, /is not one object/);
});

test("a failure quotes the message it could not read", async () => {
  const reason = failureOf(await returning("no findings this round"));
  assert.match(reason, /no findings this round/);
});

test("a run completing no assistant message fails", async () => {
  const reason = failureOf(await read([saidBy("user", "review this")]));
  assert.match(reason, /the run completed no assistant message/);
});

test("an assistant message carrying no text fails", async () => {
  const thinking: PiEvent = {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "thinking", thinking: "..." }] },
  };
  const reason = failureOf(await read([thinking]));
  assert.match(reason, /carries no text/);
});

test("the findings are read from the last assistant message", async () => {
  const earlier = JSON.stringify({ findings: [changeFinding], verdicts: [] });
  const last = JSON.stringify({ findings: [lineFinding], verdicts: [] });
  const output = readingOf(
    await read([
      saidBy("assistant", earlier),
      saidBy("toolResult", "src/cards/place.ts, 200 lines"),
      saidBy("assistant", last),
      saidBy("toolResult", "done"),
    ]),
  );
  assert.deepEqual(output.findings, [lineFinding]);
});

test("text split across blocks is read as one message", async () => {
  const object = JSON.stringify({ findings: [], verdicts: [] });
  const split: PiEvent = {
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: object.slice(0, 10) },
        { type: "text", text: object.slice(10) },
      ],
    },
  };
  const output = readingOf(await read([split]));
  assert.deepEqual(output.findings, []);
});

test("a line the reader dropped does not fail a message it could read", async () => {
  const object = JSON.stringify({ findings: [lineFinding], verdicts: [] });
  const dropped: PiEvent = { type: "unreadable", reason: "a line is not JSON: {" };
  const output = readingOf(await read([dropped, saidBy("assistant", object)]));
  assert.deepEqual(output.findings, [lineFinding]);
});

test("a failure names how many lines the reader dropped", async () => {
  const dropped: PiEvent = { type: "unreadable", reason: "a line is not JSON: {" };
  const reason = failureOf(await read([dropped, dropped]));
  assert.match(reason, /the run completed no assistant message; 2 lines of the stream/);
});

test("nothing throws on whatever the reviewer said", async () => {
  const said = [
    "",
    "{",
    "null",
    "0",
    '"findings"',
    '{"findings":null,"verdicts":null}',
    '{"findings":[null],"verdicts":[]}',
    '{"findings":[],"verdicts":[null]}',
    '{"findings":[[]],"verdicts":[]}',
    '{"findings":[],"verdicts":"none"}',
  ];
  for (const text of said) {
    const result = await returning(text);
    assert.equal(result.outcome, "failed", `"${text}" was read as a result`);
  }
});

/** The events as the reader really yields them, to hold the seam between the two. */
test("the findings are read out of a stream of pi's own lines", async () => {
  const object = JSON.stringify({
    findings: [lineFinding],
    verdicts: [{ thread: "PRRT_kwDOAbc123", verdict: "open" }],
  });
  const lines = [
    { type: "agent_start" },
    { type: "message_end", message: { role: "user", content: [{ type: "text", text: "go" }] } },
    { type: "tool_execution_start", toolCallId: "1", toolName: "read", args: {} },
    { type: "tool_execution_end", toolCallId: "1", toolName: "read", isError: false },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "..." }, { type: "text", text: object }],
        stopReason: "stop",
      },
    },
    { type: "agent_end", messages: [] },
  ];
  const stdout = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
  async function* chunks(): AsyncGenerator<string> {
    for (let at = 0; at < stdout.length; at += 17) yield stdout.slice(at, at + 17);
  }
  const output = readingOf(await readOutput(readEvents(chunks())));
  assert.deepEqual(output.findings, [lineFinding]);
  assert.equal(verdictFor(output.verdicts, "PRRT_kwDOAbc123"), "open");
});
