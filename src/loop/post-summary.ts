/**
 * The episode's summary comment: composed from what the closing round holds, and
 * posted once.
 *
 * **The comment is the episode's close and not a round's.** Only a round that
 * closed the episode reaches here. A round that blocks posts nothing, or the pull
 * request would carry a report of the review for every firing of the hook while
 * it was still going on.
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
import { postSummary, type SummaryPosting } from "../github/summary.ts";
import type { ReviewThread } from "../github/threads.ts";
import type { RoundCost } from "../reviewers/adapter.ts";
import { classifyAtClose } from "./classify.ts";
import type { PostedFindings } from "./post-findings.ts";
import type { ClosingReason } from "./round-decision.ts";
import type { AppliedVerdicts } from "./verdicts.ts";

/** What the round that closed the episode holds of it, which is the whole of it. */
export type ClosingRound = {
  readonly pullRequest: number;
  /**
   * What each round of the episode spent, in the order the rounds ran, this round
   * included. Read from the episode's state file, which is the only thing that
   * carries a round's cost past the round.
   */
  readonly rounds: readonly RoundCost[];
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
};

/**
 * Compose the summary for `closing` and post it on the pull request, once.
 *
 * `call.until` is the round's posting margin, and the call is not made at all
 * where nothing is left of it: a call made past the end of the window is one the
 * runtime kills the hook during, and the round would then end having said nothing
 * at all. The summary is lost in that case, which is what the caller reports.
 */
export function postEpisodeSummary(closing: ClosingRound, call: GhCall): SummaryPosting {
  const body = renderSummary({
    rounds: closing.rounds,
    threads: classifyAtClose(closing),
    findings: closing.findings,
    because: closing.because,
  });
  return postSummary(closing.pullRequest, body, call);
}
