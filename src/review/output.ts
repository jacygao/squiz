/**
 * What `squiz review` prints for a result, and the copy of it in
 * `.squiz/<number>/review.txt`.
 *
 * Nothing here runs a review or waits for one. The caller hands over a value
 * describing the result, and gets back the status, the stdout and the stderr to
 * end the run with.
 *
 * stdout carries the outcome and stderr carries what failed. Every number and
 * every thread printed is computed from what the caller hands over, which is
 * what the round read back from the pull request, so the coding agent can check
 * each one there.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { threadLine } from "../findings/listing.ts";
import type { ReviewThread } from "../github/threads.ts";
import { failureLine } from "../hook/report.ts";

/** What closed an episode short of a clean review. */
export type Bound = "round cap" | "token bound";

/** What every result names, whatever it came to. */
type About = {
  readonly pullRequest: number;
  /**
   * Lines for what failed without changing the outcome, such as a summary that
   * could not be posted. Each goes on stderr, and the status stands.
   */
  readonly problems?: readonly string[];
};

/** A round's result: the state it reviewed, and what it left open. */
type RoundResult = About & {
  readonly outcome: "reviewed";
  /** The head commit the round reviewed, as printed. */
  readonly commit: string;
  readonly round: number;
  readonly cap: number;
  /** How many threads the round's findings opened. */
  readonly newFindings: number;
  /** The review's threads as they stand on the pull request now, resolved ones included. */
  readonly threads: readonly ReviewThread[];
  /** True where the run was handed a result already recorded rather than producing it. */
  readonly recorded: boolean;
};

/** The move of `HEAD` the round's comparison found, as "from … to …". */
type Moved = { readonly moved?: string | undefined };

type Open = RoundResult & Moved & { readonly exit: 2 };

type Clean = RoundResult & {
  readonly exit: 0;
  /** The run's own state, which the close left unreviewed, and what closed the episode. */
  readonly notReviewed?: NotReviewed | undefined;
};

/**
 * A state the close left unreviewed. `state` is how it is printed: its short
 * head commit, with how its replies differ where it shares a head with a state
 * before it, as `namedStates` names it.
 */
type NotReviewed = { readonly state: string; readonly closedAt: Bound };

type ClosedOpen = RoundResult &
  Moved & {
    readonly exit: 3;
    readonly closedAt: Bound;
    /** The run's own state, which the close left unreviewed. */
    readonly notReviewed?: Pick<NotReviewed, "state"> | undefined;
  };

/**
 * A run whose deadline came before its result, exit 4.
 *
 * - `under review`: the round of the run's own state is running.
 * - `queued`: the run's state waits behind the round of `reviewing`.
 * - `clean`: the run's state was reviewed clean, and `reviewing` was queued
 *   behind it, so the episode has not closed.
 * - `superseded`: the pull request moved on to `reviewing` before a round took
 *   the run's state.
 */
type StillReviewing = About & { readonly outcome: "reviewing" } & (
    | { readonly wait: "under review"; readonly commit: string }
    | { readonly wait: "queued" | "clean" | "superseded"; readonly commit: string; readonly reviewing: string }
  );

/** A run on an episode whose close is already recorded, exiting as the close did. */
type AlreadyClosed = About & {
  readonly outcome: "closed";
  readonly exit: 0 | 3;
  readonly rounds: number;
  readonly threads: readonly ReviewThread[];
};

/** A round that failed, exit 1, with what its failure comment says and where it went. */
type Failed = About & {
  readonly outcome: "failed";
  readonly reason: string;
  /** What else the round established, each an item of the failure comment's list. */
  readonly items: readonly string[];
  /** Absent where the items already say where the comment went, or none was attempted. */
  readonly comment?: { readonly posted: true } | { readonly posted: false; readonly reason: string };
};

/** A run that failed before any round, exit 1. */
type NotRun = About & { readonly outcome: "not run"; readonly reason: string };

/** A round whose findings could not be posted, exit 1. */
type Unposted = About & {
  readonly outcome: "unposted";
  readonly round: number;
  readonly findings: number;
};

export type ReviewResult =
  | Open
  | Clean
  | ClosedOpen
  | StillReviewing
  | AlreadyClosed
  | Failed
  | NotRun
  | Unposted;

/** What the run ends with. `stderr` is whole lines, newlines included, or empty. */
export type Printed = {
  readonly exit: 0 | 1 | 2 | 3 | 4;
  readonly stdout: string;
  readonly stderr: string;
};

/** Where the output of a review of `pullRequest` is kept, as an absolute path. */
export function reviewOutputPath(worktree: string, pullRequest: number): string {
  return resolve(worktree, ".squiz", String(pullRequest), "review.txt");
}

/**
 * Compose the output for `result`, and write its stdout to the review's output
 * file in `worktree`, replacing what was there.
 *
 * A run that exits 1 prints nothing on stdout and writes no file. A write that
 * fails adds a line on stderr and changes nothing else: the outcome stands, and
 * it is printed whole on stdout either way.
 */
export function printReview(result: ReviewResult, worktree: string): Printed {
  const path = reviewOutputPath(worktree, result.pullRequest);
  const printed = composeReview(result, path);
  if (printed.exit === 1) return printed;

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, printed.stdout);
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error);
    return {
      ...printed,
      stderr: printed.stderr + failureLine(`the output could not be written to ${path}: ${said}`),
    };
  }
  return printed;
}

/** The output for `result`, its first line naming `path` as the file that holds it. */
export function composeReview(result: ReviewResult, path: string): Printed {
  const problems = (result.problems ?? []).map(failureLine).join("");
  switch (result.outcome) {
    case "reviewed":
      return { exit: result.exit, stdout: printedAt(path, roundBlocks(result)), stderr: problems };
    case "reviewing":
      return { exit: 4, stdout: printedAt(path, [stillReviewing(result)]), stderr: problems };
    case "closed":
      return { exit: result.exit, stdout: printedAt(path, closedBlocks(result)), stderr: problems };
    case "failed":
      return { exit: 1, stdout: "", stderr: failedLines(result) + problems + NOT_AGAIN };
    case "not run":
      return { exit: 1, stdout: "", stderr: failureLine(`no review ran: ${result.reason}`) + problems + NOT_AGAIN };
    case "unposted":
      return { exit: 1, stdout: "", stderr: failureLine(unpostedLine(result)) + problems + NOT_AGAIN };
  }
}

// Running the command again after it could not run spends a round on the same
// failure, so a coding agent is told to stop and report instead.
const NOT_AGAIN = failureLine("put these lines in your report rather than running squiz review again");

/**
 * The output: the path line, then `blocks` set apart by blank lines.
 *
 * The path line says when to read the file because a coding agent's runtime can
 * cut a long output, and the first line is the part that always survives.
 */
function printedAt(path: string, blocks: readonly string[]): string {
  const [first = "", ...rest] = blocks;
  return `${[`Full output, to read where this is cut short: ${path}\n${first}`, ...rest].join("\n\n")}\n`;
}

function roundBlocks(result: Open | Clean | ClosedOpen): readonly string[] {
  const open = result.threads.filter((thread) => !thread.isResolved);
  const verb = result.recorded ? "already reviewed" : "reviewed";
  const findings =
    result.newFindings === 0 ? "no new findings" : counted(result.newFindings, "new finding");
  const heading = `Squiz ${verb} PR #${result.pullRequest} at ${result.commit}: round ${result.round} of ${result.cap}, ${findings}.`;

  switch (result.exit) {
    case 2:
      return [
        heading,
        `${counted(open.length, "thread")} ${open.length === 1 ? "is" : "are"} open:`,
        ...open.map(printedThread),
        [
          "Fix what applies, and reply on each thread with `squiz reply <id> <text>` to say",
          "what you changed or why you disagree. Commit and push what you changed, then run",
          `\`squiz review ${result.pullRequest}\` again.`,
        ].join("\n"),
        ...movedParagraph(result.moved),
      ];
    case 0:
      return [
        withNotReviewed(heading, result, result.notReviewed),
        "Nothing is open. The review is closed, and its summary is on the pull request.",
      ];
    case 3: {
      const unreviewed = result.notReviewed?.state;
      const notReviewed =
        unreviewed === undefined ? undefined : { state: unreviewed, closedAt: result.closedAt };
      return [
        withNotReviewed(heading, result, notReviewed),
        [
          `The ${result.closedAt} is reached. The review is closed with ${counted(open.length, "thread")} open, and its summary`,
          "is on the pull request. A person takes it from here, so do not run",
          `\`squiz review ${result.pullRequest}\` again.`,
        ].join("\n"),
        ...open.map(printedThread),
        ...movedParagraph(result.moved),
      ];
    }
  }
}

/** `heading`, followed where the close left the run's own state unreviewed by the line saying why. */
function withNotReviewed(
  heading: string,
  result: RoundResult,
  notReviewed: NotReviewed | undefined,
): string {
  if (notReviewed === undefined) return heading;
  const why = `the episode closed at the ${notReviewed.closedAt}, after reviewing ${result.commit}`;
  return `${heading}\nSquiz did not review PR #${result.pullRequest} at ${notReviewed.state}: ${why}.`;
}

function movedParagraph(moved: string | undefined): readonly string[] {
  if (moved === undefined) return [];
  return [
    `\`HEAD\` moved while the reviewer ran: ${moved}. The move was in the reviewer's snapshot, which is removed after the round, and the coding agent's worktree is as it was.`,
  ];
}

function stillReviewing(result: StillReviewing): string {
  const again = `Run \`squiz review ${result.pullRequest}\` again to wait for it.`;
  const pr = `PR #${result.pullRequest}`;
  switch (result.wait) {
    case "under review":
      return `Squiz is still reviewing ${pr} at ${result.commit}. ${again}`;
    case "queued":
      return `Squiz is reviewing ${pr} at ${result.reviewing} first, and ${result.commit} is next. ${again}`;
    case "clean":
      return `Squiz found nothing open in ${pr} at ${result.commit}, and is reviewing ${result.reviewing} before it closes the review. ${again}`;
    case "superseded":
      return `Squiz is reviewing ${pr} at ${result.reviewing} instead of ${result.commit}. ${again}`;
  }
}

function closedBlocks(result: AlreadyClosed): readonly string[] {
  const open = result.threads.filter((thread) => !thread.isResolved);
  const left = open.length === 0 ? "nothing open" : `${counted(open.length, "thread")} open`;
  return [
    `Squiz's review of PR #${result.pullRequest} closed after ${counted(result.rounds, "round")}, with ${left}. No round runs again in this worktree.`,
    ...open.map(printedThread),
  ];
}

/** The reason the failure comment gives, each item it lists, then where it went. */
function failedLines(result: Failed): string {
  const { comment } = result;
  const went =
    comment === undefined
      ? []
      : [
          comment.posted
            ? `the failure is posted on PR #${result.pullRequest}`
            : `the failure could not be posted on PR #${result.pullRequest}: ${comment.reason}`,
        ];
  return [`review failed: ${result.reason}`, ...result.items, ...went].map(failureLine).join("");
}

function unpostedLine(result: Unposted): string {
  const them = result.findings === 1 ? "it" : "them";
  return `round ${result.round} found ${counted(result.findings, "finding")} and could not post ${them} to PR #${result.pullRequest}`;
}

/**
 * One open thread: its `squiz threads` line, then its comments indented two
 * spaces, the first without the first line the `squiz threads` line carries.
 */
function printedThread(thread: ReviewThread): string {
  const [opening, ...replies] = thread.comments.map((comment) => linesOf(comment.body));
  const bodies = [trimBlank((opening ?? []).slice(1)), ...replies.map(trimBlank)].filter(
    (lines) => lines.length > 0,
  );
  const indented = bodies.map((lines) => lines.map(indent).join("\n"));
  return [threadLine(thread), indented.join("\n\n")].filter((part) => part !== "").join("\n");
}

function linesOf(body: string): string[] {
  return body.split(/\r\n|\r|\n/u);
}

// A blank line stays empty rather than taking the indent, so nothing is added
// that is only trailing whitespace.
function indent(line: string): string {
  return line.trim() === "" ? "" : `  ${line}`;
}

/** `lines` without the blank lines that open and close them. */
function trimBlank(lines: readonly string[]): readonly string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? "").trim() === "") start += 1;
  while (end > start && (lines[end - 1] ?? "").trim() === "") end -= 1;
  return lines.slice(start, end);
}

function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
