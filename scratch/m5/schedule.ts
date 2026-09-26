/**
 * The three shares a round divides its window into.
 *
 * Scratch work for exercising the review harness. Nothing imports this file and
 * nothing here is meant to ship.
 */

import {
  HOOK_CEILING_MS,
  POSTING_MARGIN_MS,
  PRE_REVIEW_MARGIN_MS,
} from "../../src/loop/window.ts";

/** How long each of a round's three phases gets, in milliseconds. */
export type Shares = {
  /** The pull request lookup, the threads listing and the diff. */
  readonly beforeReview: number;
  /** The reviewer. */
  readonly review: number;
  /** The findings, the verdicts and the summary comment. */
  readonly posting: number;
};

/**
 * The shares a round gets out of a window of `windowMs`.
 *
 * The three shares add up to the whole window: the review gets what is left
 * once the calls before it and the posting margin have been taken out.
 */
export function sharesOf(windowMs: number = HOOK_CEILING_MS): Shares {
  const beforeReview = Math.min(PRE_REVIEW_MARGIN_MS, windowMs);
  const posting = Math.min(POSTING_MARGIN_MS, windowMs - beforeReview);
  return {
    beforeReview,
    posting,
    review: windowMs - beforeReview - posting - POSTING_MARGIN_MS,
  };
}

/**
 * How long the reviewer may run, in whole seconds: what the project configured,
 * or the review's own share, whichever is smaller.
 */
export function reviewSeconds(configuredSeconds: number, shares: Shares): number {
  return Math.min(configuredSeconds, Math.floor(shares.review / 1_000));
}

/**
 * Whether a window of `windowMs` leaves the reviewer any time at all.
 *
 * A round with nothing left to review in starts no reviewer, because a reviewer
 * killed the moment it starts spends a round of the cap on a review nobody
 * could have done.
 */
export function leavesTimeToReview(windowMs: number): boolean {
  return reviewSeconds(Number.MAX_SAFE_INTEGER, sharesOf(windowMs)) >= 1;
}
