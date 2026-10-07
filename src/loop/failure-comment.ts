/**
 * A failed round's report, and the one comment on the pull request that announces
 * it.
 *
 * **The comment and the caller's stderr say the same words.** Both are read from
 * `failureReport`, so the reason a person reads on the pull request is the reason
 * the coding agent was handed, and neither can be reworded without the other.
 *
 * Posting is a create, made once and never retried. A comment that could not be
 * posted comes back as a value for the caller to report, and it changes nothing
 * about what the round concluded.
 */

import { renderFailure, type ClosedBy, type FailureReport } from "../github/failure-body.ts";
import type { GhCall } from "../github/gh.ts";
import { postIssueComment, type CommentPosting } from "../github/summary.ts";
import { unthreadedNotes, worktreeNotes } from "../github/summary-body.ts";
import { evidenceWith, nothingEstablished, type RoundConfinement } from "./confinement.ts";
import type { PostedFindings } from "./post-findings.ts";

/** What a failed round holds that its report is composed from. */
export type FailedRound = {
  readonly reason: string;
  /** What the readings around the reviewer found, absent where no reviewer ran. */
  readonly confinement?: RoundConfinement;
  /** What the round put on the pull request, absent where it salvaged nothing. */
  readonly salvaged?: { readonly findings: PostedFindings };
  /** The bound that leaves the episode no round after this one, absent where one remains. */
  readonly closed?: ClosedBy;
};

/**
 * What `round` failed at and what else it established, as the comment says it
 * and as stderr prints it.
 *
 * The worktree items are this round's readings alone. The summary's Notes cover
 * the whole episode, and a failure comment is about one round.
 *
 * A line break in the reason becomes a space, so the comment's first line and the
 * stderr line are each one line and still the same string.
 */
export function failureReport(round: FailedRound): FailureReport {
  const evidence =
    round.confinement === undefined
      ? nothingEstablished
      : (evidenceWith(undefined, round.confinement) ?? nothingEstablished);
  const salvaged = round.salvaged?.findings ?? { outcomes: [] };
  const outcomes = salvaged.outcomes;
  return {
    reason: round.reason.replace(/\s*[\n\r\v\f\u0085\u2028\u2029]\s*/gu, " ").trim(),
    established: worktreeNotes(evidence),
    ...(round.closed === undefined ? {} : { closed: round.closed }),
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
