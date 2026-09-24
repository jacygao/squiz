import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { type RoundCost, unspent } from "../adapter.ts";
import { costWith } from "./cost.ts";
import { type PiEvent, readEvents } from "./stream.ts";

/** One short `pi` run, committed as it was emitted, and what it really cost. */
const recordedRun = new URL("./recorded-run.jsonl", import.meta.url);
const firstMessage = { dollars: 0.00042609600000000005, tokens: 2438 };
const recordedCost: RoundCost = { dollars: 0.0031744240000000003, tokens: 6697, messages: 2 };

test("the recorded run costs the sum of its assistant messages", async () => {
  assert.deepEqual(await costOfText(readFileSync(recordedRun, "utf8")), recordedCost);
});

test("every assistant message is summed, not the last one alone", async () => {
  const round = [
    assistant({ dollars: 0.0012, tokens: 100 }, "toolUse"),
    toolResult(),
    assistant({ dollars: 0.0034, tokens: 200 }, "toolUse"),
    toolResult(),
    assistant({ dollars: 0.0056, tokens: 300 }),
  ].join("");
  assert.deepEqual(await costOfText(round), { dollars: 0.0102, tokens: 600, messages: 3 });
});

test("turn_end is not counted, though it repeats the cost of the message before it", async () => {
  const spend = { dollars: 0.0012, tokens: 100 };
  const round = `${assistant(spend)}${turnEnd(spend)}`;
  assert.deepEqual(await costOfText(round), { dollars: 0.0012, tokens: 100, messages: 1 });
});

test("agent_end is not read, though it carries the cost of every message", async () => {
  const spends = [
    { dollars: 0.0012, tokens: 100 },
    { dollars: 0.0034, tokens: 200 },
  ];
  const round = `${spends.map((spend) => assistant(spend)).join("")}${agentEnd(spends)}`;
  assert.deepEqual(await costOfText(round), { dollars: 0.0046, tokens: 300, messages: 2 });
});

test("the prompt and the tool results are not counted", async () => {
  const round = `${userPrompt()}${toolResult()}${toolResult()}`;
  assert.deepEqual(await costOfText(round), unspent);
});

test("a model the price catalogue does not cover reports its tokens against no dollars", async () => {
  const unpriced = [
    assistant({ dollars: 0, tokens: 2438 }, "toolUse"),
    assistant({ dollars: 0, tokens: 4259 }),
  ].join("");
  assert.deepEqual(
    await costOfText(unpriced),
    { dollars: 0, tokens: 6697, messages: 2 },
    "a round that spent 6,697 tokens came back indistinguishable from one that cost nothing",
  );
});

test("a round killed before its first assistant message completed reports no message at all", async () => {
  const killed = `${session()}${userPrompt()}${messageStart()}`;
  assert.deepEqual(await costOfText(killed), unspent);
});

test("a provider that never ran reports zero against zero, with the message it emitted", async () => {
  const failed = assistant({ dollars: 0, tokens: 0 }, "error", "no key for provider deepseek");
  assert.deepEqual(await costOfText(failed), { dollars: 0, tokens: 0, messages: 1 });
});

test("the three rounds that cost no dollars come back as three different totals", async () => {
  const unpriced = await costOfText(assistant({ dollars: 0, tokens: 2438 }));
  const killedEarly = await costOfText(`${session()}${messageStart()}`);
  const neverRan = await costOfText(
    assistant({ dollars: 0, tokens: 0 }, "error", "no key for provider deepseek"),
  );
  assert.notDeepEqual(unpriced, killedEarly);
  assert.notDeepEqual(unpriced, neverRan);
  assert.notDeepEqual(killedEarly, neverRan);
});

test("an errored message among the working ones leaves the sum to the working ones", async () => {
  const retried = [
    assistant({ dollars: 0, tokens: 0 }, "error", "the provider returned 503"),
    assistant({ dollars: 0.0012, tokens: 100 }, "toolUse"),
    assistant({ dollars: 0, tokens: 0 }, "error", "the provider returned 503"),
    assistant({ dollars: 0.0034, tokens: 200 }),
  ].join("");
  assert.deepEqual(await costOfText(retried), { dollars: 0.0046, tokens: 300, messages: 4 });
});

test("a round killed while a message was in flight reports the messages that completed", async () => {
  const lines = recordedLines();
  const at = lines.findLastIndex(isAssistantMessageEnd);
  // The kill lands mid-line, which is what SIGTERM does to a stream pi is writing.
  const killed = `${lines.slice(0, at).join("\n")}\n${lines[at]?.slice(0, 64) ?? ""}`;

  assert.deepEqual(await costOfText(killed), { ...firstMessage, messages: 1 });
  assert.ok(
    (await eventsOf(killed)).some((event) => event.type === "unreadable"),
    "the run was cut somewhere the reader could absorb, so this proves nothing about a kill",
  );
});

test("a message the reader could not read is left out rather than summed as nothing", () => {
  const unreadable: PiEvent = { type: "unreadable", reason: "a line is not JSON: {" };
  assert.deepEqual(costWith(recordedCost, unreadable), recordedCost);
});

test("the tool events a round reports progress from leave the cost alone", () => {
  const started: PiEvent = {
    type: "tool_execution_start",
    toolCallId: "call_0",
    toolName: "read",
    args: { path: "src/github/pull-request.ts" },
  };
  const ended: PiEvent = {
    type: "tool_execution_end",
    toolCallId: "call_0",
    toolName: "read",
    isError: false,
  };
  assert.deepEqual([started, ended].reduce(costWith, recordedCost), recordedCost);
});

test("a total is carried forward event by event, for a caller reading the stream once", async () => {
  let running = unspent;
  for await (const event of readEvents(oneChunk(readFileSync(recordedRun, "utf8")))) {
    running = costWith(running, event);
  }
  assert.deepEqual(running, recordedCost);
});

function recordedLines(): readonly string[] {
  return readFileSync(recordedRun, "utf8").split("\n").slice(0, -1);
}

function isAssistantMessageEnd(line: string): boolean {
  const event = JSON.parse(line) as { type: string; message?: { role?: string } };
  return event.type === "message_end" && event.message?.role === "assistant";
}

async function* oneChunk(text: string): AsyncGenerator<string> {
  yield text;
}

/** The round's cost, folded over the stream the way one pass over it does. */
async function costOfText(text: string): Promise<RoundCost> {
  let total = unspent;
  for await (const event of readEvents(oneChunk(text))) total = costWith(total, event);
  return total;
}

async function eventsOf(text: string): Promise<readonly PiEvent[]> {
  const events: PiEvent[] = [];
  for await (const event of readEvents(oneChunk(text))) events.push(event);
  return events;
}

/** What one message spent, as the two figures a round is summed from. */
type Spend = { readonly dollars: number; readonly tokens: number };

function assistant(spend: Spend, stopReason = "stop", errorMessage?: string): string {
  return line({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "the reviewer read a file" }],
      model: "deepseek-v4-pro",
      stopReason,
      ...(errorMessage === undefined ? {} : { errorMessage }),
      usage: usageOf(spend),
    },
  });
}

/** The `message_end` for the prompt. It carries no usage key at all. */
function userPrompt(): string {
  return line({
    type: "message_end",
    message: { role: "user", content: [{ type: "text", text: "review this change" }] },
  });
}

/** The `message_end` for a tool's answer. It carries no usage key either. */
function toolResult(): string {
  return line({
    type: "message_end",
    message: { role: "toolResult", content: [{ type: "text", text: "a line of the file" }] },
  });
}

/** The turn's last assistant message, repeated cost and all. */
function turnEnd(spend: Spend): string {
  return line({
    type: "turn_end",
    message: { role: "assistant", content: [], usage: usageOf(spend) },
  });
}

/** The whole transcript, each message with the usage it was priced at. */
function agentEnd(spends: readonly Spend[]): string {
  return line({
    type: "agent_end",
    messages: spends.map((spend) => ({ role: "assistant", content: [], usage: usageOf(spend) })),
    willRetry: false,
  });
}

function session(): string {
  return line({ type: "session", version: 3, id: "01a0", cwd: "/tmp/tree" });
}

/** A message that has begun. A kill between this and its `message_end` recovers nothing of it. */
function messageStart(): string {
  return line({ type: "message_start", message: { role: "assistant", content: [] } });
}

function usageOf(spend: Spend): Record<string, unknown> {
  return {
    input: spend.tokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: spend.tokens,
    cost: {
      input: spend.dollars,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: spend.dollars,
    },
  };
}

function line(event: Record<string, unknown>): string {
  return `${JSON.stringify(event)}\n`;
}
