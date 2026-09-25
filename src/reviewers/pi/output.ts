/**
 * What the reviewer reported for one round, read out of the calls it made.
 *
 * Each finding and each verdict arrives as its own call, answered and gone, so
 * a round holds what the reviewer had at any moment of it rather than only what
 * a last message would have carried. Nothing here waits for the end of the run
 * to know what was found.
 *
 * A call the reviewer got wrong was refused where it was made, and the reviewer
 * was told so: it carries an error here and is passed over. A call that was
 * answered and cannot be read back is the opposite case — the two ends of one
 * report disagreeing — and it fails the output rather than quietly shortening
 * it.
 *
 * The reviewer says when its review is complete, because nothing else can.
 * Silence is a reviewer that found nothing and a reviewer that never reached
 * the end of its review, and an empty round that stood for both would read as a
 * clean review forever.
 *
 * Nothing here decides whether the round failed or should be run again. That
 * reads the run's stop reasons, which this never looks at.
 */

import type { Finding } from "../../findings/finding.ts";
import { readFinding, readVerdict } from "../../findings/reported.ts";
import type { Verdict } from "../../findings/status.ts";
import type { RoundOutput, ThreadVerdict } from "../adapter.ts";
import { FINISH_REVIEW, REPORT_FINDING, REPORT_VERDICT } from "./reporting.ts";
import type { PiEvent } from "./stream.ts";

/** Why the output could not be read. One line, which is what the caller reports. */
type Failure = { readonly outcome: "failed"; readonly reason: string };

/** What the run's output established. */
export type OutputRead = ({ readonly outcome: "read" } & RoundOutput) | Failure;

/** Told what the reviewer has reported so far, each time a report is added to it. */
export type ReportedSoFar = (output: RoundOutput) => void;

/**
 * Read the findings and the verdicts out of a round's events.
 *
 * `reportedSoFar` is told after each one, which is what a caller that will stop
 * the process mid-stream keeps. The whole stream is read whatever goes wrong in
 * it, because a reader that stopped early would leave the reviewer writing into
 * a pipe nobody drains.
 *
 * A line the reader could not turn into an event does not fail this on its own.
 * It is counted, and a failure names how many were dropped, since one of them
 * may have carried a report.
 *
 * Never throws. Output that carries no completed review comes back as `failed`
 * with a reason naming what was wrong with it.
 */
export async function readOutput(
  events: AsyncIterable<PiEvent>,
  reportedSoFar?: ReportedSoFar,
): Promise<OutputRead> {
  const findings: Finding[] = [];
  const verdicts: ThreadVerdict[] = [];
  const ruled = new Set<string>();
  let finished = false;
  let dropped = 0;
  // The first report that was answered and could not be read back.
  let broken: string | undefined;

  for await (const event of events) {
    if (event.type === "unreadable") {
      dropped += 1;
      continue;
    }
    if (event.type !== "tool_execution_end") continue;
    // A call the reviewer got wrong was answered with its refusal, so nothing
    // was reported and the reviewer knows it.
    if (event.isError) continue;

    if (event.toolName === FINISH_REVIEW) {
      finished = true;
      continue;
    }
    if (event.toolName === REPORT_FINDING) {
      const finding = readFinding(detailsOf(event.result));
      if ("reason" in finding) {
        broken ??= `a finding the reviewer reported ${finding.reason}`;
        continue;
      }
      findings.push(finding.value);
      reportedSoFar?.({ findings: [...findings], verdicts: [...verdicts] });
      continue;
    }
    if (event.toolName === REPORT_VERDICT) {
      const verdict = readVerdict(detailsOf(event.result));
      if ("reason" in verdict) {
        broken ??= `a verdict the reviewer reported ${verdict.reason}`;
        continue;
      }
      // One ruling per thread. A second was refused where it was made, so this
      // is reached only where the two ends disagree about what was ruled.
      if (ruled.has(verdict.value.thread)) continue;
      ruled.add(verdict.value.thread);
      verdicts.push(verdict.value);
      reportedSoFar?.({ findings: [...findings], verdicts: [...verdicts] });
    }
  }

  if (broken !== undefined) return failed(broken, dropped);
  if (!finished) return failed(unfinished(findings, verdicts), dropped);
  return { outcome: "read", findings, verdicts };
}

/**
 * The verdict the reviewer returned for `thread`, or `null` where it returned
 * none.
 *
 * `null` is a missing verdict reported as missing, and not a verdict of its
 * own. What a thread nobody ruled on counts as is decided where a thread's
 * status is, and deciding it here as well would put one rule in two places.
 */
export function verdictFor(verdicts: readonly ThreadVerdict[], thread: string): Verdict | null {
  return verdicts.find((ruled) => ruled.thread === thread)?.verdict ?? null;
}

/** What the call carried for the harness, which is the report as it was accepted. */
function detailsOf(result: unknown): unknown {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return null;
  return (result as Readonly<Record<string, unknown>>)["details"];
}

/**
 * A review that stopped without being finished, and how much of one it got
 * through.
 *
 * The counts are in the reason because they decide what a reader does next: a
 * round that reported nothing failed early, and one that reported six findings
 * and never said it was done failed at the end of a review worth most of its
 * budget.
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

/**
 * A failure, carrying how many lines the reader dropped where it dropped any.
 *
 * One of them may have been the call a report arrived in, and a reason that
 * said only that the review did not finish would send a reader looking in the
 * wrong place.
 */
function failed(reason: string, dropped: number): Failure {
  if (dropped === 0) return { outcome: "failed", reason };
  const lines = dropped === 1 ? "1 line" : `${dropped} lines`;
  return { outcome: "failed", reason: `${reason}; ${lines} of the stream could not be read` };
}
