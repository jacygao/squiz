import assert from "node:assert/strict";
import { createReadStream, readFileSync } from "node:fs";
import { test } from "node:test";

import { type PiEvent, readEvents } from "./stream.ts";

/**
 * One short `pi` run, committed as it was emitted.
 *
 * It is what proves the reader against bytes `pi` really produced. It cannot
 * prove anything about memory: one length measured once passes whatever the
 * reader does, so the streams the memory test reads are built rather than read.
 */
const recordedRun = new URL("./recorded-run.jsonl", import.meta.url);

/** The types a clean run emits. A failing request adds `auto_retry_start` and `auto_retry_end`. */
const cleanRunTypes = [
  "agent_end",
  "agent_settled",
  "agent_start",
  "message_end",
  "message_start",
  "message_update",
  "session",
  "tool_execution_end",
  "tool_execution_start",
  "turn_end",
  "turn_start",
];

/** The deltas a `message_update` carries, one of which decides the line's size. */
const updateTypes = [
  "text_delta",
  "text_end",
  "text_start",
  "thinking_delta",
  "thinking_end",
  "thinking_start",
  "toolcall_delta",
  "toolcall_end",
  "toolcall_start",
];

function recordedLines(): readonly string[] {
  return readFileSync(recordedRun, "utf8").split("\n").slice(0, -1);
}

async function* textChunks(text: string, size: number): AsyncGenerator<string> {
  for (let at = 0; at < text.length; at += size) yield text.slice(at, at + size);
}

async function* byteChunks(text: string, size: number): AsyncGenerator<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
}

async function collect(chunks: AsyncIterable<string | Uint8Array>): Promise<readonly PiEvent[]> {
  const events: PiEvent[] = [];
  for await (const event of readEvents(chunks)) events.push(event);
  return events;
}

/** The events one stream yields, with the whole text handed over in one chunk. */
function eventsOf(text: string): Promise<readonly PiEvent[]> {
  return collect(textChunks(text, Math.max(text.length, 1)));
}

/** The events of one type, as that type. */
function only<T extends PiEvent["type"]>(
  events: readonly PiEvent[],
  type: T,
): readonly Extract<PiEvent, { readonly type: T }>[] {
  const found: Extract<PiEvent, { readonly type: T }>[] = [];
  for (const event of events) {
    if (event.type === type) found.push(event as Extract<PiEvent, { readonly type: T }>);
  }
  return found;
}

function reasonsOf(events: readonly PiEvent[]): readonly string[] {
  return only(events, "unreadable").map((event) => event.reason);
}

function typesOf(events: readonly PiEvent[]): readonly string[] {
  return events.map((event) => event.type);
}

test("the recorded run carries every event type a clean run emits", () => {
  const types = new Set(recordedLines().map((line) => (JSON.parse(line) as { type: string }).type));
  assert.deepEqual(
    [...types].sort(),
    cleanRunTypes,
    "the capture is missing a type the reader has to cope with, so it proves less than it looks",
  );
});

test("the recorded run carries every delta a message_update can carry", () => {
  const types = new Set<string>();
  for (const line of recordedLines()) {
    const event = JSON.parse(line) as { type: string; assistantMessageEvent?: { type: string } };
    if (event.type === "message_update" && event.assistantMessageEvent !== undefined) {
      types.add(event.assistantMessageEvent.type);
    }
  }
  assert.deepEqual(
    [...types].sort(),
    updateTypes,
    "a short run need not think, and a capture with no thinking_end is missing the message_update that repeats a whole block",
  );
});

test("the recorded run is a review rather than a run that never reached the model", () => {
  const stopReasons = recordedLines()
    .map((line) => JSON.parse(line) as { type: string; message?: { stopReason?: string } })
    .filter((event) => event.type === "message_end")
    .map((event) => event.message?.stopReason);
  assert.ok(
    stopReasons.includes("stop"),
    "no message stopped at stop, which is what a run that failed inside the stream looks like from outside",
  );
});

test("the recorded run's largest line is the agent_end the reader must not hold", () => {
  const longest = recordedLines().reduce((a, b) => (a.length >= b.length ? a : b));
  assert.equal((JSON.parse(longest) as { type: string }).type, "agent_end");
});

test("the recorded run yields the events its consumers asked for and nothing else", async () => {
  const events = await collect(createReadStream(recordedRun));
  assert.deepEqual(reasonsOf(events), []);
  assert.deepEqual(typesOf(events), [
    "message_end",
    "message_end",
    "tool_execution_start",
    "tool_execution_end",
    "message_end",
    "message_end",
  ]);
});

test("only the assistant messages of the recorded run carry usage", async () => {
  const ends = only(await collect(createReadStream(recordedRun)), "message_end");
  assert.deepEqual(
    ends.map((end) => [end.message.role, end.message.usage !== undefined]),
    [
      ["user", false],
      ["assistant", true],
      ["toolResult", false],
      ["assistant", true],
    ],
    "message_end fires for the user message and for every toolResult message, and neither carries a usage key",
  );
});

test("the recorded run's costs come through as pi priced them", async () => {
  const ends = only(await collect(createReadStream(recordedRun)), "message_end");
  assert.deepEqual(
    ends.map((end) => end.message.usage?.cost.total).filter((cost) => cost !== undefined),
    [0.00042609600000000005, 0.0027483280000000004],
  );
});

test("the recorded run's tool execution carries the call, the tool and the error flag", async () => {
  const events = await collect(createReadStream(recordedRun));
  const started = only(events, "tool_execution_start")[0];
  const ended = only(events, "tool_execution_end")[0];
  assert.equal(started?.toolName, "read");
  assert.deepEqual(started?.args, { path: "src/github/pull-request.ts" });
  assert.equal(ended?.toolName, "read");
  assert.equal(ended?.isError, false);
  assert.equal(ended?.toolCallId, started?.toolCallId);
});

test("the recorded run reads the same however the chunks fall", async () => {
  const text = readFileSync(recordedRun, "utf8");
  const whole = await eventsOf(text);
  for (const size of [1, 7, 4096]) {
    const events = await collect(textChunks(text, size));
    assert.deepEqual(events, whole, `chunks of ${size} characters read differently`);
  }
  assert.deepEqual(await collect(byteChunks(text, 1)), whole, "a byte at a time reads differently");
});

test("a line no consumer wants is dropped without being parsed", async () => {
  // Every body below is unparseable, so an event here is a line that was parsed.
  const unwanted = [
    "agent_end",
    "agent_start",
    "agent_settled",
    "message_start",
    "message_update",
    "turn_start",
    "turn_end",
    "session",
    "auto_retry_start",
    "auto_retry_end",
    "an_event_pi_does_not_emit_yet",
  ];
  const stream = unwanted.map((type) => `{"type":"${type}", this is not JSON\n`).join("");
  assert.deepEqual(await eventsOf(stream), []);
});

test("agent_end is dropped however many times the stream carries it", async () => {
  // pi restarts the agent on a failed request, and every attempt emits its own.
  const transcript = `{"type":"agent_end","messages":"${"m".repeat(200_000)}"}\n`;
  const events = await eventsOf(`${transcript.repeat(22)}${messageEnd("assistant")}\n`);
  assert.deepEqual(typesOf(events), ["message_end"]);
});

test("a line that is not JSON is reported, and the stream carries on", async () => {
  const events = await eventsOf(`pi wrote a warning\n${messageEnd("assistant")}\nand another\n`);
  assert.deepEqual(typesOf(events), ["unreadable", "message_end", "unreadable"]);
});

test("a wanted line whose JSON is truncated is reported rather than thrown", async () => {
  const events = await eventsOf(`{"type":"message_end","message":{"role":"assis\n`);
  assert.match(reasonsOf(events)[0] ?? "", /not JSON/);
});

test("a type name longer than any pi emits is dropped rather than buffered", async () => {
  const events = await eventsOf(`{"type":"${"a".repeat(500_000)}"}\n`);
  assert.equal(events.length, 1);
  assert.match(reasonsOf(events)[0] ?? "", /does not begin with an event type/);
});

test("a reason quotes a bounded piece of the line however long the line is", async () => {
  const events = await eventsOf(`${"z".repeat(500_000)}\n`);
  const reason = reasonsOf(events)[0] ?? "";
  assert.equal(events.length, 1);
  assert.ok(reason.length < 200, `a reason carried ${reason.length} characters`);
});

test("an event missing a field it must carry is reported rather than read as empty", async () => {
  const cases: readonly (readonly [string, RegExp])[] = [
    [`{"type":"message_end","messages":[]}`, /message_end/],
    [`{"type":"message_end","message":{"content":[]}}`, /message_end/],
    [`{"type":"message_end","message":{"role":"assistant"}}`, /message_end/],
    [`{"type":"tool_execution_start","toolName":"read"}`, /tool_execution_start/],
    [`{"type":"tool_execution_end","toolCallId":"c1","toolName":"read"}`, /tool_execution_end/],
  ];
  for (const [line, expected] of cases) {
    const events = await eventsOf(`${line}\n`);
    assert.equal(events.length, 1, `${line} yielded ${events.length} events`);
    assert.match(reasonsOf(events)[0] ?? "", expected);
  }
});

test("a line carrying a second type is reported rather than read as the first", async () => {
  const events = await eventsOf(`{"type":"message_end","type":"agent_end","messages":[]}\n`);
  assert.equal(events.length, 1);
  assert.match(reasonsOf(events)[0] ?? "", /second type/);
});

test("a usage field pi renamed is reported rather than summed as nothing", async () => {
  const renamed = messageEnd("assistant").replace('"totalTokens"', '"tokensTotal"');
  assert.match(reasonsOf(await eventsOf(`${renamed}\n`))[0] ?? "", /message_end/);
});

test("a message whose role pi has never used is carried rather than refused", async () => {
  const ends = only(await eventsOf(`${messageEnd("somethingNew")}\n`), "message_end");
  assert.equal(ends[0]?.message.role, "somethingNew");
});

test("a last line with no newline after it is still read", async () => {
  assert.deepEqual(typesOf(await eventsOf(messageEnd("assistant"))), ["message_end"]);
});

test("the newline that ends the stream is not read as a line", async () => {
  assert.deepEqual(await eventsOf(""), []);
  assert.deepEqual(await eventsOf(`{"type":"agent_settled"}\n`), []);
});

test("a character split across two chunks survives the split", async () => {
  const text = `${messageEnd("assistant", "the reviewer said — nothing")}\n`;
  const ends = only(await collect(byteChunks(text, 1)), "message_end");
  assert.equal(ends[0]?.message.content[0]?.["text"], "the reviewer said — nothing");
});

/**
 * The heap while a stream is read, at two lengths of the same stream.
 *
 * One length proves nothing: a reader that holds every line reports whatever
 * that length costs and looks flat next to itself. Two lengths ten times apart
 * separate a reader that holds one line from one that holds the stream, and the
 * accumulating control is what says the separation is real rather than noise.
 */
test("memory does not grow with the stream's length", { timeout: 600_000 }, async () => {
  const short = await heapOver(16, read);
  const long = await heapOver(160, read);
  const controlShort = await heapOver(16, hold);
  const controlLong = await heapOver(160, hold);

  const streamed = long.bytes - short.bytes;
  // The peak bound is the looser of the two because a peak tracks when the
  // collector ran as much as what was live, and a longer stream makes more
  // garbage between collections. It is kept because it is the one that catches
  // a reader that buffers a single enormous line: that spikes the peak and
  // leaves the settled heap as clean as a reader that holds nothing.
  const peakBound = streamed / 4;
  const settledBound = streamed / 16;

  const grew = { peak: long.peak - short.peak, settled: long.settled - short.settled };
  const control = {
    peak: controlLong.peak - controlShort.peak,
    settled: controlLong.settled - controlShort.settled,
  };

  assert.ok(
    control.peak > peakBound && control.settled > settledBound,
    `a reader that holds every line grew by ${megabytes(control.peak)} at the peak and ${megabytes(control.settled)} settled over ${megabytes(streamed)} more stream, which these bounds do not catch`,
  );
  assert.ok(
    grew.peak < peakBound,
    `peak heap grew by ${megabytes(grew.peak)} over ${megabytes(streamed)} more stream, against ${megabytes(control.peak)} for a reader that holds every line`,
  );
  assert.ok(
    grew.settled < settledBound,
    `the settled heap grew by ${megabytes(grew.settled)} over ${megabytes(streamed)} more stream, against ${megabytes(control.settled)} for a reader that holds every line`,
  );
});

function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)}MB`;
}

type Heap = {
  readonly bytes: number;
  readonly peak: number;
  /**
   * The lowest reading of the run's second half, which is the heap with that
   * moment's garbage collected. A reader holding the stream cannot dip to it.
   */
  readonly settled: number;
};

type Reader = (chunks: AsyncIterable<string>, sample: () => void) => Promise<void>;

/** What this module does: read the events and keep none of them. */
const read: Reader = async (chunks, sample) => {
  for await (const event of readEvents(chunks)) {
    if (event.type === "unreadable") throw new Error(event.reason);
    sample();
  }
};

/** What it must not do: hold every line the stream carried. */
const hold: Reader = async (chunks, sample) => {
  const lines: string[] = [];
  let pending = "";
  for await (const chunk of chunks) {
    pending += chunk;
    const parts = pending.split("\n");
    pending = parts.pop() ?? "";
    lines.push(...parts);
    sample();
  }
  assert.ok(lines.length > 0);
};

async function heapOver(cycles: number, reader: Reader): Promise<Heap> {
  const readings: number[] = [];
  let bytes = 0;
  const sample = (): void => {
    readings.push(process.memoryUsage().heapUsed);
  };

  const counted = async function* (): AsyncGenerator<string> {
    for await (const chunk of chunksOf(run(cycles), 64 * 1024)) {
      bytes += chunk.length;
      sample();
      yield chunk;
    }
  };

  await reader(counted(), sample);
  return {
    bytes,
    peak: Math.max(...readings),
    settled: Math.min(...readings.slice(Math.floor(readings.length / 2))),
  };
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
 * A stream shaped like a real round's, at whatever length is asked for.
 *
 * The proportions are the measured ones: `message_update` is 99.3% of the lines
 * and about 85% of the bytes, the block a `thinking_end` or a `text_end` repeats
 * is a hundred times a delta, and `agent_end` is one line worth thousands of
 * them. `pi` emits an `agent_end` per attempt at the request, so this emits
 * several.
 */
function* run(cycles: number): Generator<string> {
  yield line({ type: "session", version: 3, id: "01a0", cwd: "/tmp/tree" });
  yield line({ type: "agent_start" });
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    yield* turn(cycle);
    if (cycle % 8 === 7) {
      yield line({ type: "agent_end", messages: transcript, willRetry: true });
      yield line({ type: "agent_start" });
    }
  }
  yield line({ type: "agent_end", messages: transcript, willRetry: false });
  yield line({ type: "agent_settled" });
}

function* turn(cycle: number): Generator<string> {
  const delta = line({
    type: "message_update",
    usage: emptyUsage,
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: ` step ${cycle} ` },
  });
  yield line({ type: "turn_start" });
  yield line({ type: "message_start", message: { role: "assistant", content: [], usage } });
  for (let at = 0; at < 1136; at += 1) yield delta;
  yield line({
    type: "message_update",
    usage,
    assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: block },
  });
  yield line({
    type: "message_update",
    usage,
    assistantMessageEvent: { type: "text_end", contentIndex: 1, content: block },
  });
  yield `${messageEnd("assistant", block)}\n`;
  yield line({
    type: "tool_execution_start",
    toolCallId: `call_${cycle}`,
    toolName: "read",
    args: { path: "src/github/pull-request.ts" },
  });
  yield line({
    type: "tool_execution_end",
    toolCallId: `call_${cycle}`,
    toolName: "read",
    result: { content: [{ type: "text", text: toolResult }] },
    isError: false,
  });
  yield line({ type: "message_start", message: { role: "toolResult", content: [] } });
  yield `${messageEnd("toolResult", toolResult)}\n`;
  // turn_end repeats the turn's last assistant message, cost included.
  yield line({
    type: "turn_end",
    message: { role: "assistant", content: [{ type: "text", text: block }], usage },
  });
}

function line(event: Record<string, unknown>): string {
  return `${JSON.stringify(event)}\n`;
}

/** A `message_end` line, without the newline the stream would put after it. */
function messageEnd(role: string, text = "no"): string {
  return JSON.stringify({
    type: "message_end",
    message: {
      role,
      content: [{ type: "text", text }],
      model: "deepseek-v4-pro",
      usage: role === "assistant" ? usage : undefined,
      stopReason: role === "assistant" ? "stop" : undefined,
    },
  });
}

const usage = {
  input: 1740,
  output: 87,
  cacheRead: 2432,
  cacheWrite: 0,
  reasoning: 53,
  totalTokens: 4259,
  cost: {
    input: 0.0022968,
    output: 0.00034452,
    cacheRead: 0.000107008,
    cacheWrite: 0,
    total: 0.002748328,
  },
};

const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** The content block a `thinking_end` or a `text_end` repeats whole. */
const block = "the reviewer thought about it. ".repeat(800);

/** What a read of one file hands back. */
const toolResult = "a line of the file under review\n".repeat(230);

/** The whole conversation, which is what makes `agent_end` the largest line. */
const transcript = Array.from({ length: 12 }, () => ({
  role: "assistant",
  content: [{ type: "text", text: block }],
  usage,
}));
