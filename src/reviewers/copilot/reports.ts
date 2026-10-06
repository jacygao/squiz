/**
 * One run of Copilot, read out of the report file: what the reviewer reported
 * through the reporting server, and the one usage line the shell appends once
 * Copilot has exited 0.
 *
 * Copilot reports no usage while the run goes on, so the cost arrives once, at
 * the end, or not at all. It is Copilot's own total and never a floor. A run
 * stopped from outside leaves no usage line, and so does one that failed.
 *
 * **What the run was is read from the finish and the usage line:**
 *
 * - a finish is a review;
 * - no finish, and a usage line counting a request, is a review that stopped
 *   without finishing;
 * - no finish, and no usage line or one counting no request, is a run that
 *   completed no message.
 *
 * A line that cannot be read fails the run, finish or not. The reviewer was told
 * its report had landed, so the run is not a review one finding short.
 */

import type { Finding } from "../../findings/finding.ts";
import { readFinding, readVerdict } from "../../findings/reported.ts";
import {
  type ParsedRun,
  type ProgressSoFar,
  type Reported,
  type RoundCost,
  type RunResult,
  type Spend,
  type ThreadVerdict,
} from "../adapter.ts";
import { REPORT_FINDING, REPORT_VERDICT } from "../reporting.ts";

/** As much of a line as a reason quotes. */
const EXCERPT_LIMIT = 120;

/** Copilot's `totalNanoAiu` to the AI credit. */
const NANO_AIU_PER_CREDIT = 1e9;

/** What the run's usage line said. */
type Usage = {
  /** Requests over every model, which say whether any message completed. */
  readonly requests: number;
  /** `undefined` where the line carried no token counts to sum. */
  readonly cost: RoundCost | undefined;
};

type Tally = {
  findings: Finding[];
  verdicts: ThreadVerdict[];
  ruled: Set<string>;
  refusals: number;
  finished: boolean;
  usage: Usage | undefined;
  broken: string | undefined;
};

/**
 * Read the report file's bytes as they arrive.
 *
 * `soFar` is told after every whole line. Never throws on the file's content;
 * a read that fails at its source still raises through the iteration.
 */
export async function readReports(
  reports: AsyncIterable<string | Uint8Array>,
  soFar?: ProgressSoFar,
): Promise<ParsedRun> {
  const tally: Tally = {
    findings: [],
    verdicts: [],
    ruled: new Set(),
    refusals: 0,
    finished: false,
    usage: undefined,
    broken: undefined,
  };
  const tell = (): void => soFar?.({ cost: costOf(tally), ...reportedIn(tally) });

  const decoder = new TextDecoder();
  let pending = "";
  let number = 0;
  for await (const chunk of reports) {
    pending += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let from = 0;
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      number += 1;
      take(tally, pending.slice(from, newline), number);
      tell();
      from = newline + 1;
      newline = pending.indexOf("\n", from);
    }
    pending = pending.slice(from);
  }
  pending += decoder.decode();
  if (pending !== "") {
    tally.broken ??= `the report file ends partway through a line: ${excerptOf(pending)}`;
    tell();
  }
  return { cost: costOf(tally), result: resultOf(tally) };
}

/** Count one whole line, newline taken off. */
function take(tally: Tally, text: string, number: number): void {
  const unreadable = (why: string): void => {
    tally.broken ??= `line ${number} of the report file could not be read: ${why}: ${excerptOf(text)}`;
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    unreadable("it is not JSON");
    return;
  }
  const line = recordOf(parsed);
  if (line === null) {
    unreadable("it is not an object");
    return;
  }

  switch (line["type"]) {
    case "report": {
      if (line["call"] === REPORT_FINDING) {
        const finding = readFinding(line["value"]);
        if ("reason" in finding) tally.broken ??= `a finding the reviewer reported ${finding.reason}`;
        else tally.findings.push(finding.value);
      } else if (line["call"] === REPORT_VERDICT) {
        const verdict = readVerdict(line["value"]);
        if ("reason" in verdict) tally.broken ??= `a verdict the reviewer reported ${verdict.reason}`;
        // One ruling per thread. The server refused a second where it was made.
        else if (!tally.ruled.has(verdict.value.thread)) {
          tally.ruled.add(verdict.value.thread);
          tally.verdicts.push(verdict.value);
        }
      } else {
        unreadable("it reports through no call the reviewer is given");
      }
      return;
    }
    case "refused": {
      const { call, reason, stopped } = line;
      if (typeof call !== "string" || typeof reason !== "string" || typeof stopped !== "boolean") {
        unreadable("a refusal carries no call, reason and flag");
        return;
      }
      // A report the call itself refused was the reviewer's to correct.
      if (stopped) tally.refusals += 1;
      return;
    }
    case "finish":
      tally.finished = true;
      return;
    case "usage": {
      if (tally.usage !== undefined) {
        unreadable("it is a second usage line, and a run writes one");
        return;
      }
      const usage = usageOf(line["usage"]);
      if (usage === null) {
        unreadable("its usage is not an object");
        return;
      }
      tally.usage = usage;
      return;
    }
    default:
      unreadable("it is of no type the reader knows");
  }
}

/**
 * What Copilot's usage file says: the requests, and the cost where every model
 * carries token counts. `null` where there is no usage object at all.
 *
 * `inputTokens` already holds cache reads and writes, so tokens are input and
 * output alone.
 */
function usageOf(value: unknown): Usage | null {
  const usage = recordOf(value);
  if (usage === null) return null;
  const models = Object.values(recordOf(usage["modelMetrics"]) ?? {});
  let requests = 0;
  let tokens = 0;
  let counted = models.length > 0;
  for (const model of models) {
    const metrics = recordOf(model);
    const count = recordOf(metrics?.["requests"])?.["count"];
    if (isAmount(count)) requests += count;
    const used = recordOf(metrics?.["usage"]);
    const input = used?.["inputTokens"];
    const output = used?.["outputTokens"];
    if (isAmount(input) && isAmount(output)) tokens += input + output;
    else counted = false;
  }
  if (!counted) return { requests, cost: undefined };
  const nano = usage["totalNanoAiu"];
  const cost: RoundCost = {
    dollars: 0,
    tokens,
    messages: requests,
    ...(isAmount(nano) ? { credits: nano / NANO_AIU_PER_CREDIT } : {}),
  };
  return { requests, cost };
}

function resultOf(tally: Tally): RunResult {
  if (tally.broken !== undefined) return { kind: "unparsed", reason: tally.broken };
  if (tally.finished) {
    return { kind: "reviewed", findings: [...tally.findings], verdicts: [...tally.verdicts] };
  }
  if ((tally.usage?.requests ?? 0) === 0) {
    return { kind: "incomplete", reason: "the reviewer completed no message" };
  }
  return { kind: "unparsed", reason: unfinished(tally.findings, tally.verdicts) };
}

/** The run's cost, or none: no usage line, or one that carried no token counts. */
function costOf(tally: Tally): Spend {
  return tally.usage?.cost;
}

function reportedIn(tally: Tally): Reported {
  return {
    findings: [...tally.findings],
    verdicts: [...tally.verdicts],
    refusals: tally.refusals,
    finished: tally.finished,
    broken: tally.broken,
  };
}

/** A review that stopped without being finished, and how much of one it got through. */
function unfinished(findings: readonly Finding[], verdicts: readonly ThreadVerdict[]): string {
  if (findings.length === 0 && verdicts.length === 0) {
    return "the reviewer reported nothing and did not finish its review";
  }
  const reported = `${countOf(findings.length, "finding")} and ${countOf(verdicts.length, "verdict")}`;
  return `the reviewer reported ${reported} and did not finish its review`;
}

function countOf(many: number, thing: string): string {
  return many === 1 ? `1 ${thing}` : `${many} ${thing}s`;
}

function isAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Readonly<Record<string, unknown>>;
}

function excerptOf(line: string): string {
  return line.length > EXCERPT_LIMIT ? `${line.slice(0, EXCERPT_LIMIT - 3)}...` : line;
}
