/**
 * The three calls the reviewer reports through, as any CLI's server of them
 * runs them: what each accepts, what it refuses, what it answers, and what it
 * writes to the report file.
 *
 * A report that is not one the harness could compose a comment or a mutation
 * from is refused, and the refusal reaches the reviewer as the call's error
 * while it is still there to correct it. The round's other reports stand: one
 * malformed finding is one refusal.
 *
 * The reviewer is told a report landed only once it is in the file, so a write
 * that fails is answered as a failure:
 *
 * - a report or the finish that cannot be recorded is refused, and the reviewer
 *   can make the call again;
 * - a refusal that cannot be recorded still refuses, and says it was not
 *   recorded;
 * - usage that cannot be recorded throws. The line is kept and written ahead of
 *   the next line that can be written, so a finish never lands in a file still
 *   missing usage, which would read as a complete review that cost less than
 *   it did. Usage that still cannot be written at the run's end is lost, and
 *   the file cannot say so: it is the file that refused the write. So a finish
 *   in the file does not prove the usage after it is complete.
 */

import { readFinding, readVerdict } from "../findings/reported.ts";
import type { Line, ReportFile } from "./report-file.ts";
import { FINISH_REVIEW, REPORT_FINDING, REPORT_VERDICT } from "./reporting.ts";

/**
 * What a call answers with. `text` is what the reviewer reads, and `details`
 * is the report whole, for a CLI that hands the harness something the model is
 * not sent.
 */
export type Answer = { readonly text: string; readonly details: unknown };

/** One reporting call. `parameters` is the JSON Schema the CLI validates against. */
export type ReportCall = {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
  /** Accept and record the report. Throws the refusal the reviewer reads. */
  readonly answer: (params: unknown) => Answer;
};

export type ReportCalls = {
  /** In the order the grant carries them. */
  readonly calls: readonly ReportCall[];
  /**
   * Record a call the CLI stopped before it ran, and return the reason to hand
   * the reviewer: `reason` itself, or with a sentence added where the file
   * refused the line.
   */
  readonly stopped: (call: string, reason: string) => string;
  /** Record a line, writing any usage the file refused before it. Throws where it cannot. */
  readonly record: (line: Line) => void;
  /** Write the usage the file refused. Throws where it still cannot. */
  readonly flush: () => void;
  /** Whether the finish is recorded. */
  readonly finished: () => boolean;
};

/**
 * As much of a headline as a confirmation quotes.
 *
 * Every call must bound what it answers with, because the answer is spent in
 * the reviewer's context. A confirmation carries the headline so the reviewer
 * can see which report landed, and a headline has no length this can rely on.
 */
const HEADLINE_LIMIT = 120;

const findingParameters = {
  type: "object",
  properties: {
    scope: {
      type: "string",
      enum: ["line", "file", "change"],
      description:
        "line where a single line owns the defect, file where no line does, change where no file does.",
    },
    file: {
      type: "string",
      description: "The file the finding is anchored to. On a line and a file finding only.",
    },
    line: {
      type: "integer",
      description: "The line the finding is anchored to, which the change must have touched. On a line finding only.",
    },
    severity: { type: "string", enum: ["high", "medium", "low"] },
    headline: { type: "string", description: "The problem, named in one line." },
    reasoning: {
      type: "array",
      items: { type: "string" },
      description: "The points beneath the headline, one point each. They are read as bullets.",
    },
    suggestedFix: { type: "string", description: "What to do about it." },
    reference: {
      type: "string",
      description:
        "Optional: a convention quoted, or something you could not check. Leave it out where there is none.",
    },
  },
  required: ["scope", "severity", "headline", "reasoning", "suggestedFix"],
};

const verdictParameters = {
  type: "object",
  properties: {
    thread: {
      type: "string",
      description: "The identifier the thread was handed to you under, copied exactly.",
    },
    verdict: {
      type: "string",
      enum: ["fixed", "withdrawn", "open"],
      description:
        "fixed where the defect is gone, withdrawn where there was none, open where it is still there.",
    },
  },
  required: ["thread", "verdict"],
};

const finishParameters = { type: "object", properties: {} };

/**
 * The three calls, recording into `file`.
 *
 * The threads already ruled on are held here, so that a second ruling on one
 * thread is refused while the reviewer can still decide which of the two it
 * meant. The usage the file refused is held until it can be written, and
 * whether the finish was recorded is held for the caller to ask. Nothing else
 * is held: a report is answered and gone.
 */
export function reportCalls(file: ReportFile): ReportCalls {
  const kept = keepingLostUsage(file);
  const ruled = new Set<string>();
  let finished = false;

  const calls: readonly ReportCall[] = [
    {
      name: REPORT_FINDING,
      description:
        "Report one finding, as soon as you have confirmed it. Call it once per finding. A finding you hold back until the end of the review is a finding that is lost if the review is cut short.",
      parameters: findingParameters,
      answer: (params) => {
        const finding = readFinding(params);
        if ("reason" in finding) {
          throw refusedReport(kept, REPORT_FINDING, `the finding ${finding.reason}`);
        }
        recordReport(kept, REPORT_FINDING, "the finding", finding.value);
        return { text: `Reported: ${excerptOf(finding.value.headline)}`, details: finding.value };
      },
    },
    {
      name: REPORT_VERDICT,
      description:
        "Rule on one thread you were handed. Call it once per thread, naming the thread by the identifier it was handed to you under.",
      parameters: verdictParameters,
      answer: (params) => {
        const verdict = readVerdict(params);
        if ("reason" in verdict) {
          throw refusedReport(kept, REPORT_VERDICT, `the verdict ${verdict.reason}`);
        }
        const { thread } = verdict.value;
        if (ruled.has(thread)) {
          throw refusedReport(
            kept,
            REPORT_VERDICT,
            `thread ${thread} was already ruled on, and one ruling stands per thread`,
          );
        }
        recordReport(kept, REPORT_VERDICT, "the verdict", verdict.value);
        // Only once it is recorded, so that a ruling the file refused can be made again.
        ruled.add(thread);
        return { text: `Ruled ${verdict.value.verdict} on ${thread}`, details: verdict.value };
      },
    },
    {
      name: FINISH_REVIEW,
      description:
        "End the review. Call it exactly once, after the last finding and the last verdict, and call it even where you found nothing. The review is over once you have called it, so report everything you have before it. A review that ends without it is a review that was cut short.",
      parameters: finishParameters,
      answer: () => {
        const unrecorded = failureOf(() => kept.record({ type: "finish" }));
        if (unrecorded !== undefined) {
          throw new Error(
            `the finish could not be recorded, so the review is not finished (${unrecorded}). Call ${FINISH_REVIEW} again.`,
          );
        }
        finished = true;
        return { text: "The review is complete.", details: {} };
      },
    },
  ];

  return {
    calls,
    stopped: (call, reason) => {
      const unrecorded = failureOf(() =>
        kept.record({ type: "refused", call, reason, stopped: true }),
      );
      if (unrecorded === undefined) return reason;
      return `${reason} ${unrecordedRefusal(unrecorded)}`;
    },
    record: kept.record,
    flush: kept.flush,
    finished: () => finished,
  };
}

/**
 * The file, writing the usage it refused ahead of every later line.
 *
 * A later line is not written until the usage before it is, so every line
 * after a lost one fails with it, the finish included.
 */
function keepingLostUsage(file: ReportFile): ReportFile & { readonly flush: () => void } {
  const lost: Line[] = [];
  const flush = (): void => {
    while (lost[0] !== undefined) {
      file.record(lost[0]);
      lost.shift();
    }
  };
  return {
    record: (line) => {
      try {
        flush();
        file.record(line);
      } catch (cause) {
        if (line.type === "usage") lost.push(line);
        throw cause;
      }
    },
    flush,
  };
}

/** Record an accepted report, or throw the refusal the reviewer reads where it cannot be. */
function recordReport(file: ReportFile, call: string, named: string, value: unknown): void {
  const unrecorded = failureOf(() => file.record({ type: "report", call, value }));
  if (unrecorded === undefined) return;
  throw new Error(
    `${named} could not be recorded, so it was not reported (${unrecorded}). Report it again.`,
  );
}

/** The error a refused report is answered with, recorded before it is thrown. */
function refusedReport(file: ReportFile, call: string, reason: string): Error {
  const unrecorded = failureOf(() =>
    file.record({ type: "refused", call, reason, stopped: false }),
  );
  if (unrecorded === undefined) return new Error(reason);
  return new Error(`${reason}. ${unrecordedRefusal(unrecorded)}`);
}

function unrecordedRefusal(failure: string): string {
  return `The refusal could not be recorded (${failure}).`;
}

/** What went wrong running `act`, or `undefined` where nothing did. */
function failureOf(act: () => void): string | undefined {
  try {
    act();
    return undefined;
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}

/** As much of a headline as a confirmation carries. */
function excerptOf(headline: string): string {
  if (headline.length <= HEADLINE_LIMIT) return headline;
  return `${headline.slice(0, HEADLINE_LIMIT - 3)}...`;
}
