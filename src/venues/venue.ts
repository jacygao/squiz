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
import { localVenue } from "./local/venue.ts";
import type { Anchor } from "./github/post-thread.ts";
import type { CommentPosting } from "./github/summary.ts";
import type { ThreadAction } from "./github/thread-actions.ts";
import type { ReviewThread, ThreadAnchor, ThreadComment } from "./github/threads.ts";

/** The change under review. */
export type Change = {
  /** What names the episode across processes: "41", or "local". */
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
   * Called when a session or a subagent starts in `worktree`, before it has
   * done any work. A venue that needs nothing from the start returns "done".
   */
  recordStart(worktree: string, until: Deadline): { readonly outcome: "done" } | Failed;
  /**
   * The change to review in `worktree`. `asked` is the key a command was given,
   * such as the 41 of `squiz review 41` or `squiz host 41`, or null for a hook,
   * which finds the change from the worktree alone.
   */
  readChange(worktree: string, asked: string | null, until: Deadline): ChangeLookup;
  /**
   * The episode's directory for `key` in `worktree`, found from the key alone,
   * before any change is read. Every process that names the episode calls it,
   * so the hook, the round host and the commands reach one directory.
   */
  episodeDirectory(
    worktree: string,
    key: string,
  ): { readonly outcome: "found"; readonly directory: string } | Failed;
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
 * The venue this process's environment chooses from `SQUIZ_VENUE`: GitHub where
 * it is unset, empty or `github`, and local where it is `local`.
 *
 * Any other value chooses none, rather than having GitHub review a change that
 * was meant to stay off it.
 */
export function venueFor(
  environment: NodeJS.ProcessEnv,
): { readonly outcome: "chosen"; readonly venue: Venue } | Failed {
  const named = venueNamed(environment);
  if (typeof named !== "string") return named;
  return { outcome: "chosen", venue: named === "local" ? localVenue : githubVenue };
}

/** The name of the venue `venueFor` chooses, for `squiz doctor` to print. */
export function venueNamed(environment: NodeJS.ProcessEnv): "github" | "local" | Failed {
  const named = environment["SQUIZ_VENUE"];
  if (named === undefined || named === "" || named === "github") return "github";
  if (named === "local") return "local";
  return { outcome: "failed", reason: `SQUIZ_VENUE is ${JSON.stringify(named)}, and squiz has the venues github and local` };
}
