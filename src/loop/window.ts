/**
 * The window a round runs inside, and the shares it is divided into.
 *
 * The ceiling is the runtime's rather than the harness's. At it the hook is
 * cancelled with nothing posted and the subagent is recorded as failed, so every
 * share here exists to keep a round below it, and none of them is a bound
 * anything outside the round honours.
 *
 * The ceiling is stated here because nothing at runtime can read it from the
 * registration. The registration declares the same number as the hook's own
 * timeout, and a test holds the two together.
 */

/** The whole window a round has, in milliseconds. */
export const HOOK_CEILING_MS = 600_000;

/**
 * What the round keeps at the end of the window to put the review on the pull
 * request.
 *
 * Every call the round makes after the review runs under it as a shared
 * deadline, because how many calls the posting makes is not known in advance:
 * one finding is a create and up to twenty pages of read-back, and a bound per
 * call would let each of those pages have the whole of one.
 */
export const POSTING_MARGIN_MS = 120_000;

/**
 * What the round has for the calls it makes before the reviewer starts: the pull
 * request lookup, the threads listing and the diff.
 *
 * Far more than those three need and far less than a review does. What the phase
 * spends comes off the reviewer's own bound rather than off the posting margin,
 * so a slow GitHub shortens the review instead of pushing the round past the
 * ceiling.
 */
export const PRE_REVIEW_MARGIN_MS = 60_000;
