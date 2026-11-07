/**
 * The venue: where a review happens. It supplies the change under review, holds
 * the threads, and takes the summary and the failure comment.
 *
 * Every venue meets this one interface, so nothing outside a venue asks which
 * venue it has. No member throws: each failure is an outcome carrying one line
 * of reason, and a call whose deadline has nothing left is not made.
 */

import type { Deadline } from "../reviewers/deadline.ts";
import { githubVenue } from "./github/venue.ts";
import type { Anchor } from "./github/post-thread.ts";
import type { CommentPosting } from "./github/summary.ts";
import type { ThreadAction } from "./github/thread-actions.ts";
import type { ReviewThread, ThreadAnchor, ThreadComment } from "./github/threads.ts";

/** The change under review. */
export type Change = {
  /** What names the episode across processes: "41", or the local directory. */
  readonly key: string;
  /** What every message calls it: "PR #41", or "the working tree". */
  readonly name: string;
  /** The command that reviews it again, from anywhere: "squiz review 41", or "cd '/work/squiz-a' && squiz review". */
  readonly rerun: string;
  /**
   * The paragraph after the open threads, in a note and in `squiz review`'s
   * output: what to fix, how to reply, and what to run next.
   */
  readonly followUp: string;
  /** Full shas. */
  readonly base: string;
  readonly head: string;
  readonly description: string;
};

export type Failed = { readonly outcome: "failed"; readonly reason: string };

export type ChangeLookup =
  | { readonly outcome: "found"; readonly change: Change }
  /** Nothing to review yet, and nothing wrong: the line `squiz review` prints before it exits 0. */
  | { readonly outcome: "held"; readonly line: string }
  /** Nothing this venue can review here: the line `squiz review` exits 1 with. */
  | { readonly outcome: "none"; readonly reason: string }
  | Failed;

export type { Anchor, ReviewThread, ThreadAction, ThreadAnchor, ThreadComment };

/**
 * What became of a new thread. `anchor-refused` is a line the venue cannot
 * hold, and `posted-without-thread-id` a comment that landed whose thread's id
 * could not be read back. Ids are the issuing venue's own opaque strings.
 */
export type ThreadPosting =
  | {
      readonly outcome: "posted";
      readonly threadId: string;
      readonly commentId: string;
      readonly url: string;
    }
  | {
      readonly outcome: "posted-without-thread-id";
      readonly reason: string;
      readonly commentId: string;
      readonly url: string;
    }
  | { readonly outcome: "anchor-refused"; readonly reason: string }
  | Failed;

/** What became of a summary or a failure comment. */
export type Posting = CommentPosting;

export interface Venue {
  /**
   * The change to review in `worktree`. `asked` is the key a command was given,
   * such as the 41 of `squiz review 41` or `squiz host 41`, or null for a hook,
   * which finds the change from the worktree alone.
   */
  readChange(worktree: string, asked: string | null, until: Deadline): ChangeLookup;
  episodeDirectory(change: Change): string;
  /** Extra object directories the snapshot borrows from, once base and head are readable. */
  provideCommits(
    change: Change,
    until: Deadline,
  ): { readonly outcome: "ready"; readonly alternates: readonly string[] } | Failed;
  listThreads(
    change: Change,
    until: Deadline,
  ): { readonly outcome: "listed"; readonly threads: readonly ReviewThread[] } | Failed;
  openThread(change: Change, anchor: Anchor, body: string, until: Deadline): ThreadPosting;
  openFileThread(change: Change, path: string, body: string, until: Deadline): ThreadPosting;
  reply(threadId: string, body: string, until: Deadline): ThreadAction;
  resolve(threadId: string, until: Deadline): ThreadAction;
  reopen(threadId: string, until: Deadline): ThreadAction;
  postSummary(change: Change, body: string, until: Deadline): Posting;
  postFailure(change: Change, body: string, until: Deadline): Posting;
}

/**
 * The venue this process's environment chooses: local where `SQUIZ_LOCAL` is
 * set to anything but the empty string, and GitHub otherwise.
 *
 * A `SQUIZ_LOCAL` no local venue takes fails, rather than having GitHub review
 * a change that was meant to stay off it.
 */
export function venueFor(
  environment: NodeJS.ProcessEnv,
): { readonly outcome: "chosen"; readonly venue: Venue } | Failed {
  const local = environment["SQUIZ_LOCAL"];
  if (local !== undefined && local !== "") {
    return { outcome: "failed", reason: `SQUIZ_LOCAL is ${JSON.stringify(local)}, and this squiz has no local venue` };
  }
  return { outcome: "chosen", venue: githubVenue };
}
