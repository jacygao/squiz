/**
 * One run of `pi`, read out of the report file the extension appends to: what
 * it cost, what the reviewer reported, and what the run established.
 *
 * The file is read as it grows, so a read can end partway through a line. Only a
 * line ending in a newline is read during the run, and the part after the last
 * newline waits for the rest. Once the run is over nothing more is coming, so a
 * last line with no newline is a line that cannot be read.
 *
 * **A line that cannot be read fails the run, declaration or not.** The reviewer
 * was told that report had landed, so the run is not a review one finding short.
 * The reports read before it, and after it, stand.
 *
 * What the caller is told carries the cost and the reports of the same line, so
 * a round stopped at its bound never holds a cost from one point of the run
 * beside findings from another.
 *
 * **A finish does not prove the cost is complete.** The closing message comes
 * after the finish, and where the file refuses its usage the extension can
 * write nothing to say so. Every run ends on an assistant message, so a file
 * whose last line is not that message's usage is owed one, and its cost is
 * reported as a floor. So is the cost of a file holding a line that could not
 * be read, since that line may have been a message's usage, whatever follows it.
 */

import type { Finding } from "../../findings/finding.ts";
import { readFinding, readVerdict } from "../../findings/reported.ts";
import type {
  ParsedRun,
  ProgressSoFar,
  Reported,
  RoundCost,
  RunResult,
  ThreadVerdict,
} from "../adapter.ts";
import { REPORT_FINDING, REPORT_VERDICT } from "../reporting.ts";

/** As much of a line as a reason quotes. A line has no length this can rely on. */
const EXCERPT_LIMIT = 120;

/** What the read has established so far. */
type Tally = {
  dollars: number;
  tokens: number;
  messages: number;
  /** Whether the last line that counts toward the cost left a message's usage owed. */
  owed: boolean;
  /** Whether a line that could not be read may have carried spend the sum is missing. */
  lost: boolean;
  /** Whether any assistant message carried a stop reason of `stop`. */
  stopped: boolean;
  /** The last reason an errored message gave. */
  reason: string | undefined;
  findings: Finding[];
  verdicts: ThreadVerdict[];
  ruled: Set<string>;
  refusals: number;
  finished: boolean;
  /** The first line that could not be read, or a report that could not be read back. */
  broken: string | undefined;
};

/**
 * Read the report file's bytes as they arrive.
 *
 * `soFar` is told after every line, which is what a caller that stops the
 * process at its bound keeps. Never throws on the file's content; a read that
 * fails at its source still raises through the iteration.
 */
export async function readReports(
  reports: AsyncIterable<string | Uint8Array>,
  soFar?: ProgressSoFar,
): Promise<ParsedRun> {
  const tally: Tally = {
    dollars: 0,
    tokens: 0,
    messages: 0,
    owed: false,
    lost: false,
    stopped: false,
    reason: undefined,
    findings: [],
    verdicts: [],
    ruled: new Set(),
    refusals: 0,
    finished: false,
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
    markUnreadable(tally, `the report file ends partway through a line: ${excerptOf(pending)}`);
    tell();
  }
  return { cost: costOf(tally), result: resultOf(tally) };
}

/** Count one whole line, newline taken off. */
function take(tally: Tally, text: string, number: number): void {
  const unreadable = (why: string): void =>
    markUnreadable(tally, `line ${number} of the report file could not be read: ${why}: ${excerptOf(text)}`);

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
        // One ruling per thread. A second was refused where it was made, so a
        // second here is the two ends disagreeing about what was ruled.
        else if (!tally.ruled.has(verdict.value.thread)) {
          tally.ruled.add(verdict.value.thread);
          tally.verdicts.push(verdict.value);
        }
      } else {
        unreadable("it reports through no call the reviewer is given");
        return;
      }
      tally.owed = true;
      return;
    }
    case "refused": {
      const { call, reason, stopped } = line;
      if (typeof call !== "string" || typeof reason !== "string" || typeof stopped !== "boolean") {
        unreadable("a refusal carries no call, reason and flag");
        return;
      }
      // A call stopped before it ran is the one refusal the round counts. A
      // report the call itself refused was the reviewer's to correct.
      if (stopped) tally.refusals += 1;
      tally.owed = true;
      return;
    }
    case "usage": {
      const stopReason = line["stopReason"];
      const errorMessage = line["errorMessage"];
      if (
        (stopReason !== undefined && typeof stopReason !== "string") ||
        (errorMessage !== undefined && typeof errorMessage !== "string")
      ) {
        unreadable("a message carries a stop reason or an error that is not text");
        return;
      }
      // A message carrying no spend is left out of what the sum covers rather
      // than counted as zero.
      if (line["usage"] !== undefined) {
        const spent = spendOf(line["usage"]);
        if (spent === null) {
          unreadable("a message's usage carries no token total and dollar total");
          return;
        }
        tally.dollars += spent.dollars;
        tally.tokens += spent.tokens;
        tally.messages += 1;
      }
      if (stopReason === "stop") tally.stopped = true;
      if (errorMessage !== undefined) tally.reason = errorMessage;
      tally.owed = false;
      return;
    }
    case "finish":
      tally.finished = true;
      tally.owed = true;
      return;
    // Written after the last message's usage, so it leaves what is owed alone.
    case "unfinished":
      return;
    default:
      unreadable("it is of no type the reader knows");
  }
}

/**
 * What the run established.
 *
 * An unreadable line comes first, because a declaration does not settle it. The
 * declaration comes before the stop reasons, because a finished review is a
 * review whatever the messages around it stopped for. An errored message is not
 * a failed run: `pi` retries a failed request itself, so one sits among the
 * working messages of a round that reviewed.
 */
/**
 * Record a line that could not be read. It may have been a message's usage, so
 * the sum is missing spend from here on, whatever lines follow.
 */
function markUnreadable(tally: Tally, reason: string): void {
  tally.lost = true;
  tally.broken ??= reason;
}

function resultOf(tally: Tally): RunResult {
  if (tally.broken !== undefined) return { kind: "unparsed", reason: tally.broken };
  if (tally.finished) {
    return { kind: "reviewed", findings: [...tally.findings], verdicts: [...tally.verdicts] };
  }
  if (!tally.stopped) {
    return { kind: "incomplete", reason: tally.reason ?? "the reviewer completed no message" };
  }
  return { kind: "unparsed", reason: unfinished(tally.findings, tally.verdicts) };
}

function costOf(tally: Tally): RoundCost {
  const cost = { dollars: tally.dollars, tokens: tally.tokens, messages: tally.messages };
  return tally.owed || tally.lost ? { ...cost, floor: true } : cost;
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

/**
 * The tokens and dollars of one message's usage, or `null` where either total
 * is missing. A field `pi` renamed is then a line that cannot be read, which is
 * the loud version of a round that silently cost nothing.
 */
function spendOf(value: unknown): { readonly dollars: number; readonly tokens: number } | null {
  const usage = recordOf(value);
  if (usage === null) return null;
  const tokens = usage["totalTokens"];
  const cost = recordOf(usage["cost"]);
  const dollars = cost === null ? undefined : cost["total"];
  if (!isAmount(tokens) || !isAmount(dollars)) return null;
  return { dollars, tokens };
}

function isAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * A review that stopped without being finished, and how much of one it got
 * through. The counts tell a round that failed early from one that failed at
 * the end of a review worth most of its budget.
 */
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

function recordOf(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Readonly<Record<string, unknown>>;
}

function excerptOf(line: string): string {
  return line.length > EXCERPT_LIMIT ? `${line.slice(0, EXCERPT_LIMIT - 3)}...` : line;
}
