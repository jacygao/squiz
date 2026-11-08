/**
 * What `squiz review` prints for a result, and the copy of it in
 * `review.txt` in the episode's directory.
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

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { threadLine } from "../findings/listing.ts";
import { failureLine } from "../hook/report.ts";
import type { Episode } from "../loop/episode.ts";
import { makeEpisodeDirectory } from "../loop/state-directory.ts";
import type { Change, ReviewThread } from "../venues/venue.ts";

/** What closed an episode short of a clean review. */
export type Bound = "round cap" | "token bound";

/** What every result names, whatever it came to. */
type About = {
  readonly key: string;
  /**
   * Lines for what failed without changing the outcome, such as a summary that
   * could not be posted. Each goes on stderr, and the status stands.
   */
  readonly problems?: readonly string[];
};

/** A result whose lines name the change, the command that reviews it again, and where its summary is. */
type Named = About & {
  readonly name: Change["name"];
  readonly rerun: Change["rerun"];
  readonly summaryAt: Change["summaryAt"];
};

/** A round's result: the state it reviewed, and what it left open. */
type RoundResult = Named & {
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

type Open = RoundResult & { readonly exit: 2; readonly followUp: Change["followUp"] };

type Clean = RoundResult & {
  readonly exit: 0;
  /** The run's own state, which the close left unreviewed, and what closed the episode. */
  readonly notReviewed?: NotReviewed | undefined;
};

/**
 * A state the close left unreviewed. `state` is how it is printed: its short
 * head commit, and that its replies differ where it shares a head with a state
 * before it, as `namedStates` names it.
 */
type NotReviewed = { readonly state: string; readonly closedAt: Bound };

type ClosedOpen = RoundResult & {
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
type StillReviewing = Named & { readonly outcome: "reviewing" } & (
    | { readonly wait: "under review"; readonly commit: string }
    | { readonly wait: "queued" | "clean" | "superseded"; readonly commit: string; readonly reviewing: string }
  );

/** A run on an episode whose close is already recorded, exiting as the close did. */
type AlreadyClosed = Named & {
  readonly outcome: "closed";
  readonly exit: 0 | 3;
  readonly rounds: number;
  readonly threads: readonly ReviewThread[];
  /** The short head of the state the close was reached on, where a record names it. */
  readonly commit?: string;
  /** Whether a new head starts a new episode: true for a clean close, false for one at a bound. */
  readonly reopens: boolean;
};

/**
 * A run whose own state the episode's spent cap or token bound stopped before a
 * round took it, handed the close, exiting as the close did.
 */
type ClosedUnreviewed = Named & {
  readonly outcome: "closed unreviewed";
  readonly exit: 0 | 3;
  /** The run's own state, as `namedStates` names it. */
  readonly state: string;
  /** Why the state was not reviewed, as its record says. */
  readonly reason: string;
  readonly closedAt: Bound;
  /** The threads the close left open, as they stand on the pull request now. */
  readonly threads: readonly ReviewThread[];
  /** False where the close has no summary on the pull request. */
  readonly summarised: boolean;
};

/** A round that failed, exit 1, with what its failure comment says and where it went. */
type Failed = Named & {
  readonly outcome: "failed";
  readonly reason: string;
  /** The lines the failed round's record keeps for after the reason, one each. */
  readonly items: readonly string[];
  /** Absent where the items already say where the comment went, or none was attempted. */
  readonly comment?: { readonly posted: true } | { readonly posted: false; readonly reason: string };
};

/** A run that failed before any round, exit 1. */
type NotRun = About & { readonly outcome: "not run"; readonly reason: string };

/** A change the venue holds back, which no trigger queues, exit 0, printing the venue's line. */
type Held = About & { readonly outcome: "held"; readonly line: string };

/** A round whose findings could not be posted, exit 1. */
type Unposted = Named & {
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
  | ClosedUnreviewed
  | Failed
  | NotRun
  | Unposted
  | Held;

/** What the run ends with. `stderr` is whole lines, newlines included, or empty. */
export type Printed = {
  readonly exit: 0 | 1 | 2 | 3 | 4;
  readonly stdout: string;
  readonly stderr: string;
};

/** Where the output of a review of `episode` is kept, as an absolute path. */
export function reviewOutputPath(episode: Episode): string {
  return resolve(episode.directory, "review.txt");
}

/**
 * Compose the output for `result`, and write its stdout to the review's output
 * file in `episode`'s directory, replacing what was there.
 *
 * A run that exits 1 prints nothing on stdout and writes no file, and neither
 * does a held change, whose one line is all there is to read. A write that
 * fails adds a line on stderr and changes nothing else: the outcome stands, and
 * it is printed whole on stdout either way.
 */
export function printReview(result: ReviewResult, episode: Episode): Printed {
  const path = reviewOutputPath(episode);
  const printed = composeReview(result, path);
  if (printed.exit === 1 || result.outcome === "held") return printed;

  try {
    makeEpisodeDirectory(episode);
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
    case "closed unreviewed":
      return { exit: result.exit, stdout: printedAt(path, unreviewedBlocks(result)), stderr: problems };
    case "failed":
      return { exit: 1, stdout: "", stderr: failedLines(result) + problems + NOT_AGAIN };
    case "not run":
      return { exit: 1, stdout: "", stderr: failureLine(`no review ran: ${result.reason}`) + problems + NOT_AGAIN };
    case "unposted":
      return { exit: 1, stdout: "", stderr: failureLine(unpostedLine(result)) + problems + NOT_AGAIN };
    case "held":
      return { exit: 0, stdout: `${result.line}\n`, stderr: problems };
  }
}

// Running the command again after it could not run spends a round on the same
// failure, so a coding agent is told to stop and report instead.
const NOT_AGAIN = failureLine("put these lines in your report rather than running squiz review again");

/** Exit 1 for a result that could not be printed, `reason` saying why. */
export function unprinted(reason: string): Printed {
  return { exit: 1, stdout: "", stderr: failureLine(reason) + NOT_AGAIN };
}

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
  const heading = `Squiz ${verb} ${result.name} at ${result.commit}: round ${result.round} of ${result.cap}, ${findings}.`;

  switch (result.exit) {
    case 2:
      return [
        heading,
        `${counted(open.length, "thread")} ${open.length === 1 ? "is" : "are"} open:`,
        ...open.map(printedThread),
        result.followUp,
      ];
    case 0:
      return [withNotReviewed(heading, result, result.notReviewed), nothingOpen(result.summaryAt)];
    case 3: {
      const unreviewed = result.notReviewed?.state;
      const notReviewed =
        unreviewed === undefined ? undefined : { state: unreviewed, closedAt: result.closedAt };
      return [
        withNotReviewed(heading, result, notReviewed),
        boundReached(result.closedAt, open.length, result.rerun, result.summaryAt),
        ...open.map(printedThread),
      ];
    }
  }
}

function nothingOpen(summaryAt: string): string {
  return `Nothing is open. The review is closed, and its summary is ${summaryAt}.`;
}

/**
 * What a close at a bound with threads open tells the coding agent to do.
 * `summaryAt` is undefined where the close has no summary.
 */
function boundReached(closedAt: Bound, open: number, rerun: string, summaryAt: string | undefined): string {
  if (summaryAt === undefined) {
    return [
      `The ${closedAt} is reached. The review is closed with ${counted(open, "thread")} open. A person takes`,
      `it from here, so do not run \`${rerun}\` again.`,
    ].join("\n");
  }
  return [
    `The ${closedAt} is reached. The review is closed with ${counted(open, "thread")} open, and its summary`,
    `is ${summaryAt}. A person takes it from here, so do not run`,
    `\`${rerun}\` again.`,
  ].join("\n");
}

function unreviewedBlocks(result: ClosedUnreviewed): readonly string[] {
  const heading = `Squiz did not review ${result.name} at ${result.state}: ${result.reason}.`;
  const open = result.threads.filter((thread) => !thread.isResolved);
  if (result.exit === 0) {
    return [heading, result.summarised ? nothingOpen(result.summaryAt) : "Nothing is open, and the review is closed."];
  }
  return [
    heading,
    boundReached(result.closedAt, open.length, result.rerun, result.summarised ? result.summaryAt : undefined),
    ...open.map(printedThread),
  ];
}

/** `heading`, followed where the close left the run's own state unreviewed by the line saying why. */
function withNotReviewed(
  heading: string,
  result: RoundResult,
  notReviewed: NotReviewed | undefined,
): string {
  if (notReviewed === undefined) return heading;
  const why = `the episode closed at the ${notReviewed.closedAt}, after reviewing ${result.commit}`;
  return `${heading}\nSquiz did not review ${result.name} at ${notReviewed.state}: ${why}.`;
}

function stillReviewing(result: StillReviewing): string {
  const again = `Run \`${result.rerun}\` again to wait for it.`;
  switch (result.wait) {
    case "under review":
      return `Squiz is still reviewing ${result.name} at ${result.commit}. ${again}`;
    case "queued":
      return `Squiz is reviewing ${result.name} at ${result.reviewing} first, and ${result.commit} is next. ${again}`;
    case "clean":
      return `Squiz found nothing open in ${result.name} at ${result.commit}, and is reviewing ${result.reviewing} before it closes the review. ${again}`;
    case "superseded":
      return `Squiz is reviewing ${result.name} at ${result.reviewing} instead of ${result.commit}. ${again}`;
  }
}

function closedBlocks(result: AlreadyClosed): readonly string[] {
  const open = result.threads.filter((thread) => !thread.isResolved);
  const left = open.length === 0 ? "nothing open" : `${counted(open.length, "thread")} open`;
  const at = result.commit === undefined ? "" : ` at ${result.commit}`;
  const next = result.reopens ? "Only a new head commit starts another review in this worktree." : "No round runs again in this worktree.";
  return [
    `Squiz's review of ${result.name} closed${at} after ${counted(result.rounds, "round")}, with ${left}. ${next}`,
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
            ? `the failure is posted on ${result.name}`
            : `the failure could not be posted on ${result.name}: ${comment.reason}`,
        ];
  return [`review failed: ${result.reason}`, ...result.items, ...went].map(failureLine).join("");
}

function unpostedLine(result: Unposted): string {
  const them = result.findings === 1 ? "it" : "them";
  return `round ${result.round} found ${counted(result.findings, "finding")} and could not post ${them} to ${result.name}`;
}

/**
 * One open thread: its `squiz threads` line, then its comments indented two
 * spaces, the first without the first line the `squiz threads` line carries.
 */
export function printedThread(thread: ReviewThread): string {
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
