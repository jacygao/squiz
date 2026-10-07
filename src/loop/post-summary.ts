/**
 * The episode's summary comment: composed from what the closing round holds, and
 * posted once.
 *
 * **The comment is the episode's close and not a round's.** Only a round that
 * closed the episode reaches here. A round that leaves threads open posts
 * nothing, or the pull request would carry a report of the review for every
 * round while it was still going on.
 *
 * Posting is a create and never an edit. Whatever this sends is permanent for the
 * episode, and a second episode on the same pull request adds a second comment
 * and leaves the first alone.
 *
 * Nothing here throws. A comment that could not be posted comes back as a value
 * for the caller to report, and it does not turn the close into a failed round:
 * the episode is over either way, and the coding agent still finishes.
 */

import type { GhCall } from "../github/gh.ts";
import { renderSummary } from "../github/summary-body.ts";
import { postSummary, type CommentPosting } from "../github/summary.ts";
import type { ReviewThread } from "../github/threads.ts";
import { classifyAtClose } from "./classify.ts";
import type { ConfinementEvidence } from "./confinement.ts";
import type { RoundRecord } from "./episode-state.ts";
import type { PostedFindings } from "./post-findings.ts";
import type { ClosingReason } from "./round-decision.ts";
import type { LeftNotReviewed } from "./round-end.ts";
import type { AppliedVerdicts } from "./verdicts.ts";

/**
 * What became of the episode's summary comment, which every close says.
 *
 * Three answers and no fourth. A close that could say nothing about its summary is
 * a close that reports no comment and no reason for there being none, and exit 0
 * then reads as a review that ended clean.
 */
export type EpisodeSummary =
  | CommentPosting
  /**
   * Nothing was composed and nothing ever will be, so the episode ends with no
   * summary on the pull request at all. `reason` is the one line that says so.
   */
  | { readonly outcome: "never-composed"; readonly reason: string };

/** What the round that closed the episode holds of it, which is the whole of it. */
export type ClosingRound = {
  readonly pullRequest: number;
  /**
   * Each round of the episode, in the order the rounds ran, this round included.
   * Read from the episode's state file, which is the only thing that carries a
   * round's cost, or the bound that cut it short, past the round.
   */
  readonly rounds: readonly RoundRecord[];
  /**
   * Every thread this round handed the reviewer, as it was listed before the
   * review ran.
   *
   * Every thread of the episode is in it, resolved ones included, and the threads
   * this round opened are not: they did not exist when the listing was made, and
   * `findings` is where they are.
   */
  readonly handedOver: readonly ReviewThread[];
  /** What the reviewer ruled on each of those threads. */
  readonly verdicts: AppliedVerdicts;
  /** What became of every finding this round raised. */
  readonly findings: PostedFindings;
  /**
   * Which of the three reasons closed the episode.
   *
   * Always one of them. A round the reviewer failed reached no decision and posts
   * no summary at all, so nothing here is composed without a closing reason.
   */
  readonly because: ClosingReason;
  /**
   * What every round of the episode established about the worktree its reviewer
   * ran in, read from the episode's state file.
   *
   * The episode's and not this round's. A round that leaves threads open posts
   * no comment, so what its readings found reaches a person through this or not
   * at all, and a close composed from the closing round's own readings would
   * report the worktree of one round as the worktree of the whole episode.
   */
  readonly confinement: ConfinementEvidence;
  /**
   * The queued states the close recorded not reviewed, and the bound that
   * stopped them, as the round's end decided. `null` where nothing was queued.
   */
  readonly leftNotReviewed: LeftNotReviewed | null;
};

/**
 * Compose the summary for `closing` and post it on the pull request, once.
 *
 * `call.until` is the round's posting margin, and the call is not made at all
 * where nothing is left of it: a call made past the end of the reserve would run
 * the round past its bound. The summary is lost in that case, which is what the
 * caller reports.
 */
export function postEpisodeSummary(closing: ClosingRound, call: GhCall): CommentPosting {
  const body = renderSummary({
    rounds: closing.rounds,
    threads: classifyAtClose(closing),
    findings: closing.findings,
    because: closing.because,
    confinement: closing.confinement,
    leftNotReviewed: closing.leftNotReviewed,
  });
  return postSummary(closing.pullRequest, body, call);
}

/**
 * What became of the summary of an episode that closed before any round ran,
 * with none of the reviewer's threads on the pull request.
 *
 * There is nothing for a comment to report, so none is composed. The close still
 * says why there is none: it exits 0, where silence reads as a review that went
 * fine.
 */
export const closedBeforeAnyRound: EpisodeSummary = {
  outcome: "never-composed",
  reason: "the episode closed before any round ran",
};
