/**
 * The venue: where a review happens. It supplies the change under review, holds
 * the threads, and takes the summary and the failure comment.
 *
 * Every venue meets this one interface, so nothing outside a venue asks which
 * venue it has. No member throws: each failure is an outcome carrying one line
 * of reason, and a call whose deadline has nothing left is not made.
 */

import { findProjectConfig, type Config, type ProjectConfig } from "../config/config.ts";
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
  /** The command that reviews it again, from anywhere: "squiz review 41", or "(cd '/work/squiz-a' && squiz review)". */
  readonly rerun: string;
  /** Where the summary is, as a message says it: "on the pull request", or "in /work/squiz-a/.squiz/local/summary.md". */
  readonly summaryAt: string;
  /**
   * The paragraph after the open threads, in a note and in `squiz review`'s
   * output: what to fix, how to reply, and what to run next.
   */
  readonly followUp: string;
  /** Full shas. */
  readonly base: string;
  readonly head: string;
  readonly description: string;
  /**
   * The commit this worktree pushed to the change that the venue does not yet
   * report as its head, as GitHub does for a few seconds after a push. Absent
   * where the venue reports what was pushed, or cannot be compared with it.
   */
  readonly unreported?: string;
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

/** The venue `config` names. */
export function venueFor(config: Pick<Config, "venue">): Venue {
  return config.venue === "local" ? localVenue : githubVenue;
}

/**
 * The venue the `.squiz.json` of `directory`'s main worktree names, with the
 * settings it was read from. A file that cannot be read fails, rather than
 * choosing GitHub for a project that may have chosen local.
 */
export function venueAt(
  directory: string,
  until?: Deadline,
): { readonly outcome: "chosen"; readonly venue: Venue; readonly project: ProjectConfig } | Failed {
  let project: ProjectConfig;
  try {
    project = findProjectConfig(directory, until);
  } catch (cause) {
    return { outcome: "failed", reason: cause instanceof Error ? cause.message : String(cause) };
  }
  return { outcome: "chosen", venue: venueFor(project.config), project };
}
