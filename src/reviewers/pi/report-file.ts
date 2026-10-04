/**
 * The round's report file: one JSON line for each thing the reviewer did that
 * the round reads, appended inside `pi` as it happens.
 *
 * In a pane `pi`'s output is the screen, so what the reviewer reported has to
 * reach the round some other way, and this file is it.
 *
 * Each line is written whole by one append, newline included. A line written in
 * two pieces can have another writer's line land between them, and then neither
 * reads back.
 */

import { appendFileSync } from "node:fs";

/** The variable naming the file, which the adapter sets and the extension reads. */
export const REPORTS_VARIABLE = "SQUIZ_REPORTS";

/**
 * One report a call accepted. `value` is what the call accepted, after `pi`
 * converted the arguments and the extension read them, so it can differ from
 * what the model sent.
 */
export type ReportLine = {
  readonly type: "report";
  /** `report_finding` or `report_verdict`. */
  readonly call: string;
  readonly value: unknown;
};

/** One call the extension refused, with the refusal the reviewer was handed. */
export type RefusedLine = {
  readonly type: "refused";
  readonly call: string;
  readonly reason: string;
  /**
   * True where the call was stopped before it ran, which is the refusal the
   * round counts. False where a reporting call ran and refused the report.
   */
  readonly stopped: boolean;
};

/**
 * One assistant message, as much of it as the round's cost and its failure
 * read. `pi` sends one for every attempt at a request, so a retried request
 * that failed is a line of its own with a `stopReason` of `error`.
 */
export type UsageLine = {
  readonly type: "usage";
  readonly stopReason?: string;
  readonly errorMessage?: string;
  readonly model?: string;
  /** `pi`'s usage as it carried it: the token counts, and the dollars under `cost`. */
  readonly usage?: unknown;
};

/** The reviewer called `finish_review`. */
export type FinishLine = { readonly type: "finish" };

export type Line = ReportLine | RefusedLine | UsageLine | FinishLine;

export type ReportFile = {
  /** Append the line. Throws where the file cannot be written. */
  readonly record: (line: Line) => void;
};

/**
 * The file at `path`, or one that records nothing where no path is given.
 *
 * Nothing is created: a directory that is missing is a write that fails.
 */
export function reportFileAt(path: string | undefined): ReportFile {
  if (path === undefined || path === "") return { record: () => {} };
  return { record: (line) => appendFileSync(path, `${JSON.stringify(line)}\n`) };
}
