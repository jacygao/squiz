/**
 * The calls the reviewer reports through, named in one place.
 *
 * Three parts need the same names and cannot derive them from one another: the
 * grant on the command line, the extension that registers the calls inside
 * `pi`, and the read of the stream they arrive in. A name spelled twice is a
 * reporting tool the grant withholds, which `pi` does silently and which leaves
 * the reviewer with no way to report at all.
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
 * The reporting calls, which the grant carries at every depth.
 *
 * Depth decides how much the reviewer may read and run. Reporting is not a
 * depth: a reviewer with no way to report is a round that cannot return
 * anything, whatever it was allowed to look at.
 */
export const reportingTools: readonly string[] = Object.freeze([
  REPORT_FINDING,
  REPORT_VERDICT,
  FINISH_REVIEW,
]);
