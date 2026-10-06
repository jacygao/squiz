import assert from "node:assert/strict";
import { test } from "node:test";

import { type ParsedRun, type RoundProgress } from "../adapter.ts";
import { REPORT_FINDING, REPORT_VERDICT } from "../reporting.ts";
import { readReports } from "./reports.ts";

const finding = {
  scope: "line",
  file: "src/add.ts",
  line: 2,
  severity: "high",
  headline: "add subtracts",
  reasoning: ["It returns a - b."],
  suggestedFix: "Return a + b.",
};

const reported = JSON.stringify({ type: "report", call: REPORT_FINDING, value: finding });
const ruled = JSON.stringify({ type: "report", call: REPORT_VERDICT, value: { thread: "PRRT_1", verdict: "fixed" } });
const finished = JSON.stringify({ type: "finish" });

/** The usage line the shell appends, as Copilot writes the file: two models, and AI credits. */
const usage = JSON.stringify({
  type: "usage",
  usage: {
    totalPremiumRequestCost: 0,
    totalNanoAiu: 535_970_000,
    modelMetrics: {
      "gpt-5-mini": {
        requests: { count: 5, cost: 0 },
        usage: { inputTokens: 60_586, outputTokens: 521, cacheReadTokens: 48_128, cacheWriteTokens: 0, reasoningTokens: 64 },
      },
      "claude-haiku-4.5": {
        requests: { count: 2, cost: 0.33 },
        usage: { inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      },
    },
  },
});

/** A plan that reports requests and no tokens. */
const tokenless = JSON.stringify({
  type: "usage",
  usage: { totalNanoAiu: 100_000_000, modelMetrics: { "gpt-5-mini": { requests: { count: 3, cost: 0 } } } },
});

/** What a run that reached no model writes: no model at all. */
const modelless = JSON.stringify({ type: "usage", usage: { totalNanoAiu: 0, modelMetrics: {} } });

async function* chunks(...parts: readonly (string | Uint8Array)[]): AsyncGenerator<string | Uint8Array> {
  for (const part of parts) yield part;
}

function read(...lines: readonly string[]): Promise<ParsedRun> {
  return readReports(chunks(lines.map((line) => `${line}\n`).join("")));
}

test("a finish is a review, and its cost is the usage line's tokens, requests and AI credits", async () => {
  const run = await read(reported, ruled, finished, usage);
  assert.deepEqual(run.result, {
    kind: "reviewed",
    findings: [finding],
    verdicts: [{ thread: "PRRT_1", verdict: "fixed" }],
  });
  assert.deepEqual(run.cost, { dollars: 0, tokens: 60_586 + 521 + 1_000 + 200, messages: 7, credits: 0.53597 });
});

test("a finish with no usage line is still a review, with no cost", async () => {
  const run = await read(reported, finished);
  assert.equal(run.result.kind, "reviewed");
  assert.equal(run.cost, undefined);
});

test("no finish, and a usage line counting a request, is a review that stopped without finishing", async () => {
  const run = await read(reported, usage);
  assert.deepEqual(run.result, {
    kind: "unparsed",
    reason: "the reviewer reported 1 finding and 0 verdicts and did not finish its review",
  });
  assert.equal(run.cost?.tokens, 62_307);
});

test("no finish and no usage line is a run that completed no message", async () => {
  assert.deepEqual((await read()).result, { kind: "incomplete", reason: "the reviewer completed no message" });
  assert.equal((await read()).cost, undefined);
});

test("no finish, and a usage line counting no request, is a run that completed no message", async () => {
  const run = await read(modelless);
  assert.deepEqual(run.result, { kind: "incomplete", reason: "the reviewer completed no message" });
  assert.equal(run.cost, undefined);
});

test("a usage line with no token counts gives no cost, and its requests still say a message completed", async () => {
  const run = await read(tokenless);
  assert.equal(run.cost, undefined, "a plan reporting no tokens recorded a cost");
  assert.equal(run.result.kind, "unparsed");
  assert.equal((await read(finished, tokenless)).cost, undefined);
});

test("a usage line one model of which carries no token counts gives no cost", async () => {
  const parsed = JSON.parse(usage) as { usage: { modelMetrics: Record<string, { usage?: unknown }> } };
  delete parsed.usage.modelMetrics["claude-haiku-4.5"]?.usage;
  const run = await read(finished, JSON.stringify(parsed));
  assert.equal(run.result.kind, "reviewed");
  assert.equal(run.cost, undefined);
});

test("a line that cannot be read fails the run, finish or not", async () => {
  const run = await read(reported, "not json", finished, usage);
  assert.equal(run.result.kind, "unparsed");
  assert.match(run.result.kind === "unparsed" ? run.result.reason : "", /line 2 .*not JSON/u);
});

// The shell appends `{"type":"usage","usage":}` where it is handed an empty file.
test("a usage line that carries no usage fails the run", async () => {
  const run = await read(finished, '{"type":"usage","usage":}');
  assert.equal(run.result.kind, "unparsed");
});

test("a second usage line fails the run", async () => {
  const run = await read(finished, usage, usage);
  assert.equal(run.result.kind, "unparsed");
  assert.match(run.result.kind === "unparsed" ? run.result.reason : "", /second usage line/u);
});

test("a line of a kind pi's extension writes and the server never does fails the run", async () => {
  const run = await read(finished, JSON.stringify({ type: "unfinished" }));
  assert.equal(run.result.kind, "unparsed");
});

test("a refusal the call itself made is not counted, and one that stopped a call is", async () => {
  const progress: RoundProgress[] = [];
  const refusedReport = JSON.stringify({ type: "refused", call: REPORT_FINDING, reason: "no headline", stopped: false });
  const stoppedCall = JSON.stringify({ type: "refused", call: "shell", reason: "denied", stopped: true });
  await readReports(chunks(`${refusedReport}\n${stoppedCall}\n${finished}\n`), (each) => progress.push(each));
  assert.equal(progress.at(-1)?.refusals, 1);
});

test("the caller is told after each line, the cost arriving with the usage line", async () => {
  const progress: RoundProgress[] = [];
  const text = `${reported}\n${finished}\n${usage}\n`;
  const bytes = new TextEncoder().encode(text);
  // Split partway through a line.
  await readReports(chunks(bytes.slice(0, 40), bytes.slice(40, 41), bytes.slice(41)), (each) => progress.push(each));
  assert.equal(progress.length, 3);
  assert.deepEqual(progress[0]?.findings, [finding]);
  assert.equal(progress[1]?.cost, undefined);
  assert.equal(progress[1]?.finished, true);
  assert.equal(progress[2]?.cost?.tokens, 62_307);
});

test("a last line with no newline fails the run", async () => {
  const run = await readReports(chunks(`${reported}\n${finished}`));
  assert.equal(run.result.kind, "unparsed");
});
