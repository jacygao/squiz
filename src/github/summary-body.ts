/**
 * The body of the one comment an episode posts when it closes: what the review
 * counted and spent, what still needs a person, and the notes.
 *
 * The comment is posted once and never edited, so anything wrong here is
 * permanent for that episode. Two things go wrong quietly. A heading with
 * nothing under it reads as a report that failed to render, so Notes is left out
 * whole where there is nothing to report. And the marker opening the first line
 * is the only thing separating this comment from the ones the reviewer posted,
 * so it is written in one place.
 *
 * Nothing is composed for a source the harness has none of. What the episode
 * holds is the whole of the input, and a note nothing supplies is a note this
 * does not write.
 */

import type { Finding } from "../findings/finding.ts";
import type { ThreadStatus } from "../findings/status.ts";
import type { ClassifiedThread } from "../loop/classify.ts";
import type { ConfinementEvidence } from "../loop/confinement.ts";
import type { RoundRecord } from "../loop/episode-state.ts";
import type { Failed, Noted, PostedFindings } from "../loop/post-findings.ts";
import type { ClosingReason } from "../loop/round-decision.ts";
import type { LeftNotReviewed, StoppingBound } from "../loop/round-end.ts";
import { renderSpendLine } from "./spend-line.ts";

/** What the episode came to, which is everything the comment is written from. */
export type ClosedEpisode = {
  /**
   * Each round as the episode's state recorded it, in the order the rounds ran.
   * Its length is the rounds run.
   */
  readonly rounds: readonly RoundRecord[];
  /** Every thread of this review on the pull request, as the status it ended in. */
  readonly threads: readonly ClassifiedThread[];
  /**
   * What became of the closing round's own findings, which is where the ones no
   * thread holds are.
   */
  readonly findings: PostedFindings;
  /**
   * Which bound closed the episode. `null` where none of them did, which is a
   * close Notes says nothing about.
   */
  readonly because: ClosingReason | null;
  /**
   * What every round of the episode established about the worktree its reviewer
   * ran in.
   *
   * The episode's and not the closing round's. A round that blocks posts no
   * comment, so a file it found changed is named here or nowhere.
   */
  readonly confinement: ConfinementEvidence;
  /**
   * The queued states the close recorded not reviewed, and the bound that
   * stopped them. `null` where nothing was queued.
   */
  readonly leftNotReviewed: LeftNotReviewed | null;
};

/**
 * The marker the comment opens with, which is what a reader of the pull request
 * matches the summary by.
 *
 * The dash and the spaces around it are part of it. `**Squiz review` is also a
 * prefix of the reviewer's own marker, so the character after the name is the
 * whole of the difference between the summary and a finding.
 */
const marker = "**Squiz review — ";

/**
 * The four statuses in the order the counts line names them, each under the word
 * it is printed with.
 *
 * A record of every status, so that one added to the union has to be given a
 * place here for this to compile. The record's order is the line's order.
 */
const countedAs: Readonly<Record<ThreadStatus, string>> = {
  fixed: "Fixed",
  withdrawn: "Withdrawn",
  open: "Open",
  disputed: "Disputed",
};

/**
 * The comment's body for `episode`, with no trailing newline.
 *
 * Three blocks: what was counted and spent, what needs a person, and Notes. The
 * last is absent where there is nothing to report, and the first two are always
 * written, a review that found nothing included.
 *
 * Nothing here throws and nothing is refused. Every episode composes.
 */
export function renderSummary(episode: ClosedEpisode): string {
  return [tally(episode), needsAPerson(episode.threads), ...notes(episode)].join("\n\n");
}

/** What the review counted and what it spent, under the marker. */
function tally(episode: ClosedEpisode): string {
  const rounds = counted(episode.rounds.length, "round");
  const findings = counted(countRaised(episode), "finding");
  const statuses = Object.entries(countedAs)
    .map(([status, word]) => `${word} ${howMany(episode.threads, status)}`)
    .join(" · ");
  return `${marker}${rounds}, ${findings}**\n\n${statuses}\n${renderSpendLine(episode.rounds)}`;
}

/**
 * How many findings the review raised: every thread of the episode, and the
 * closing round's findings that no thread holds.
 *
 * Larger than the four status counts add to, because a finding no thread holds
 * is raised and carries no status. Every one of them is a line in Notes, so
 * nothing in the count is a finding the reader cannot see.
 *
 * A finding an earlier round raised and no thread holds is not counted, because
 * nothing carries one between rounds. Threads are unaffected: every thread of the
 * episode is on the pull request when it closes.
 */
function countRaised(episode: ClosedEpisode): number {
  return episode.threads.length + unthreaded(episode.findings).length;
}

function howMany(threads: readonly ClassifiedThread[], status: string): number {
  return threads.filter((thread) => thread.status === status).length;
}

/**
 * Every finding a person has to settle, or the one line saying there are none.
 *
 * The threads keep the order they were classified in. Grouping them by status
 * would take that order away and say nothing the word ending each line does not.
 */
function needsAPerson(threads: readonly ClassifiedThread[]): string {
  const unsettled = threads.filter(
    (thread) => thread.status === "open" || thread.status === "disputed",
  );
  const block = ["**Needs a person**"];
  if (unsettled.length === 0) {
    // Said in a line rather than left out. A heading over nothing reads as a
    // block that failed to render, and this one is written either way.
    block.push("Nothing needs a person.");
  } else {
    block.push(unsettled.map(unsettledLine).join("\n"));
  }
  return block.join("\n\n");
}

/** One unsettled finding: where it sits, what it is, and which of the two it is. */
function unsettledLine(thread: ClassifiedThread): string {
  return `- \`${thread.location}\` — ${named(thread.headline)} (${thread.status})`;
}

/**
 * What to call the finding, as one line.
 *
 * The reviewer's own text reaches this unchanged, so any run of whitespace in it
 * is collapsed here. A newline left in a headline makes a second bullet out of
 * one finding, or a heading out of the line after it, while the count above still
 * says one.
 *
 * A headline the reviewer left blank, or one that is nothing but whitespace, is
 * named as missing. A line that stopped after the location would read as a
 * rendering that broke; the reader is told the headline is missing instead, and
 * the location names the thread the finding itself is on.
 */
function named(headline: string | null): string {
  const said = oneLine(headline ?? "");
  return said === "" ? "The reviewer left this finding's headline blank" : said;
}

/**
 * `text` as one line of the comment.
 *
 * Every run of whitespace collapses. A newline reaching the comment makes a
 * second bullet out of one note, or a heading out of the line after it.
 */
function oneLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/**
 * Notes, or nothing at all.
 *
 * The findings come in the order they were posted, which runs `high` severity
 * first. What the episode established about the worktree follows them, then the
 * rounds the time bound cut short, and the bound that closed the episode comes
 * last: the findings are each about one defect, the worktree and the cuts are
 * about the rounds, and the bound is about the episode.
 */
function notes(episode: ClosedEpisode): readonly string[] {
  const lines = [
    ...unthreaded(episode.findings).map(noteLine),
    ...worktreeNotes(episode.confinement).map((note) => `- ${note}`),
    ...cutShort(episode.rounds),
    ...closedEarly(episode.because, episode.leftNotReviewed),
  ];
  if (lines.length === 0) return [];
  return [`**Notes**\n\n${lines.join("\n")}`];
}

/**
 * What the readings around the reviewer established, one note per line and with
 * no bullet, in the order Notes lists them.
 *
 * A failed round's failure comment lists the same notes, and its stderr prints
 * each as a line of its own.
 */
export function worktreeNotes(found: ConfinementEvidence): readonly string[] {
  return [
    ...whatChanged(found.changed),
    ...whereHeadMoved(found.moved),
    ...whatWasNotCompared(found.uncompared),
    ...whoElseWasHere(found.shared),
    ...whoWasNotEstablished(found.unestablished),
  ];
}

/** Every file a reviewer changed, on one line, where any round found one. */
function whatChanged(paths: readonly string[]): readonly string[] {
  if (paths.length === 0) return [];
  const many = paths.length === 1 ? "A file" : "Files";
  // A path git gives can hold a newline, which left in would make a second bullet
  // out of one note.
  const which = paths.map((path) => `\`${oneLine(path)}\``).join(", ");
  return [`${many} changed in the worktree while the reviewer ran: ${which}`];
}

/** One line per move of `HEAD` a round found, each naming both ends. */
function whereHeadMoved(moves: readonly string[]): readonly string[] {
  return moves.map((move) => `\`HEAD\` moved while the reviewer ran: ${oneLine(move)}`);
}

/**
 * One line per round that could not say what changed in the worktree.
 *
 * A round that compared and found nothing is no note, and a round that could not
 * compare is one. The two compose the same comment otherwise, and the one a person
 * would act on is the one that then reads as reassurance.
 *
 * A comparison that was taken and could not be had, and one a round never took,
 * are written alike. What a person does about either is the same — read the diff,
 * because nothing else here says the reviewer left it alone — and the reason,
 * which is the whole of the difference, is on the line.
 */
function whatWasNotCompared(reasons: readonly string[]): readonly string[] {
  return reasons.map(
    (reason) =>
      "A round could not tell whether a file changed or `HEAD` moved while the reviewer ran:" +
      ` ${oneLine(reason)}`,
  );
}

/** Which other episodes were in the worktree, where any round found one. */
function whoElseWasHere(ids: readonly string[]): readonly string[] {
  if (ids.length === 0) return [];
  const many = ids.length === 1 ? "Another episode was" : "Other episodes were";
  return [`${many} in the worktree while the reviewer ran: ${ids.join(", ")}`];
}

/**
 * One line per round that could not say who else was in the worktree.
 *
 * Said rather than left out, because the comparison above it is only worth what
 * the answer here is.
 */
function whoWasNotEstablished(reasons: readonly string[]): readonly string[] {
  return reasons.map(
    (reason) =>
      "A round could not tell whether another episode was in the worktree" +
      ` while the reviewer ran: ${oneLine(reason)}`,
  );
}

/**
 * One line per round whose review the time bound ended before the reviewer
 * finished it.
 *
 * A killed reviewer's findings are posted like a finished one's, so nothing else
 * on the pull request tells a person that part of the change was never read.
 */
function cutShort(rounds: readonly RoundRecord[]): readonly string[] {
  return rounds.flatMap((round, index) =>
    round.cutShortAtSeconds === undefined
      ? []
      : [
          `- The review was cut short by the ${round.cutShortAtSeconds}-second time bound` +
            ` in round ${index + 1}, and the round kept only the findings it had reported by then`,
        ],
  );
}

/** The findings of the closing round that no thread on the pull request holds. */
function unthreaded(findings: PostedFindings): readonly (Noted | Failed)[] {
  return findings.outcomes.filter((outcome) => outcome.outcome !== "threaded");
}

/**
 * One finding that no thread holds.
 *
 * A finding about the change as a whole has nowhere to point at and is named by
 * its subject. One that named a location is given that location, because the
 * location is the whole of what a person has to go on: no thread was opened, so
 * there is nothing on the pull request to follow.
 *
 * A finding whose comment could not be posted at all says so. The reviewer
 * confirmed it and the harness lost it, and a line that read like the others
 * would send a person looking for a thread that is not there.
 */
function noteLine(note: Noted | Failed): string {
  if (note.outcome === "failed") {
    // Not the reason GitHub gave, which the round reports: it is unbounded text,
    // and a newline in it would put a line in this comment that nothing wrote.
    const lost = "raised, and its comment could not be posted";
    return line(where(note.finding), note.finding.headline, lost);
  }
  // A finding about the change as a whole is in Notes because that is where one
  // belongs, and nothing failed to place it.
  if (note.location === undefined) return line(undefined, note.finding.headline);
  return line(note.location, note.finding.headline, "no thread could be opened for it");
}

/** One Notes line: where the defect is, what it is, and what became of the finding. */
function line(location: string | undefined, headline: string, what?: string): string {
  const disposition = what === undefined ? "" : ` (${what})`;
  const said = named(headline);
  if (location === undefined) return `- About the change as a whole: ${said}${disposition}`;
  return `- \`${location}\` — ${said}${disposition}`;
}

/**
 * Where the finding said the defect is, as the summary writes it, or `undefined`
 * for one about the change as a whole.
 *
 * Read off the finding itself, which is all there is for a finding no comment
 * was posted for: nothing placed it anywhere.
 */
function where(finding: Finding): string | undefined {
  if (finding.file === undefined) return undefined;
  if (finding.line === undefined) return finding.file;
  return `${finding.file}:${finding.line}`;
}

/**
 * The bound that ended the episode, where one did, and each queued state it left
 * not reviewed.
 *
 * An episode that closed with nothing left open closed because the review was
 * finished, which is not a note. A bound is, because it says the findings above
 * it were never reviewed again.
 *
 * A bound that stopped a queued state is a note even where nothing was left
 * open, because no other line of the comment says that state was never read.
 * The line then names the bound from `left`, since `because` names none.
 */
function closedEarly(
  because: ClosingReason | null,
  left: LeftNotReviewed | null,
): readonly string[] {
  const closedAtBound = because === "round-cap" || because === "token-bound";
  if (left === null) {
    if (!closedAtBound) return [];
    return [`- The episode ended at ${boundName(because)} rather than with nothing left open`];
  }
  const how = closedAtBound
    ? `${boundName(because)} rather than with nothing left open`
    : `${boundName(left.bound)} with nothing left open`;
  const heads = left.states.map((state) => state.head.slice(0, 7));
  return [`- The episode ended at ${how}, and did not review ${eitherOf(heads)}`];
}

function boundName(bound: StoppingBound): string {
  return bound === "round-cap" ? "its round cap" : "the token bound";
}

/** `a`, `a or b`, or `a, b or c`. */
function eitherOf(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;
}

/** How many of `thing` there are, the plural agreeing with the number. */
function counted(howMuch: number, thing: string): string {
  return `${howMuch} ${thing}${howMuch === 1 ? "" : "s"}`;
}
