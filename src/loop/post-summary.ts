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
import type { EpisodeState } from "./episode-state.ts";
import type { PostedFindings } from "./post-findings.ts";
import type { ClosingReason } from "./round-decision.ts";
import type { AppliedVerdicts } from "./verdicts.ts";

/**
 * What became of the episode's summary comment, which every close says.
 *
 * Three answers and no fourth. A close that could say nothing about its summary is
 * a close that reports no comment and no reason for there being none, and exit 0
 * then reads as a review that ended clean.
 */
export type EpisodeSummary =
  | SummaryPosting
  /**
   * Nothing was composed and nothing ever will be, so the episode ends with no
   * summary on the pull request at all. `reason` is the one line that says so.
   */
  | { readonly outcome: "never-composed"; readonly reason: string };

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

/**
 * What became of the summary of an episode closed before its review ran.
 *
 * No comment is composed on that close and none is attempted. The firing runs no
 * reviewer and lists none of the episode's threads, so a comment written from what
 * it holds would report an episode that raised nothing.
 *
 * The episode ends here with nothing on the pull request reporting it, and the
 * rounds it ran say what that costs. Rounds ran means findings are up there with
 * no comment counting them, and a person is told so that they go and read the
 * threads. No round at all means there was nothing to report in the first place.
 * Both are closes at exit 0, where silence reads as a review that went fine.
 */
export function summaryNotComposed(state: EpisodeState): EpisodeSummary {
  const rounds = state.rounds.length;
  if (rounds === 0) {
    return { outcome: "never-composed", reason: "no round of the episode ever ran" };
  }
  return {
    outcome: "never-composed",
    reason: `the bound was spent before this firing listed the episode's threads, and nothing reports the ${counted(rounds)} it ran`,
  };
}

/** How many rounds, the plural agreeing with the number. */
function counted(rounds: number): string {
  return `${rounds} ${rounds === 1 ? "round" : "rounds"}`;
}
