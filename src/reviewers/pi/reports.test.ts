import assert from "node:assert/strict";
import { test } from "node:test";

import type { ParsedRun, RoundProgress } from "../adapter.ts";
import type { Line } from "../report-file.ts";
import { REPORT_FINDING, REPORT_VERDICT } from "../reporting.ts";
import { readReports } from "./reports.ts";

const finding = {
  scope: "line",
  file: "src/github/gh.ts",
  line: 42,
  severity: "high",
  headline: "The exit status is read before the process has exited",
  reasoning: ["`exitCode` is null until the process ends."],
  suggestedFix: "Await the exit event.",
};

const verdict = { thread: "PRRT_kwDO", verdict: "fixed" };

/** One assistant message's line, priced at `dollars` against 100 tokens. */
function usage(stopReason: string, dollars: number, errorMessage?: string): Line {
  return {
    type: "usage",
    stopReason,
    ...(errorMessage === undefined ? {} : { errorMessage }),
    model: "stand-in",
    usage: {
      input: dollars === 0 ? 0 : 100,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: dollars === 0 ? 0 : 100,
      cost: { input: dollars, output: 0, cacheRead: 0, cacheWrite: 0, total: dollars },
    },
  };
}

const findingLine: Line = { type: "report", call: REPORT_FINDING, value: finding };
const verdictLine: Line = { type: "report", call: REPORT_VERDICT, value: verdict };
const finish: Line = { type: "finish" };

/** The file as the extension writes it: one JSON line each, newline included. */
function fileOf(...lines: readonly Line[]): string {
  return lines.map((line) => `${JSON.stringify(line)}\n`).join("");
}

async function* chunksOf(...chunks: readonly (string | Uint8Array)[]): AsyncGenerator<string | Uint8Array> {
  for (const chunk of chunks) yield chunk;
}

/** The file read in one chunk, with every progress the reader told. */
async function read(...chunks: readonly (string | Uint8Array)[]): Promise<{
  readonly run: ParsedRun;
  readonly told: readonly RoundProgress[];
}> {
  const told: RoundProgress[] = [];
  const run = await readReports(chunksOf(...chunks), (progress) => told.push(progress));
  return { run, told };
}

const reviewed = fileOf(usage("toolUse", 0.002), findingLine, verdictLine, finish, usage("stop", 0.001));

test("a finished review comes back with its findings, its verdicts and its cost", async () => {
  const { run } = await read(reviewed);
  assert.deepEqual(run, {
    cost: { dollars: 0.003, tokens: 200, messages: 2 },
    result: { kind: "reviewed", findings: [finding], verdicts: [verdict] },
  });
});

test("a review that reported nothing and finished is an empty review rather than a failure", async () => {
  const { run } = await read(fileOf(usage("toolUse", 0.002), finish, usage("stop", 0.001)));
  assert.deepEqual(run.result, { kind: "reviewed", findings: [], verdicts: [] });
});

/** An empty file is a reviewer that reported nothing at all, never a clean review. */
test("a file with nothing in it is a run that completed nothing, not an empty review", async () => {
  const { run } = await read();
  assert.deepEqual(run, {
    cost: { dollars: 0, tokens: 0, messages: 0 },
    result: { kind: "incomplete", reason: "the reviewer completed no message" },
  });
});

test("a run with no message that stopped and no finish reports the errored message's reason", async () => {
  const { run } = await read(fileOf(usage("error", 0, "503 from the provider"), usage("error", 0, "no credential")));
  assert.deepEqual(run.result, { kind: "incomplete", reason: "no credential" });
  assert.equal(run.cost?.messages, 2, "an errored message is a message, carrying zero usage");
});

test("errored messages among the working ones leave the run reviewed", async () => {
  const { run } = await read(fileOf(usage("error", 0, "503"), usage("toolUse", 0.002), finish, usage("stop", 0.001)));
  assert.equal(run.result.kind, "reviewed");
});

/** The declaration is read before any stop reason. */
test("a finished review is a review though no message stopped for an answer", async () => {
  const { run } = await read(fileOf(usage("toolUse", 0.002), findingLine, finish, usage("error", 0, "gone")));
  assert.deepEqual(run.result, { kind: "reviewed", findings: [finding], verdicts: [] });
});

test("a reviewer that stopped without finishing names how much it got through", async () => {
  const { run } = await read(fileOf(usage("toolUse", 0.002), findingLine, usage("stop", 0.001)));
  assert.deepEqual(run.result, {
    kind: "unparsed",
    reason: "the reviewer reported 1 finding and 0 verdicts and did not finish its review",
  });
});

/** The line the extension appends when the agent settles with no finish. */
test("an unfinished end is a review that was never finished, not a line that cannot be read", async () => {
  const { run, told } = await read(fileOf(usage("stop", 0.001), { type: "unfinished" }));
  assert.deepEqual(run.result, {
    kind: "unparsed",
    reason: "the reviewer reported nothing and did not finish its review",
  });
  assert.equal(told.at(-1)?.broken, undefined);
});

test("the findings come back in order, and a second ruling on one thread leaves the first", async () => {
  const second = { ...finding, line: 43 };
  const { run } = await read(
    fileOf(
      usage("toolUse", 0.002),
      findingLine,
      { type: "report", call: REPORT_FINDING, value: second },
      verdictLine,
      { type: "report", call: REPORT_VERDICT, value: { thread: verdict.thread, verdict: "open", reason: "Still there." } },
      finish,
    ),
  );
  assert.deepEqual(run.result, { kind: "reviewed", findings: [finding, second], verdicts: [verdict] });
});

test("a call stopped before it ran is counted, and a report the call refused is not", async () => {
  const { told } = await read(
    fileOf(
      usage("toolUse", 0.002),
      { type: "refused", call: "bash", reason: "squiz refused this call: no", stopped: true },
      { type: "refused", call: REPORT_FINDING, reason: "the finding names no file", stopped: false },
      finish,
    ),
  );
  assert.equal(told.at(-1)?.refusals, 1);
});

/**
 * A line that cannot be read fails the round, declaration or not, and the
 * reports read before and after it stand.
 */
test("a line that is not JSON fails a finished review, and the reports around it stand", async () => {
  const after = { ...finding, line: 50 };
  const { run, told } = await read(
    fileOf(usage("toolUse", 0.002), findingLine) +
      "{not json\n" +
      fileOf({ type: "report", call: REPORT_FINDING, value: after }, finish, usage("stop", 0.001)),
  );
  assert.equal(run.result.kind, "unparsed");
  assert.match(run.result.kind === "unparsed" ? run.result.reason : "", /line 3 of the report file could not be read/u);
  assert.deepEqual(told.at(-1)?.findings, [finding, after]);
  assert.equal(told.at(-1)?.finished, true);
  assert.match(told.at(-1)?.broken ?? "", /line 3/u, "the caller stopped at the bound is told too");
});

test("a line of a type the reader does not know fails the review", async () => {
  const { run } = await read(fileOf(usage("toolUse", 0.002), finish) + '{"type":"verdict"}\n');
  assert.equal(run.result.kind, "unparsed");
  assert.match(run.result.kind === "unparsed" ? run.result.reason : "", /verdict/u);
});

test("a report the call accepted and that cannot be read back fails the review", async () => {
  const { run } = await read(
    fileOf({ type: "report", call: REPORT_FINDING, value: { ...finding, severity: "critical" } }, finish),
  );
  assert.equal(run.result.kind, "unparsed");
  assert.match(run.result.kind === "unparsed" ? run.result.reason : "", /a finding the reviewer reported/u);
});

/** A usage field `pi` renamed is the loud version of a round that silently cost nothing. */
test("usage the reader cannot read fails the review rather than summing as nothing", async () => {
  const renamed = { type: "usage", stopReason: "stop", usage: { input: 1, output: 0, total: 1 } };
  const { run } = await read(fileOf(finish) + `${JSON.stringify(renamed)}\n`);
  assert.equal(run.result.kind, "unparsed");
});

test("an assistant message carrying no usage is left out of what the cost covers", async () => {
  const { run } = await read(fileOf({ type: "usage", stopReason: "toolUse" }, finish, usage("stop", 0.001)));
  assert.deepEqual(run.cost, { dollars: 0.001, tokens: 100, messages: 1 });
});

/** The file is read as it grows, so a read can end partway through a line. */
test("a line split across reads is read once it is whole", async () => {
  const text = fileOf(usage("toolUse", 0.002), { ...findingLine, value: { ...finding, headline: "Ünïcode — split" } }, finish, usage("stop", 0.001));
  const bytes = new TextEncoder().encode(text);
  const at = text.indexOf("Ü") + 1;
  const { run, told } = await read(bytes.subarray(0, at), bytes.subarray(at, at + 7), bytes.subarray(at + 7));
  assert.equal(run.result.kind, "reviewed");
  assert.equal(run.result.kind === "reviewed" ? run.result.findings[0]?.headline : "", "Ünïcode — split");
  assert.ok(
    told.every((progress) => progress.broken === undefined),
    "a part of a line still being written was read as a line",
  );
});

/** At the end of the run there is no more of it coming. */
test("a last line with no newline after it cannot be read, and the reports before it stand", async () => {
  const { run, told } = await read(fileOf(usage("toolUse", 0.002), findingLine) + JSON.stringify(finish));
  assert.equal(run.result.kind, "unparsed");
  assert.match(run.result.kind === "unparsed" ? run.result.reason : "", /ends partway through a line/u);
  assert.deepEqual(told.at(-1)?.findings, [finding]);
  assert.match(told.at(-1)?.broken ?? "", /partway/u);
});

/** A killed round's findings and its cost come from one point in the file. */
test("each progress carries the cost and the reports of the same point in the file", async () => {
  const { told } = await read(reviewed);
  assert.deepEqual(
    told.map((progress) => [progress.cost?.messages, progress.findings.length, progress.finished]),
    [
      [1, 0, false],
      [1, 1, false],
      [1, 1, false],
      [1, 1, true],
      [2, 1, true],
    ],
  );
});

/**
 * The closing message comes after the finish, and the extension's last attempt
 * at its usage can fail with nothing written. A finish is no proof the cost is
 * complete.
 */
test("a finish with no message's usage after it is a cost that is a floor", async () => {
  const lost = await read(fileOf(usage("toolUse", 0.002), findingLine, finish));
  assert.equal(lost.run.result.kind, "reviewed");
  assert.deepEqual(lost.run.cost, { dollars: 0.002, tokens: 100, messages: 1, floor: true });

  const written = await read(fileOf(usage("toolUse", 0.002), findingLine, finish, usage("stop", 0.001)));
  assert.equal(written.run.cost?.floor, undefined, "the closing message's usage was written");
});

test("a file ending on a report with no message after it is a cost that is a floor", async () => {
  const { run } = await read(fileOf(usage("toolUse", 0.002), findingLine));
  assert.equal(run.cost?.floor, true);
});

test("an unfinished end after the last message's usage does not make the cost a floor", async () => {
  const { run } = await read(fileOf(usage("toolUse", 0.002), findingLine, usage("stop", 0.001), { type: "unfinished" }));
  assert.equal(run.cost?.floor, undefined);
});
