/**
 * The handoff: what a fixer needs to work the threads a round left open, once
 * the agent whose work was reviewed may have ended. The episode's first fixer
 * starts on it, and a later round resumes that fixer on its update instead.
 *
 * It holds the open threads with every reply on them, the round's findings no
 * thread holds, the change's description, each agent's final report and the
 * path of its transcript, and the diff the reviewer read. A handoff that left any of these out would still read as a
 * whole one, so where the open threads cannot be shown none is composed.
 *
 * Nothing here touches the filesystem or the venue.
 */

import type { Owner, StateRecord } from "../loop/state-record.ts";
import { printedThread } from "../review/output.ts";
import { longestBacktickRun } from "../reviewers/prompt.ts";
import { threadLine } from "../findings/listing.ts";
import type { Change, ReviewThread, ThreadComment } from "../venues/venue.ts";
import { NO_REVIEW } from "./fixer.ts";
import { threadsToPrint } from "./owner-note.ts";

export type Handoff =
  /** The round handed nothing back to a coding agent. */
  | { readonly outcome: "none" }
  /** The round left threads open, and the listing shows none of them open. */
  | { readonly outcome: "no open thread listed" }
  /** `known` is what the agent handed the text knows of the threads once it has read it. */
  | { readonly outcome: "composed"; readonly text: string; readonly known: Known };

/**
 * What a fixer has been handed: the node id of every comment it has been shown,
 * of each thread that was open when it was last handed anything, and the Notes
 * line of each finding no thread holds that it has been handed.
 */
export type Known = { readonly shown: readonly string[]; readonly open: readonly string[]; readonly noted?: readonly string[] };

/**
 * How a fixer answers a finding no thread holds. There is no thread to reply
 * on, and its final message is what its stop records.
 */
const ON_NO_THREAD =
  "No thread holds these, so there is nothing to reply on. Fix what applies, and say in your final message what you changed for each, or why you changed nothing.";

/**
 * The handoff for `record`, the state a round has just recorded, on `change`.
 *
 * Only a round that left threads open with a round remaining hands anything
 * back, so only that one gets a handoff. `listed` is the threads on the change
 * as they stand, `diff` the change's diff as the reviewer read it, and
 * `records` the episode's records in order, whose owners give each agent's
 * report.
 */
export function handoffFor(
  change: Pick<Change, "name" | "head" | "description" | "descriptionFrom" | "fixerFollowUp">,
  record: StateRecord,
  listed: readonly ReviewThread[],
  diff: string,
  records: readonly StateRecord[],
): Handoff {
  if (!handsBack(record)) return { outcome: "none" };
  const open = threadsToPrint(record.openThreads, listed);
  if (open.length === 0) return { outcome: "no open thread listed" };

  const at = `${change.name} at ${record.head.slice(0, 7)}`;
  const round = record.round.number;
  const description = change.description.trim() === "" ? "The change has no description." : change.description.trim();
  const noted = record.unthreaded ?? [];
  const onNoThread = noted.length === 0 ? "" : `, and ${noted.length === 1 ? "1 finding is" : `${noted.length} findings are`} on no thread`;
  const text = [
    `# Handoff for ${at}, round ${round}`,
    `Squiz reviewed ${at} in round ${round}: ${open.length === 1 ? "1 thread is" : `${open.length} threads are`} open${onNoThread}.`,
    nextStep(change),
    "## The description",
    ...(change.descriptionFrom === "prompt" && change.description.trim() !== ""
      ? ["Nobody wrote a description of this change, so this is the prompt the run was started with:"]
      : []),
    description,
    "## The open threads",
    ...open.map(printedThread),
    ...unthreadedSection("## Findings on no thread", noted),
    "## The agents' final reports",
    ...reports(records),
    "## The diff",
    fenced(diff),
  ].join("\n\n") + "\n";
  return {
    outcome: "composed",
    text,
    known: { shown: commentsOf(open), open: open.map((thread) => thread.id), ...(noted.length === 0 ? {} : { noted }) },
  };
}

/**
 * What a resumed fixer is handed for `record`: what changed on `listed` since
 * it was last handed anything, which `known` says.
 *
 * That is each open thread that was not open then, whole, so a reopened thread
 * comes with its history; each new comment on a thread open then and still
 * open, the reviewer's ruling among them; each thread open then that has closed,
 * with its new comments if it has any; the open threads with nothing new, by
 * name; and each finding the round left on no thread that it was not handed
 * before, so that one raised again is not handed twice.
 */
export function updateFor(
  change: Pick<Change, "name" | "fixerFollowUp">,
  record: StateRecord,
  listed: readonly ReviewThread[],
  known: Known,
): Handoff {
  if (!handsBack(record)) return { outcome: "none" };
  const open = threadsToPrint(record.openThreads, listed);
  if (open.length === 0) return { outcome: "no open thread listed" };

  const seen = new Set(known.shown);
  const wasOpen = new Set(known.open);
  const unseen = (thread: ReviewThread): readonly ThreadComment[] => thread.comments.filter((comment) => !seen.has(comment.id));
  const fresh = open.filter((thread) => !wasOpen.has(thread.id));
  const replied = open.filter((thread) => wasOpen.has(thread.id) && unseen(thread).length > 0);
  const quiet = open.filter((thread) => wasOpen.has(thread.id) && unseen(thread).length === 0);
  // A thread can close with no new comment: a ruling whose reply failed to post still resolves it.
  const closed = listed.filter((thread) => !open.includes(thread) && wasOpen.has(thread.id));
  const noted = new Set(known.noted ?? []);
  const newlyNoted = [...new Set(record.unthreaded ?? [])].filter((note) => !noted.has(note));

  const at = `${change.name} at ${record.head.slice(0, 7)}`;
  const round = record.round.number;
  const section = (heading: string, threads: readonly ReviewThread[], print: (thread: ReviewThread) => string): readonly string[] =>
    threads.length === 0 ? [] : [heading, ...threads.map(print)];
  const withNew = (thread: ReviewThread): string => printedComments(thread, unseen(thread));
  const text = [
    `# Update for ${at}, round ${round}`,
    `Squiz reviewed ${at} again in round ${round}: ${open.length === 1 ? "1 thread is" : `${open.length} threads are`} open. This holds only what changed since your last handoff.`,
    nextStep(change),
    ...section("## New threads", fresh, printedThread),
    ...section("## New replies on threads still open", replied, withNew),
    ...section("## Threads closed since", closed, withNew),
    ...section("## Still open, with nothing new", quiet, threadLine),
    ...unthreadedSection("## New findings on no thread", newlyNoted),
  ].join("\n\n") + "\n";
  const allNoted = [...noted, ...newlyNoted];
  return {
    outcome: "composed",
    text,
    known: {
      shown: [...new Set([...known.shown, ...commentsOf([...open, ...closed])])],
      open: open.map((thread) => thread.id),
      ...(allNoted.length === 0 ? {} : { noted: allNoted }),
    },
  };
}

/** `notes` under `heading`, with how to answer them, or nothing where there are none. */
function unthreadedSection(heading: string, notes: readonly string[]): readonly string[] {
  return notes.length === 0 ? [] : [heading, ON_NO_THREAD, notes.map((note) => `- ${note}`).join("\n")];
}

/** What a fixer does next, as its prompt says it. */
function nextStep(change: Pick<Change, "fixerFollowUp">): string {
  return `${change.fixerFollowUp}\n${NO_REVIEW}`;
}

function commentsOf(threads: readonly ReviewThread[]): readonly string[] {
  return threads.flatMap((thread) => thread.comments.map((comment) => comment.id));
}

/** `thread`'s line, then each of `comments` indented under it, as `printedThread` gives a reply. */
function printedComments(thread: ReviewThread, comments: readonly ThreadComment[]): string {
  const bodies = comments.map((comment) => trimmed(comment.body).map((line) => (line.trim() === "" ? "" : `  ${line}`)).join("\n"));
  return bodies.length === 0 ? threadLine(thread) : [threadLine(thread), bodies.join("\n\n")].join("\n");
}

/** The lines of `body`, without the blank lines that open and close it. */
function trimmed(body: string): readonly string[] {
  const lines = body.split(/\r\n|\r|\n/u);
  while (lines.length > 0 && (lines[0] ?? "").trim() === "") lines.shift();
  while (lines.length > 0 && (lines.at(-1) ?? "").trim() === "") lines.pop();
  return lines;
}

/** Whether `record` hands its threads back to a coding agent: it left them open with a round remaining. */
export function handsBack(record: StateRecord): record is Extract<StateRecord, { readonly result: "exited" }> {
  return record.status === "reviewed" && record.result === "exited" && record.exitStatus === 2;
}

/** A section for each agent the records name, in the order each first appears, from its latest stop. */
function reports(records: readonly StateRecord[]): readonly string[] {
  const latest = new Map<string, Owner>();
  for (const { owner } of records) {
    if (owner === undefined) continue;
    const agent = `${owner.sessionId} ${owner.subagent ?? ""}`;
    // A key set again keeps the place it was first set in.
    latest.set(agent, owner);
  }
  if (latest.size === 0) return ["No agent's stop was recorded for this episode."];
  return [...latest.values()].flatMap((owner) => [
    owner.subagent === undefined
      ? `### Session ${owner.sessionId}`
      : `### Subagent ${owner.subagent}, dispatched by session ${owner.sessionId}`,
    ...(owner.transcript === undefined ? [] : [`Transcript: ${owner.transcript}`]),
    ...(owner.transcript !== undefined || owner.parentTranscript === undefined
      ? []
      : [`Transcript: none of its own. Its events are in its parent's transcript, ${owner.parentTranscript}`]),
    ...(owner.lastMessage === undefined ? [] : [owner.lastMessage.trim()]),
    ...(owner.transcript === undefined && owner.parentTranscript === undefined && owner.lastMessage === undefined
      ? ["No final report or transcript was recorded for it."]
      : []),
  ]);
}

/** `diff` in a fence longer than any run of backticks inside it. */
function fenced(diff: string): string {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(diff) + 1));
  return `${fence}diff\n${diff.endsWith("\n") || diff === "" ? diff : `${diff}\n`}${fence}`;
}
