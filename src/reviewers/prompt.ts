/**
 * The task prompt the reviewer is handed each round: the pull request under
 * review, and the threads already on it.
 *
 * It sits above the adapters rather than inside one. Every adapter hands its
 * CLI the same prompt, so a second reviewer is a second command line and not a
 * second prompt.
 *
 * Three things are deliberately absent. The charter reaches the reviewer
 * separately and is the same every round, so nothing here restates it.
 * `AGENTS.md` and `CLAUDE.md` are not carried, because the reviewer's CLI
 * discovers and loads both itself and a second copy goes stale. Nothing names
 * the round or what happened in an earlier one: each round is a fresh process,
 * and the threads are the whole of what it knows about the rounds before it.
 */

import type { PullRequest } from "../github/pull-request.ts";
import type { ReviewThread, ThreadComment } from "../github/threads.ts";

/** What the reviewer is told about the change it is reading. */
export type UnderReview = {
  readonly pullRequest: PullRequest;
  /** The diff GitHub served for it. */
  readonly diff: string;
  /**
   * Every review thread already on the pull request.
   *
   * Empty is round 1. It is the only thing deciding whether a verdict is asked
   * for, so a round number beside it is a second answer that can disagree.
   */
  readonly threads: readonly ReviewThread[];
};

/**
 * The prompt for one round.
 *
 * Each thread is written under its own identifier, which is what a verdict
 * names. Numbering the threads, or shortening an identifier, would take the
 * verdict back against a position in a list instead: the harness would then
 * apply it to whatever thread now holds that position, and nothing downstream
 * would notice.
 *
 * Never throws, and refuses nothing. A field that arrived empty is carried as
 * it is, because a round with a thin description is still a round to review.
 */
export function composePrompt(underReview: UnderReview): string {
  const { pullRequest, diff, threads } = underReview;
  return [
    `# Review pull request #${pullRequest.number}`,
    `Head \`${pullRequest.headRef}\`, base \`${pullRequest.baseRef}\`.`,
    "## Description",
    described(pullRequest.description),
    "## Diff",
    block(diff, "diff"),
    ...threadSections(threads),
  ].join("\n\n");
}

/**
 * The threads and the one instruction that goes with them, or nothing at all.
 *
 * A prompt that carried the heading with no threads under it would ask a
 * round-1 reviewer to rule on an empty list.
 */
function threadSections(threads: readonly ReviewThread[]): readonly string[] {
  if (threads.length === 0) return [];
  return [
    "## Threads already on this pull request",
    "Return a verdict on every thread below, naming each one by the identifier in its heading.",
    ...threads.map(threadSection),
  ];
}

function threadSection(thread: ReviewThread): string {
  return [`### ${thread.id}`, where(thread), ...thread.comments.map(commentBlock)].join("\n\n");
}

/** Whether the thread is resolved, and the code it was opened against. */
function where(thread: ReviewThread): string {
  const state = thread.isResolved ? "Resolved" : "Not resolved";
  // Null is a thread on the file as a whole, never a line to go looking for.
  const at =
    thread.line === null
      ? `\`${thread.path}\` as a whole`
      : `\`${thread.path}\` line ${thread.line}`;
  return `${state}. On ${at}.`;
}

/** One comment, said by whoever wrote it. The first opened the thread. */
function commentBlock(comment: ThreadComment, index: number): string {
  // Null is an account that is gone, never an anonymous comment.
  const who = comment.author ?? "a deleted account";
  const said = index === 0 ? `${who} opened the thread:` : `${who} replied:`;
  return `${said}\n\n${block(comment.body, "")}`;
}

/** An empty description is a pull request nobody described, and is said so. */
function described(description: string): string {
  if (description.trim() === "") return "The pull request has no description.";
  return block(description, "");
}

/**
 * Text fenced so that it cannot be read as part of the prompt around it.
 *
 * A diff of a markdown file carries fences of its own, and a comment body is
 * markdown a person or an agent wrote. Either could otherwise close its block
 * early and leave the rest reading as a heading of the prompt's own — as a
 * thread, say, that no verdict can be applied to.
 */
function block(content: string, info: string): string {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(content) + 1));
  return `${fence}${info}\n${content.replace(/\n+$/u, "")}\n${fence}`;
}

function longestBacktickRun(content: string): number {
  let longest = 0;
  for (const run of content.matchAll(/`+/gu)) longest = Math.max(longest, run[0].length);
  return longest;
}
