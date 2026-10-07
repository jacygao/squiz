/**
 * The body of the one comment an episode posts when it closes: what the review
 * counted and spent, what still needs a person, the rounds, and the notes.
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
import { readThread } from "../findings/thread.ts";
import { locationOf, type ClassifiedThread, type CountedStatus } from "../loop/classify.ts";
import { costOf, type RoundRecord, type RulingCounts } from "../loop/episode-state.ts";
import type { Failed, Noted, PostedFindings } from "../loop/post-findings.ts";
import type { ClosingReason } from "../loop/round-decision.ts";
import { namedStates, type LeftNotReviewed, type StoppingBound } from "../loop/round-end.ts";
import { mutated, type AppliedVerdicts } from "../loop/verdicts.ts";
import { renderReviewerLine } from "./reviewer-line.ts";
import { renderSpendLine } from "./spend-line.ts";
import type { ReviewThread } from "./threads.ts";

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
   * What became of the last round's own findings, which is where the ones no
   * thread holds are.
   */
  readonly findings: PostedFindings;
  /**
   * The Notes lines of an earlier round's findings that no thread holds, which
   * no round after it settled.
   */
  readonly earlier: readonly string[];
  /** The Notes lines of the last round's rulings that could not be applied. */
  readonly unapplied: readonly string[];
  /**
   * Which bound closed the episode. `null` where none of them did, which is a
   * close Notes says nothing about.
   */
  readonly because: ClosingReason | null;
  /**
   * The queued states the close recorded not reviewed, and the bound that
   * stopped them. `null` where nothing was queued.
   */
  readonly leftNotReviewed: LeftNotReviewed | null;
  /** Present where the closing round is what posts this comment. */
  readonly closingRound?: ClosingRoundSummary;
};

/** What the closing round did, which its summary names. */
export type ClosingRoundSummary = {
  /** The threads it was handed, which are the ones open when it started. */
  readonly ruledOn: readonly ReviewThread[];
  /** What it ruled on them. */
  readonly verdicts: AppliedVerdicts;
  /** The findings the reviewer reported anyway, none of which was posted. */
  readonly dropped: readonly Finding[];
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
 * What the counts line names each thread as, in the order it names them, each
 * under the word it is printed with.
 *
 * A record of every status, so that one added to the union has to be given a
 * place here for this to compile. The record's order is the line's order.
 */
const countedAs: Readonly<Record<CountedStatus, string>> = {
  fixed: "Fixed",
  withdrawn: "Withdrawn",
  open: "Open",
  disputed: "Disputed",
  resolved: "Resolved, ruling unknown",
};

/**
 * The four statuses every thread can end in, which the line prints even at
 * zero. The rest are printed only where some thread has them.
 */
const alwaysCounted: ReadonlySet<CountedStatus> = new Set<ThreadStatus>(["fixed", "withdrawn", "open", "disputed"]);

/**
 * The comment's body for `episode`, with no trailing newline.
 *
 * Four blocks: what was counted and spent, what needs a person, the rounds, and
 * Notes. The first two are always written, a review that found nothing
 * included. Notes is absent where there is nothing to report, and the rounds
 * where the state file recorded the work of none of them.
 *
 * Nothing here throws and nothing is refused. Every episode composes.
 */
export function renderSummary(episode: ClosedEpisode): string {
  return [tally(episode), needsAPerson(episode.threads), ...roundsList(episode.rounds), ...notes(episode)].join(
    "\n\n",
  );
}

/**
 * Each round as its record has it: the commit it reviewed, how many findings it
 * raised, and the rulings it replied with.
 *
 * Read from the state file and never from the pull request, so a round whose
 * replies GitHub refused is listed all the same. A file written before the work
 * was recorded lists no rounds at all, rather than a list of rounds it knows
 * nothing about.
 */
function roundsList(rounds: readonly RoundRecord[]): readonly string[] {
  if (rounds.every((round) => round.raised === undefined || round.ruled === undefined)) return [];
  return [`**Rounds**\n\n${rounds.map(roundLine).join("\n")}`];
}

/** One round of the list, numbered from 1, and the closing round named as one. */
function roundLine(round: RoundRecord, index: number): string {
  const which = round.closing === true ? "The closing round" : `Round ${index + 1}`;
  const named = `- ${which}${round.head === undefined ? "" : ` at ${round.head.slice(0, 7)}`}`;
  if (round.raised === undefined || round.ruled === undefined) return `${named}: not recorded`;
  const rulings = rulingsGiven(round.ruled);
  if (round.raised === 0 && rulings === null) return `${named}: found nothing new and ruled on nothing`;
  const raised = round.raised === 0 ? "raised nothing" : `raised ${counted(round.raised, "finding")}`;
  return rulings === null ? `${named}: ${raised}` : `${named}: ${raised}, and ruled ${rulings}`;
}

/** The rulings a round gave, as `2 fixed, 1 withdrawn and 1 open`, or `null` for none. */
function rulingsGiven(ruled: RulingCounts): string | null {
  const given = (["fixed", "withdrawn", "open"] as const)
    .filter((verdict) => ruled[verdict] > 0)
    .map((verdict) => `${ruled[verdict]} ${verdict}`);
  if (given.length === 0) return null;
  return given.length === 1 ? (given[0] ?? null) : `${given.slice(0, -1).join(", ")} and ${given.at(-1)}`;
}

/** What the review counted, what it spent, and who reviewed it, under the marker. */
function tally(episode: ClosedEpisode): string {
  const closing = episode.rounds.some((round) => round.closing === true);
  const capped = episode.rounds.filter((round) => round.closing !== true).length;
  const rounds = `${counted(capped, "round")}${closing ? " and a closing round" : ""}`;
  const findings = counted(countRaised(episode), "finding");
  const statuses = (Object.entries(countedAs) as [CountedStatus, string][])
    .map(([status, word]) => ({ status, word, count: howMany(episode.threads, status) }))
    .filter(({ status, count }) => count > 0 || alwaysCounted.has(status))
    .map(({ word, count }) => `${word} ${count}`)
    .join(" · ");
  const spend = renderSpendLine(episode.rounds.map(costOf), closing);
  const reviewedBy = renderReviewerLine(episode.rounds);
  const below = [statuses, spend, reviewedBy].filter((line) => line !== null).join("\n");
  return `${marker}${rounds}, ${findings}**\n\n${below}`;
}

/**
 * How many findings the review raised: every thread of the episode, and every
 * finding no thread holds that Notes names.
 *
 * Larger than the status counts add to, because a finding no thread holds
 * is raised and carries no status. Every one of them is a line in Notes, so
 * nothing in the count is a finding the reader cannot see.
 */
function countRaised(episode: ClosedEpisode): number {
  return episode.threads.length + episode.earlier.length + unthreaded(episode.findings).length;
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
 * An earlier round's findings come first, then the last round's in the order
 * they were posted, which runs `high` severity first, then the threads kept open
 * with no reason on them, then the threads closed with no reply on them, round
 * by round, then the rulings that could not be applied. The rounds
 * the time bound cut short follow them, and the bound that closed the episode
 * comes last: the findings and the threads are each about one defect, the cuts
 * are about the rounds, and the bound is about the episode.
 */
function notes(episode: ClosedEpisode): readonly string[] {
  const lines = [
    ...[
      ...episode.earlier,
      ...unthreadedNotes(episode.findings),
      ...droppedNotes(episode.closingRound?.dropped ?? []),
      ...unpostedReasonNotes(episode.threads),
      ...episode.rounds.flatMap((round) => round.unpostedReplies ?? []),
      ...episode.unapplied,
    ].map((note) => `- ${note}`),
    ...closingRoundNote(episode.closingRound),
    ...cutShort(episode.rounds),
    ...closedEarly(episode.because, episode.leftNotReviewed),
  ];
  if (lines.length === 0) return [];
  return [`**Notes**\n\n${lines.join("\n")}`];
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
            ` in ${round.closing === true ? "the closing round" : `round ${index + 1}`}, and the round kept only the findings it had reported by then`,
        ],
  );
}

/**
 * Each finding the reviewer reported in the closing round, one line each and
 * with no bullet. None was posted, and this line is the only record of it.
 */
export function droppedNotes(findings: readonly Finding[]): readonly string[] {
  return findings.map((finding) =>
    line(where(finding), finding.headline, "reported in the closing round, which raises no findings, so it was not posted"),
  );
}

/**
 * The line naming the closing round and each thread it closed, or nothing where
 * this summary is not the closing round's.
 *
 * Without it, a summary after a closing round reads exactly like one from an
 * episode that never had one.
 */
function closingRoundNote(closing: ClosingRoundSummary | undefined): readonly string[] {
  if (closing === undefined) return [];
  const byId = new Map(closing.ruledOn.map((thread) => [thread.id, thread]));
  const settled = closing.verdicts.threads.flatMap((applied) => {
    const thread = byId.get(applied.thread);
    if (applied.outcome !== "closed" || applied.ruled === null || thread === undefined) return [];
    const reading = readThread(thread);
    return [line(locationOf(thread), reading.raised === "finding" ? reading.headline : null, applied.ruled)];
  });
  const handed = `ruled on the ${counted(closing.ruledOn.length, "thread")} the round cap left open`;
  const what = settled.length === 0 ? "settled none" : `settled ${settled.length}: ${settled.join("; ")}`;
  return [`- The closing round ${handed}, and ${what}`];
}

/** The findings of the last round that no thread on the pull request holds. */
function unthreaded(findings: PostedFindings): readonly (Noted | Failed)[] {
  return findings.outcomes.filter((outcome) => outcome.outcome !== "threaded");
}

/**
 * Each of `findings` that no thread holds, one line each and with no bullet, in
 * the order Notes lists them.
 *
 * A failed round posts no summary, so its failure comment lists the same lines.
 */
export function unthreadedNotes(findings: PostedFindings): readonly string[] {
  return unthreaded(findings).map(noteLine);
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

/**
 * Each thread the reviewer kept open whose reply giving the reason could not be
 * posted, one line each and with no bullet.
 *
 * What GitHub said is left out, as it is for a finding: it is unbounded text,
 * and the round reports it.
 */
function unpostedReasonNotes(threads: readonly ClassifiedThread[]): readonly string[] {
  return threads
    .filter((thread) => thread.reasonUnposted === true)
    .map((thread) =>
      line(thread.location, thread.headline, "kept open, and the reviewer's reason could not be posted on its thread"),
    );
}

/**
 * Each ruling the round could not apply, one line each and with no bullet: the
 * thread where it sits, and what the reviewer ruled on it.
 *
 * A failed round posts no summary, so its failure comment lists the same lines.
 * What GitHub said is left out, as it is for a finding. A ruling naming a thread
 * that was not handed over has nowhere to point at, and is named by the id the
 * reviewer gave.
 */
export function unappliedNotes(handedOver: readonly ReviewThread[], verdicts: AppliedVerdicts): readonly string[] {
  const byId = new Map(handedOver.map((thread) => [thread.id, thread]));
  const at = (thread: ReviewThread, what: string): string => {
    const reading = readThread(thread);
    return line(locationOf(thread), reading.raised === "finding" ? reading.headline : null, what);
  };
  const refused = verdicts.threads.flatMap((applied) => {
    const thread = byId.get(applied.thread);
    if (applied.outcome !== "failed" || thread === undefined) return [];
    const ruled = applied.ruled === null ? "given no ruling, which keeps it open" : `ruled ${applied.ruled}`;
    return [at(thread, `${ruled}, and the thread could not be ${mutated(applied.ruled)}`)];
  });
  const unsent = verdicts.unapplied.map((ruling) => {
    const thread = byId.get(ruling.thread);
    if (thread === undefined) {
      return `A ruling of ${ruling.verdict} on thread \`${oneLine(ruling.thread)}\`, which was not handed to the reviewer, was not applied`;
    }
    return at(thread, `ruled ${ruling.verdict} a second time, which was not applied: the first ruling stands`);
  });
  return [...refused, ...unsent];
}

/**
 * Each reply on a thread the round closed that could not be posted, one line
 * each and with no bullet: the thread where it sits, and what the reviewer
 * ruled on it.
 */
export function unpostedReplyNotes(handedOver: readonly ReviewThread[], verdicts: AppliedVerdicts): readonly string[] {
  const byId = new Map(handedOver.map((thread) => [thread.id, thread]));
  return verdicts.threads.flatMap((applied) => {
    const thread = byId.get(applied.thread);
    const closing = applied.ruled === "fixed" || applied.ruled === "withdrawn";
    if (!closing || applied.reply?.outcome !== "failed" || thread === undefined) return [];
    const reading = readThread(thread);
    return [
      line(
        locationOf(thread),
        reading.raised === "finding" ? reading.headline : null,
        `ruled ${applied.ruled}, and the reviewer's reply could not be posted on its thread`,
      ),
    ];
  });
}

/** One Notes line: where the defect is, what it is, and what became of the finding. */
function line(location: string | undefined, headline: string | null, what?: string): string {
  const disposition = what === undefined ? "" : ` (${what})`;
  const said = named(headline);
  if (location === undefined) return `About the change as a whole: ${said}${disposition}`;
  return `\`${location}\` — ${said}${disposition}`;
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
  const named = namedStates(left.after, left.states);
  return [`- The episode ended at ${how}, and did not review ${eitherOf(named)}`];
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
