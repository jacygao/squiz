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
 * Nothing is composed for a source the harness has none of. What the closing
 * round holds is the whole of the input, and a note nothing supplies is a note
 * this does not write.
 */

import type { ThreadStatus } from "../findings/status.ts";
import type { ClassifiedThread } from "../loop/classify.ts";
import type { Noted, PostedFindings } from "../loop/post-findings.ts";
import type { ClosingReason } from "../loop/round-decision.ts";
import type { RoundCost } from "../reviewers/adapter.ts";
import { renderSpendLine } from "./spend-line.ts";

/** What the episode came to, which is everything the comment is written from. */
export type ClosedEpisode = {
  /** What each round spent, in the order the rounds ran. Its length is the rounds run. */
  readonly rounds: readonly RoundCost[];
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
 * Larger than the four status counts add to, because a finding about the change
 * as a whole is raised and carries no status.
 *
 * Two findings are outside it. A finding no comment could be posted for at all
 * is left out: no line of this comment accounts for it, and a count that
 * reconciles with nothing a reader can see reads as an error in the comment. And
 * a finding about the change as a whole that an earlier round raised is left out
 * because nothing carries one between rounds, so the count covers the closing
 * round's. Threads are unaffected: every thread of the episode is on the pull
 * request when it closes.
 */
function countRaised(episode: ClosedEpisode): number {
  return episode.threads.length + noted(episode.findings).length;
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
 * What to call the finding, where the reviewer left its headline blank.
 *
 * A line that stopped after the location would read as a rendering that broke.
 * The reader is told the headline is missing instead, and the location names the
 * thread the finding itself is on.
 */
function named(headline: string | null): string {
  return headline ?? "The reviewer left this finding's headline blank";
}

/**
 * Notes, or nothing at all.
 *
 * The findings come in the order they were posted, which runs `high` severity
 * first, and the bound that closed the episode follows them: it is about the
 * episode rather than about any one finding.
 */
function notes(episode: ClosedEpisode): readonly string[] {
  const lines = [...noted(episode.findings).map(noteLine), ...closedEarly(episode.because)];
  if (lines.length === 0) return [];
  return [`**Notes**\n\n${lines.join("\n")}`];
}

/** The findings of the closing round that no thread on the pull request holds. */
function noted(findings: PostedFindings): readonly Noted[] {
  return findings.outcomes.filter((outcome) => outcome.outcome === "noted");
}

/**
 * One noted finding.
 *
 * A finding about the change as a whole has nowhere to point at and is named by
 * its subject. One that named a location is given that location, because the
 * location is the whole of what a person has to go on: no thread was opened, so
 * there is nothing on the pull request to follow.
 */
function noteLine(note: Noted): string {
  const { headline } = note.finding;
  if (note.location === undefined) return `- About the change as a whole: ${headline}`;
  return `- \`${note.location}\` — ${headline} (no thread could be opened for it)`;
}

/**
 * The bound that ended the episode, where one did.
 *
 * An episode that closed with nothing left open closed because the review was
 * finished, which is not a note. A bound is, because it says the findings above
 * it were never reviewed again.
 */
function closedEarly(because: ClosingReason | null): readonly string[] {
  switch (because) {
    case "round-cap":
      return ["- The episode ended at its round cap rather than with nothing left open"];
    case "token-bound":
      return ["- The episode ended at the token bound rather than with nothing left open"];
    case "nothing-open":
    case null:
      return [];
  }
}

/** How many of `thing` there are, the plural agreeing with the number. */
function counted(howMuch: number, thing: string): string {
  return `${howMuch} ${thing}${howMuch === 1 ? "" : "s"}`;
}
