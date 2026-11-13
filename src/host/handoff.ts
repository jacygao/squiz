/**
 * The handoff: what a fresh coding agent needs to work the threads a round left
 * open, once the agent whose work was reviewed may have ended.
 *
 * It holds the open threads with every reply on them, the change's description,
 * each agent's final report and the path of its transcript, and the diff the
 * reviewer read. A handoff that left any of these out would still read as a
 * whole one, so where the open threads cannot be shown none is composed.
 *
 * Nothing here touches the filesystem or the venue.
 */

import type { Owner, StateRecord } from "../loop/state-record.ts";
import { printedThread } from "../review/output.ts";
import { longestBacktickRun } from "../reviewers/prompt.ts";
import type { Change, ReviewThread } from "../venues/venue.ts";
import { threadsToPrint } from "./owner-note.ts";

export type Handoff =
  /** The round handed nothing back to a coding agent. */
  | { readonly outcome: "none" }
  /** The round left threads open, and the listing shows none of them open. */
  | { readonly outcome: "no open thread listed" }
  | { readonly outcome: "composed"; readonly text: string };

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
  change: Pick<Change, "name" | "head" | "description" | "descriptionFrom" | "followUp">,
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
  const text = [
    `# Handoff for ${at}, round ${round}`,
    `Squiz reviewed ${at} in round ${round}: ${open.length === 1 ? "1 thread is" : `${open.length} threads are`} open.`,
    change.followUp,
    "## The description",
    ...(change.descriptionFrom === "prompt" && change.description.trim() !== ""
      ? ["Nobody wrote a description of this change, so this is the prompt the run was started with:"]
      : []),
    description,
    "## The open threads",
    ...open.map(printedThread),
    "## The agents' final reports",
    ...reports(records),
    "## The diff",
    fenced(diff),
  ].join("\n\n") + "\n";
  return { outcome: "composed", text };
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
