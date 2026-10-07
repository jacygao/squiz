/**
 * A failed round's report, and the one comment on the pull request that announces
 * it.
 *
 * **The comment says the reason the caller prints on stderr.** It rewords none
 * of it, so the reason a person reads on the pull request is the reason the
 * coding agent was handed.
 *
 * Posting is a create, made once and never retried. A comment that could not be
 * posted comes back as a value for the caller to report, and it changes nothing
 * about what the round concluded.
 */

import { renderFailure, type ClosedBy, type FailureReport } from "../github/failure-body.ts";
import type { GhCall } from "../github/gh.ts";
import { postIssueComment, type CommentPosting } from "../github/summary.ts";
import { unthreadedNotes } from "../github/summary-body.ts";
import type { PostedFindings } from "./post-findings.ts";

/** What a failed round holds that its report is composed from. */
export type FailedRound = {
  readonly reason: string;
  /** What the round put on the pull request, absent where it salvaged nothing. */
  readonly salvaged?: { readonly findings: PostedFindings; readonly unappliedNotes: readonly string[] };
  /** The bound that leaves the episode no round after this one, absent where one remains. */
  readonly closed?: ClosedBy;
};

/**
 * What `round` failed at and what it salvaged, as the comment says it and as
 * stderr prints it.
 *
 * A line break in the reason becomes a space, so the comment's first line and the
 * stderr line are each one line and still the same string.
 */
function failureReport(round: FailedRound): FailureReport {
  const salvaged = round.salvaged?.findings ?? { outcomes: [] };
  const outcomes = salvaged.outcomes;
  const unapplied = round.salvaged?.unappliedNotes ?? [];
  return {
    reason: round.reason.replace(/\s*[\n\r\v\f\u0085\u2028\u2029]\s*/gu, " ").trim(),
    ...(round.closed === undefined ? {} : { closed: round.closed }),
    ...(unapplied.length === 0 ? {} : { unapplied }),
    ...(outcomes.length === 0
      ? {}
      : {
          unthreaded: unthreadedNotes(salvaged),
          salvaged: {
            // What landed, read from what the posting returned. A finding the
            // reviewer reported and GitHub refused is not on the pull request.
            threaded: outcomes.filter((outcome) => outcome.outcome === "threaded").length,
            reported: outcomes.length,
          },
        }),
  };
}

/**
 * Post the failure comment for `round` on `pullRequest`, once.
 *
 * `call.until` is the round's posting reserve, the one its salvaged findings were
 * posted under, and nothing is attempted where nothing is left of it.
 */
export function postFailure(pullRequest: number, round: FailedRound, call: GhCall): CommentPosting {
  return postIssueComment(pullRequest, renderFailure(failureReport(round)), call, "the failure");
}
