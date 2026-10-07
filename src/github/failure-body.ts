/**
 * The body of the comment a failed round posts: the reason it failed, what it
 * salvaged, and what else it established.
 *
 * The reason on the first line is the line the caller prints on stderr, and each
 * item of the list is a line there too. Both are read from one report, so this
 * renders the report's own strings and rewords none of them.
 */

import { grouped } from "./spend-line.ts";

/** What a failed round established, which is everything its comment says. */
export type FailureReport = {
  /** Why the round failed, as one line. */
  readonly reason: string;
  /**
   * Each salvaged finding no thread holds, one line each, as the summary's Notes
   * write it. Listed in the comment and never printed on stderr: a failed round
   * posts no summary, so this comment is the only place on the pull request that
   * holds them.
   */
  readonly unthreaded?: readonly string[];
  /** What else the round established, one item each, as one line each. */
  readonly established: readonly string[];
  /**
   * How many of the findings the reviewer reported landed as threads. Absent
   * where the round salvaged no findings, which leaves nothing to count.
   */
  readonly salvaged?: { readonly threaded: number; readonly reported: number };
  /**
   * The bound that leaves the episode no round after this one. Absent where a
   * round remains, which is the only case a new commit or reply retries.
   */
  readonly closed?: ClosedBy;
};

/**
 * Why no round runs after the failed one. `roundsRun` counts the episode's
 * rounds, this one included where it was a round.
 */
export type ClosedBy =
  | { readonly bound: "round-cap"; readonly roundsRun: number; readonly cap: number }
  | { readonly bound: "token-bound"; readonly tokens: number; readonly roundsRun: number };

/**
 * The marker the comment opens with. The dash is part of it: `**Squiz review`
 * alone also opens the summary and every finding.
 */
const marker = "**Squiz review failed — ";

/** The comment's body for `report`, with no trailing newline. */
export function renderFailure(report: FailureReport): string {
  const counted = report.salvaged === undefined ? [] : [howManyLanded(report.salvaged)];
  const next =
    report.closed === undefined
      ? ["The review is still open.", "A new commit or reply, or running `squiz review` again, retries it."]
      : closedLines(report.closed, "A new commit or reply, or running `squiz review`, posts its summary.");
  const blocks = [`${marker}${report.reason}**`, [...counted, ...next].join(" ")];
  // The findings come first and the worktree after, the order the summary's
  // Notes keep.
  const items = [...(report.unthreaded ?? []), ...report.established];
  if (items.length > 0) blocks.push(items.map((item) => `- ${item}`).join("\n"));
  return blocks.join("\n\n");
}

/**
 * What a closed episode's report says in place of the retry, as sentences.
 * `summary` says what posts the summary, in the words its reader acts on.
 *
 * The next firing finds the bound spent and closes the episode without a
 * reviewer, posting the summary. An episode that ran no round may have no thread
 * for a summary to count, so it is promised none.
 */
export function closedLines(closed: ClosedBy, summary: string): string[] {
  const why =
    closed.bound === "round-cap"
      ? `it has run ${closed.roundsRun} ${closed.roundsRun === 1 ? "round" : "rounds"}, and the round cap allows ${closed.cap}`
      : `it reached the token bound of ${grouped(closed.tokens)} tokens`;
  return [`The review is closed: ${why}.`, "No round runs again.", ...(closed.roundsRun === 0 ? [] : [summary])];
}

/** How many of the salvaged findings are threads on the pull request, as a sentence. */
function howManyLanded({ threaded, reported }: { threaded: number; reported: number }): string {
  if (threaded === reported) {
    if (reported === 1) return "The finding is posted as a thread.";
    if (reported === 2) return "Both findings are posted as threads.";
    return `All ${reported} findings are posted as threads.`;
  }
  if (reported === 1) return "The finding the reviewer reported is not posted as a thread.";
  const verb = threaded === 1 ? "is posted as a thread" : "are posted as threads";
  return `${threaded} of the ${reported} findings the reviewer reported ${verb}.`;
}
