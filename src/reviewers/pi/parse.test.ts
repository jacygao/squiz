import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { type ParsedRun, type RoundCost, unspent } from "../adapter.ts";
import { costWith } from "./cost.ts";
import { readOutput } from "./output.ts";
import { parse } from "./parse.ts";
import { type PiEvent, readEvents } from "./stream.ts";

/** One short `pi` run, committed as it was emitted. */
const recordedRun = new URL("./recorded-run.jsonl", import.meta.url);

/** What the recorded run's two assistant messages cost between them. */
const recordedCost: RoundCost = {
  dollars: 0.0031744240000000003,
  tokens: 6697,
  messages: 2,
};

const review = {
  findings: [
    {
      scope: "line",
      file: "src/github/gh.ts",
      line: 42,
      severity: "high",
      headline: "The exit status is read before the process has exited",
      reasoning: ["`exitCode` is null until the process ends."],
      suggestedFix: "Await the exit event.",
    },
  ],
  verdicts: [{ thread: "PRRT_kwDO", verdict: "fixed" }],
};

/**
 * The hazard the one pass exists for.
 *
 * Reading the cost and then the findings over one stream leaves the second
 * reader an exhausted iterator: it finds no assistant message, and every round
 * of every episode reports as failed while the reviewer worked perfectly.
 */
test("the cost and the review both come back from one pass over the stream", async () => {
  const run = await parseText(
    session() +
      assistant("thinking", { stopReason: "toolUse", spend: 0.001 }) +
      assistant(JSON.stringify(review), { stopReason: "stop", spend: 0.002 }),
  );
  assert.equal(run.result.kind, "reviewed");
  assert.deepEqual(run.result.kind === "reviewed" ? run.result.findings : [], review.findings);
  assert.deepEqual(run.cost, { dollars: 0.003, tokens: 200, messages: 2 });
});

test("the recorded run's cost and its answer are both read from its own bytes", async () => {
  const run = await parseText(readFileSync(recordedRun, "utf8"));
  assert.deepEqual(run.cost, recordedCost);
  // The recorded run answered a question in prose, which is not a review.
  assert.equal(run.result.kind, "unparsed");
});

test("the cost is reported as each assistant message completes", async () => {
  const reported: RoundCost[] = [];
  const run = await parse(
    oneChunk(
      assistant("first", { stopReason: "toolUse", spend: 0.004 }) +
        assistant(JSON.stringify(review), { stopReason: "stop", spend: 0.006 }),
    ),
    (cost) => reported.push(cost),
  );
  assert.deepEqual(
    reported.map((cost) => cost.messages),
    [1, 2],
  );
  assert.deepEqual(reported.at(-1), run.cost);
});

test("a review that found nothing is a result rather than a failure", async () => {
  const run = await parseText(
    assistant(JSON.stringify({ findings: [], verdicts: [] }), { stopReason: "stop" }),
  );
  assert.deepEqual(run.result, { kind: "reviewed", findings: [], verdicts: [] });
});

/**
 * An errored message is `pi` retrying a failed request. One measured round
 * carried twenty-two of them and still completed a real review.
 */
test("an errored message among the working ones leaves the run reviewed", async () => {
  const errored = assistant("", { stopReason: "error", errorMessage: "503 from the provider" });
  const run = await parseText(
    errored.repeat(22) + assistant(JSON.stringify(review), { stopReason: "stop", spend: 0.002 }),
  );
  assert.equal(run.result.kind, "reviewed");
});

test("a run where no message stopped is incomplete, and carries the reason given", async () => {
  const run = await parseText(
    assistant("", { stopReason: "error", errorMessage: "no credential for the provider" }),
  );
  assert.deepEqual(run.result, { kind: "incomplete", reason: "no credential for the provider" });
});

/**
 * The stop reasons are read first. A run that completed no message has no
 * review in it, and reporting its output as unparseable would send it for a
 * retry that `pi` has already made three times itself.
 */
test("a message that never stopped is incomplete even where its text is a review", async () => {
  const run = await parseText(
    assistant(JSON.stringify(review), { stopReason: "error", errorMessage: "context exceeded" }),
  );
  assert.deepEqual(run.result, { kind: "incomplete", reason: "context exceeded" });
});

test("a run that completed nothing and gave no reason says that much", async () => {
  const run = await parseText(session() + userPrompt());
  assert.deepEqual(run.result, { kind: "incomplete", reason: "the reviewer completed no message" });
});

test("output that completed but reads as no review is the case that is retried", async () => {
  const run = await parseText(assistant("I had a look and it seems fine.", { stopReason: "stop" }));
  assert.equal(run.result.kind, "unparsed");
  assert.match(
    run.result.kind === "unparsed" ? run.result.reason : "",
    /not JSON/u,
    "the reason must name what was wrong with the output, since it is what stderr carries",
  );
});

test("a killed run's cost covers the messages that completed before the stream stopped", async () => {
  // A stream cut mid-line, which is what a reviewer stopped by a signal leaves.
  const cut = assistant("first", { stopReason: "toolUse", spend: 0.004 });
  const run = await parseText(`${cut}{"type":"message_end","mess`);
  assert.deepEqual(run.cost, { dollars: 0.004, tokens: 100, messages: 1 });
  assert.equal(run.result.kind, "incomplete");
});

/**
 * The heap while a run is read, at two lengths of the same stream.
 *
 * The control is the tempting fix for the one-pass problem: buffer the events
 * so that a cost reader and an output reader can each walk them. It has to be
 * caught by the bound for the comparison to say anything.
 *
 * The settled heap is the measure and the peak is not. Both readers decode the
 * same bytes and make the same garbage doing it, so a peak taken while either
 * runs tracks the allocation rate they share. What one of them still holds
 * shows only once that garbage is collected.
 */
test("memory does not grow with the stream's length", { timeout: 600_000 }, async () => {
  const short = await heapOver(12, onePass);
  const long = await heapOver(360, onePass);
  const controlShort = await heapOver(12, buffered);
  const controlLong = await heapOver(360, buffered);

  const streamed = long.bytes - short.bytes;
  const bound = streamed / 16;
  const grew = long.settled - short.settled;
  const control = controlLong.settled - controlShort.settled;

  assert.ok(
    control > bound,
    `buffering the events grew the settled heap by ${megabytes(control)} over ${megabytes(streamed)} more stream, which this bound does not catch`,
  );
  assert.ok(
    grew < bound,
    `the settled heap grew by ${megabytes(grew)} over ${megabytes(streamed)} more stream, against ${megabytes(control)} for a reader that buffers the events`,
  );
});

function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)}MB`;
}

type Heap = {
  readonly bytes: number;
  /** The lowest reading of the run's second half: the heap with that moment's garbage collected. */
  readonly settled: number;
};

type Reader = (chunks: AsyncIterable<string>, sample: () => void) => Promise<void>;

/** What this module does: one walk, holding a tally and the last message. */
const onePass: Reader = async (chunks, sample) => {
  const run = await parse(watched(chunks, sample));
  sample();
  assert.equal(run.result.kind, "reviewed");
};

/** What it must not do: hold the events so that two readers can each have them. */
const buffered: Reader = async (chunks, sample) => {
  const events: PiEvent[] = [];
  for await (const event of readEvents(watched(chunks, sample))) events.push(event);
  let cost = unspent;
  for (const event of events) {
    cost = costWith(cost, event);
    sample();
  }
  const output = await readOutput(asStream(events));
  sample();
  assert.equal(output.outcome, "read");
  assert.ok(cost.messages > 0);
};

async function* watched(chunks: AsyncIterable<string>, sample: () => void): AsyncGenerator<string> {
  for await (const chunk of chunks) {
    sample();
    yield chunk;
  }
}

async function* asStream(events: readonly PiEvent[]): AsyncGenerator<PiEvent> {
  for (const event of events) yield event;
}

async function heapOver(cycles: number, reader: Reader): Promise<Heap> {
  const readings: number[] = [];
  let bytes = 0;
  const sample = (): void => {
    readings.push(process.memoryUsage().heapUsed);
  };

  const counted = async function* (): AsyncGenerator<string> {
    for await (const chunk of chunksOf(run(cycles), 64 * 1024)) {
      bytes += chunk.length;
      yield chunk;
    }
  };

  await reader(counted(), sample);
  return { bytes, settled: Math.min(...readings.slice(Math.floor(readings.length / 2))) };
}

/** Lines cut into chunks of a fixed size, so that most of them straddle a line. */
async function* chunksOf(lines: Iterable<string>, size: number): AsyncGenerator<string> {
  let pending = "";
  for (const line of lines) {
    pending += line;
    while (pending.length >= size) {
      yield pending.slice(0, size);
      pending = pending.slice(size);
    }
  }
  if (pending !== "") yield pending;
}

/**
 * A stream shaped like a real round's, at whatever length is asked for: mostly
 * small deltas, with a whole content block repeated at the end of each, and one
 * completed message per cycle.
 */
function* run(cycles: number): Generator<string> {
  yield session();
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const delta = line({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: ` step ${cycle} ` },
    });
    for (let at = 0; at < 300; at += 1) yield delta;
    yield line({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: block },
    });
    yield assistant(block, { stopReason: "toolUse", spend: 0.001 });
    yield line({
      type: "tool_execution_start",
      toolCallId: `c${cycle}`,
      toolName: "read",
      args: {},
    });
    yield line({
      type: "tool_execution_end",
      toolCallId: `c${cycle}`,
      toolName: "read",
      result: { content: [{ type: "text", text: toolResult }] },
      isError: false,
    });
    yield userPrompt();
    // agent_end repeats the whole transcript, and is the largest line in the stream.
    if (cycle % 8 === 7) yield line({ type: "agent_end", messages: transcript, willRetry: true });
  }
  yield assistant(JSON.stringify(review), { stopReason: "stop", spend: 0.002 });
  yield line({ type: "agent_settled" });
}

/** The content block a `thinking_end` repeats whole. */
const block = "the reviewer thought about it. ".repeat(800);

/** What a read of one file hands back. */
const toolResult = "a line of the file under review\n".repeat(230);

const transcript = Array.from({ length: 12 }, () => ({
  role: "assistant",
  content: [{ type: "text", text: block }],
}));

type Said = {
  readonly stopReason: string;
  readonly errorMessage?: string;
  /** Dollars the message reported. Its tokens follow, so that one figure names the other. */
  readonly spend?: number;
};

function assistant(text: string, said: Said): string {
  const spend = said.spend ?? 0;
  return line({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      model: "deepseek-v4-pro",
      stopReason: said.stopReason,
      ...(said.errorMessage === undefined ? {} : { errorMessage: said.errorMessage }),
      usage: {
        input: spend === 0 ? 0 : 100,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: spend === 0 ? 0 : 100,
        cost: { input: spend, output: 0, cacheRead: 0, cacheWrite: 0, total: spend },
      },
    },
  });
}

function userPrompt(): string {
  return line({
    type: "message_end",
    message: { role: "toolResult", content: [{ type: "text", text: toolResult }] },
  });
}

function session(): string {
  return line({ type: "session", version: 3, id: "01a0", cwd: "/tmp/tree" });
}

function line(event: Record<string, unknown>): string {
  return `${JSON.stringify(event)}\n`;
}

async function* oneChunk(text: string): AsyncGenerator<string> {
  yield text;
}

function parseText(text: string): Promise<ParsedRun> {
  return parse(oneChunk(text));
}
