/**
 * What a thread ends its episode as: the reviewer's verdict on it and what the
 * coding agent did to it, read as one of four statuses.
 * (review-harness-spec, "Findings")
 */

/** What the reviewer rules on a thread it was handed. */
export type Verdict = "fixed" | "withdrawn" | "open";

/**
 * The verdict a thread the reviewer returned none for is treated as. A default
 * and not an error: a thread the reviewer forgot must not be closed by the
 * forgetting.
 * (review-harness-spec, "Findings")
 */
export const defaultVerdict: Verdict = "open";

/**
 * Where a thread ends its episode. `open` and `disputed` are the two that need
 * a person, and the summary comment counts all four.
 * (review-harness-spec, "Findings" and "What the comment carries")
 */
export type ThreadStatus = "fixed" | "withdrawn" | "open" | "disputed";

/**
 * A thread as the harness has it when the episode closes: what the reviewer
 * ruled on it, and what the coding agent did to it.
 *
 * The two booleans are named rather than positional. A caller that swapped
 * them would read `open` for a thread that is `disputed`, and no type would
 * catch it.
 */
export type ThreadAtClose = {
  // `null` where the reviewer returned no verdict for the thread.
  verdict: Verdict | null;
  codingAgentReplied: boolean;
  // Resolved by the coding agent before the verdict above ruled on it.
  codingAgentResolved: boolean;
};

/**
 * The status the thread ends its episode in.
 *
 * A verdict of `fixed` or `withdrawn` is the status. Any other verdict leaves
 * the thread unresolved at the close, and the coding agent's reply is what
 * separates a disagreement from a finding nobody answered.
 */
export function statusOf(thread: ThreadAtClose): ThreadStatus {
  switch (verdictOf(thread)) {
    case "fixed":
      return "fixed";
    case "withdrawn":
      return "withdrawn";
    case "open":
      return thread.codingAgentReplied ? "disputed" : "open";
  }
}

/**
 * Whether the verdict re-opens a thread the coding agent had resolved.
 *
 * The summary counts these, and the count is not a fifth status: a thread
 * counted here still ends its episode in one of the four.
 * (review-harness-spec, "Findings")
 */
export function isReopened(thread: ThreadAtClose): boolean {
  return verdictOf(thread) === "open" && thread.codingAgentResolved;
}

function verdictOf(thread: ThreadAtClose): Verdict {
  return thread.verdict ?? defaultVerdict;
}
