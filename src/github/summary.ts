/**
 * The episode's summary: one comment on the pull request itself, on no line of
 * it.
 *
 * An issue-level comment and a review comment are different endpoints and
 * different objects. A summary posted as a review comment answers 201 and
 * appears on the pull request all the same, anchored to a line and sitting
 * among the threads a round resolves.
 *
 * Nothing here composes what the summary says. The body arrives written.
 */

import { callRest, type GhCall } from "./gh.ts";

/** What posting established. `failed` carries the one line the caller reports. */
export type SummaryPosting =
  | { readonly outcome: "posted" }
  | { readonly outcome: "failed"; readonly reason: string };

/**
 * Post `body` as an issue-level comment on `pullRequest`, from `call.directory`.
 *
 * The body is carried verbatim, and has to be: the comment is posted once when
 * the episode closes and is never edited or replaced, so whatever is mangled
 * here is permanent for that episode.
 *
 * Never throws. A `gh` that could not run, a call that reached its bound, and a
 * status that is not a success all come back as `failed`.
 */
export function postSummary(pullRequest: number, body: string, call: GhCall): SummaryPosting {
  const answer = callRest(
    {
      // A pull request's number in the `issues/` path is what makes this a
      // comment on the pull request rather than on a line of its diff.
      path: `repos/{owner}/{repo}/issues/${pullRequest}/comments`,
      method: "POST",
      // The body and nothing else. A `path` or a `line` alongside it is what a
      // review comment carries, and this endpoint is not that one.
      body: { body },
    },
    call,
  );

  if (answer.outcome !== "answered") return { outcome: "failed", reason: answer.reason };
  // A `gh` that exits 0 on an error status would otherwise read as a comment
  // that posted, and nothing posts the summary a second time.
  if (answer.httpStatus < 200 || answer.httpStatus >= 300) {
    return {
      outcome: "failed",
      reason: `gh answered HTTP ${answer.httpStatus} without posting the summary`,
    };
  }
  return { outcome: "posted" };
}
