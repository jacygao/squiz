/**
 * The body of the comment a failed round posts: the reason it failed, what it
 * salvaged, and what else it established.
 *
 * The reason on the first line is the line the caller prints on stderr, and each
 * item of the list is a line there too. Both are read from one report, so this
 * renders the report's own strings and rewords none of them.
 */

/** What a failed round established, which is everything its comment says. */
export type FailureReport = {
  /** Why the round failed, as one line. */
  readonly reason: string;
  /** What else the round established, one item each, as one line each. */
  readonly established: readonly string[];
  /**
   * How many of the findings the reviewer reported landed as threads. Absent
   * where the round salvaged no findings, which leaves nothing to count.
   */
  readonly salvaged?: { readonly threaded: number; readonly reported: number };
};

/**
 * The marker the comment opens with. The dash is part of it: `**Squiz review`
 * alone also opens the summary and every finding.
 */
const marker = "**Squiz review failed — ";

/** The comment's body for `report`, with no trailing newline. */
export function renderFailure(report: FailureReport): string {
  const counted = report.salvaged === undefined ? [] : [howManyLanded(report.salvaged)];
  const blocks = [
    `${marker}${report.reason}**`,
    [
      ...counted,
      "The review is still open.",
      "A new commit or reply, or running `squiz review` again, retries it.",
    ].join(" "),
  ];
  if (report.established.length > 0) {
    blocks.push(report.established.map((item) => `- ${item}`).join("\n"));
  }
  return blocks.join("\n\n");
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
