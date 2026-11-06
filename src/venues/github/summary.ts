/**
 * The comments the harness posts on the pull request itself, on no line of it:
 * the episode's summary and a failed round's failure comment.
 *
 * An issue-level comment and a review comment are different endpoints and
 * different objects. A summary posted as a review comment answers 201 and
 * appears on the pull request all the same, anchored to a line and sitting
 * among the threads a round resolves.
 *
 * Nothing here composes what a comment says. The body arrives written.
 */

import { callRest, type GhCall } from "./gh.ts";

/** What posting established. `failed` carries the one line the caller reports. */
export type CommentPosting =
  | { readonly outcome: "posted" }
  | { readonly outcome: "failed"; readonly reason: string };

/** Post `body` as the episode's summary on `pullRequest`, as `postIssueComment` does. */
export function postSummary(pullRequest: number, body: string, call: GhCall): CommentPosting {
  return postIssueComment(pullRequest, body, call, "the summary");
}

/**
 * Post `body` as an issue-level comment on `pullRequest`, from `call.directory`.
 * `named` is what the comment is called in a reason, such as "the summary".
 *
 * The body is carried verbatim, and has to be: a comment posted here is never
 * edited or replaced, so whatever is mangled here is permanent.
 *
 * Never throws, and never retries. A `gh` that could not run, a call that reached
 * its bound, and a status that is not a success all come back as `failed`.
 */
export function postIssueComment(
  pullRequest: number,
  body: string,
  call: GhCall,
  named: string,
): CommentPosting {
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
  // that posted, and nothing posts it a second time.
  if (answer.httpStatus < 200 || answer.httpStatus >= 300) {
    return {
      outcome: "failed",
      reason: `gh answered HTTP ${answer.httpStatus} without posting ${named}`,
    };
  }
  return { outcome: "posted" };
}
