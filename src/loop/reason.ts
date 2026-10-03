/**
 * The blocking reason: the text a round that exits 2 hands the coding agent.
 *
 * Every number and every thread in it is computed from the values the round
 * read back. The agent's defence against a message like this one is to check it
 * against the pull request, so a count that is not computed, a sentence that
 * asserts authority, and any claim to be authorised each give it a reason to
 * refuse rather than to look.
 *
 * Nothing here writes anything. The hook's other stderr channel, the failure
 * pointer a round exits 0 with, does not come through here.
 */

import { threadLocation, type ReviewThread } from "../github/threads.ts";

/** What the round established, which is the whole of what the reason asserts. */
export type BlockedRound = {
  /** The pull request the round gated on, and the one it posted to. */
  readonly pullRequest: number;
  /**
   * The threads this round's findings opened, by id.
   *
   * The reason gives how many there are rather than listing them, and takes the
   * list so that the number is the length of something that exists instead of a
   * figure handed in beside it.
   */
  readonly posted: readonly string[];
  /**
   * Every thread of this review as the round last read it, resolved ones
   * included.
   *
   * The unresolved ones are what the reason names, filtered here rather than by
   * the caller: `squiz threads` filters resolved threads out the same way, so a
   * thread the agent is told is open is one the command it checks with prints.
   */
  readonly threads: readonly ReviewThread[];
  /**
   * The move of `HEAD` this round's comparison found, naming both ends, and
   * absent where it found none.
   *
   * Told to the coding agent here because the next firing gates on the branch
   * `HEAD` names then. Where that branch has no pull request, nothing reports the
   * move afterwards.
   */
  readonly moved?: string | undefined;
};

/**
 * The ask, in the words a coding agent replied under.
 *
 * An invitation rather than an order: the same reason worded as an order
 * produced the same code fixes and no replies at all.
 */
const ASK = "Address what applies, reply on anything you disagree with, then finish.";

// `<id>` is the identifier each thread is listed with, which is what `squiz
// reply` takes back.
const COMMANDS = [
  "The commands that work them:",
  "  squiz threads",
  "  squiz reply <id> <text>",
].join("\n");

/**
 * The reason for `round`, newline included.
 *
 * Composed from the round's own values, so a caller has no seam to put a claim
 * through: nothing it passes can make the reason name a thread that is not in
 * `threads`, or give a count of something it did not hand over.
 */
export function blockingReason(round: BlockedRound): string {
  const open = round.threads.filter((thread) => !thread.isResolved);
  const blocks = [reviewed(round.pullRequest, round.posted.length)];

  if (open.length === 0) {
    // A round with nothing open does not block, so there is nothing to ask for
    // and no command to name. Said plainly rather than left out, because a
    // reason that names no thread must not read as one whose threads went
    // missing.
    blocks.push("No threads are open on it.");
  } else {
    blocks.push(openThreads(open), COMMANDS, ASK);
  }
  // Last, so that "on it" above still follows the line naming the pull request.
  if (round.moved !== undefined) blocks.push(movedHead(round.moved));

  return `${blocks.join("\n\n")}\n`;
}

/** What the round did: a review, and the comments it left. */
function reviewed(pullRequest: number, posted: number): string {
  // The zero case says "new", because the threads an earlier round opened can
  // be open beside it.
  const left = posted === 0 ? "left no new comments" : `left ${counted(posted, "comment")}`;
  return `Squiz reviewed the change on this branch and ${left} on PR #${pullRequest}.`;
}

/** What became of `HEAD` while the reviewer ran, and what the next round does with it. */
function movedHead(moved: string): string {
  return [
    `\`HEAD\` moved while the reviewer ran: ${moved}.`,
    "Squiz did not move it back.",
    "The next round reviews the branch `HEAD` is on when it starts, and only where that branch has a pull request.",
  ].join(" ");
}

/**
 * The open threads, one per line, each behind its identifier.
 *
 * The identifier is written as it arrived, undecorated and unwrapped: it is
 * what the agent copies into `squiz reply`, and a backtick or a quote around it
 * is a character that command does not take.
 *
 * One thread is one line. A path holding a newline would otherwise put a line
 * in the reason that the round did not write, so the whitespace of each line is
 * collapsed after it is composed. An identifier holds none, and survives.
 */
function openThreads(open: readonly ReviewThread[]): string {
  const verb = open.length === 1 ? "is" : "are";
  const heading = `${counted(open.length, "thread")} ${verb} open on it:`;
  const lines = open.map((thread) =>
    `${thread.id} ${threadLocation(thread)}`.replace(/\s+/gu, " ").trim(),
  );
  return [heading, ...lines].join("\n");
}

/** How many of `thing` there are, the plural agreeing with the number. */
function counted(howMany: number, thing: string): string {
  return `${howMany} ${thing}${howMany === 1 ? "" : "s"}`;
}
