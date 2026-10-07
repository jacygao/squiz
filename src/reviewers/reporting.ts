/**
 * The calls the reviewer reports through, named in one place.
 *
 * Three parts need the same names and cannot derive them from one another: the
 * grant on the command line, what serves the calls to the reviewer's CLI, and
 * the read of the report file. A name spelled twice is a reporting call the
 * grant can withhold, which leaves the reviewer with no way to report at all.
 * `pi` withholds one silently.
 */

/** One finding, reported as the reviewer confirms it. */
export const REPORT_FINDING = "report_finding";

/** One ruling on one thread the reviewer was handed. */
export const REPORT_VERDICT = "report_verdict";

/**
 * The review is complete.
 *
 * It is what tells a reviewer that honestly found nothing from one that never
 * reached the end of its review, which no count of findings can say.
 */
export const FINISH_REVIEW = "finish_review";

/**
 * The reporting calls, which the grant always carries.
 *
 * A reviewer with no way to report is a round that cannot return anything,
 * whatever it was allowed to look at.
 */
export const reportingTools: readonly string[] = Object.freeze([
  REPORT_FINDING,
  REPORT_VERDICT,
  FINISH_REVIEW,
]);
