/**
 * The task prompt the reviewer is handed each round: the pull request under
 * review, the threads already on it, and at `deep` what its tools are for.
 *
 * It sits above the adapters rather than inside one. Every adapter hands its
 * CLI the same prompt, so a second reviewer is a second command line and not a
 * second prompt.
 *
 * The test command is carried here because the prompt is the only channel a
 * project's own text reaches the reviewer through. The command line the adapter
 * builds is flags and tool names.
 *
 * Three things are deliberately absent. The charter reaches the reviewer
 * separately and is the same every round, so nothing here restates it.
 * `AGENTS.md` and `CLAUDE.md` are not carried, because the reviewer's CLI
 * discovers and loads both itself and a second copy goes stale. Nothing names
 * the round or what happened in an earlier one: each round is a fresh process,
 * and the threads are the whole of what it knows about the rounds before it.
 */

import type { Depth } from "../config/config.ts";
import type { PullRequest } from "../github/pull-request.ts";
import type { ReviewThread, ThreadComment } from "../github/threads.ts";

/** What the reviewer is told about the change it is reading. */
export type UnderReview = {
  readonly pullRequest: PullRequest;
  /** The diff GitHub served for it. */
  readonly diff: string;
  /**
   * Every thread of this review already on the pull request.
   *
   * Empty where the reviewer has opened none yet. It is the only thing deciding
   * whether a verdict is asked for, so a round number beside it is a second
   * answer that can disagree.
   */
  readonly threads: readonly ReviewThread[];
};

/**
 * The configured test command, and the depth that decides whether the reviewer
 * hears of it. Only `deep` grants `run_tests`, and a command named to a reviewer
 * with no way to run it invites a finding that the tests fail.
 */
export type TestCommand = {
  readonly depth: Depth;
  /** What the project configured, or `null` where it configured nothing. */
  readonly command: string | null;
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
export function composePrompt(underReview: UnderReview, tests: TestCommand): string {
  const { pullRequest, diff, threads } = underReview;
  return [
    `# Review pull request #${pullRequest.number}`,
    `Head \`${pullRequest.headRef}\`, base \`${pullRequest.baseRef}\`.`,
    "## Description",
    described(pullRequest.description),
    ...toolSection(tests),
    "## Diff",
    block(diff, "diff"),
    ...threadSections(threads),
  ].join("\n\n");
}

/**
 * What the `deep` tools are for, or nothing at `read`, where none is granted.
 *
 * The reviewer is told to call `run_tests` and is shown the command it runs, so
 * it knows what the call ran. It is not told to run the command itself: it has
 * no shell, and a command it cannot run is one it can only describe.
 *
 * The command is text the project wrote, so it is fenced like the diff: what it
 * carries cannot close the block and read as a section of the prompt's own.
 */
function toolSection(tests: TestCommand): readonly string[] {
  if (tests.depth !== "deep") return [];
  const command = tests.command?.trim() ?? "";
  // A command of nothing but space names no command, and a block holding it
  // would show the reviewer a blank line.
  const testing =
    command === ""
      ? ["No test command is configured, so `run_tests` has nothing to run."]
      : [
          "Call `run_tests` to run the tests. It takes no arguments, and runs the command the project configured, in the commit under review:",
          block(command, "sh"),
        ];
  return [
    "## Tests and history",
    ...testing,
    "Call `git_log_search`, `git_blame` and `git_show` to find out whether a line was meant: which commit wrote it, and what that commit said it was for.",
  ];
}

/**
 * The threads and the one instruction that goes with them, or nothing at all.
 *
 * A prompt that carried the heading with no threads under it would ask the
 * reviewer to rule on an empty list.
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
  return `${state}. On ${locationOf(thread)}.`;
}

/**
 * The code a thread was opened against.
 *
 * A thread about a line GitHub named no line for is still about that line, and
 * telling the reviewer it is about the file asks for a verdict on the wrong
 * thing.
 *
 * The reviewer reads this and the coding agent reads the thread listing, about
 * the same thread, so the two keep these three cases apart the same way.
 */
function locationOf(thread: ReviewThread): string {
  const { anchor } = thread;
  switch (anchor.at) {
    case "line":
      return `\`${thread.path}\` line ${anchor.line}`;
    case "file":
      return `\`${thread.path}\` as a whole`;
    case "unnamed-line":
      return `\`${thread.path}\`, line unknown`;
    default: {
      // An anchor case none of the above names. `anchor` is `never` only
      // while those three are all there is, so a fourth stops this compiling.
      const unhandled: never = anchor;
      return unhandled;
    }
  }
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
