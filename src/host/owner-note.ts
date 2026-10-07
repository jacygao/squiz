/**
 * The note the round host leaves for the session that owns a state, once the
 * state's result is recorded.
 *
 * A note points at the result and carries no finding: what the review found is
 * read with `squiz review`, from the pull request as it stands then.
 *
 * Nothing here touches the filesystem.
 */

import { closedLines, type ClosedBy } from "../github/failure-body.ts";
import type { NoteFields } from "../sessions/notes.ts";
import type { StateRecord } from "../loop/state-record.ts";

/**
 * The note for the owner of `record`, or none.
 *
 * `name` is how the state is told apart from the others in the text. A state
 * with no owner gets no note, and nor does one reviewed clean with the episode
 * open, because the episode is still under way and nothing waits on that state.
 *
 * `closed` is the bound that leaves no round after a failed one. Without it, the
 * note for a failed state promises a retry.
 */
export function ownerNote(pullRequest: number, record: StateRecord, name: string, closed?: ClosedBy): OwnerNote | undefined {
  const { owner } = record;
  if (owner === undefined) return undefined;
  const at = owner.subagent === undefined ? name : `${name}, the work of subagent ${owner.subagent}`;
  const text = textOf(pullRequest, record, at, closed);
  if (text === undefined) return undefined;
  const fields = {
    to: owner.sessionId,
    pr: String(pullRequest),
    head: record.head,
    ...(owner.subagent === undefined ? {} : { subagent: owner.subagent }),
    text,
  };
  return { sessionId: owner.sessionId, fields };
}

export type OwnerNote = { readonly sessionId: string; readonly fields: NoteFields };

function textOf(pullRequest: number, record: StateRecord, at: string, closed: ClosedBy | undefined): string | undefined {
  const review = `\`squiz review ${pullRequest}\``;
  switch (record.status) {
    case "queued":
    case "reviewing":
      return undefined;
    case "reviewed": {
      if (record.result === "clean, episode open") return undefined;
      const reviewed = `Squiz reviewed PR #${pullRequest} at ${at}`;
      const open = record.openThreads.length;
      const them = open === 1 ? "it" : "them";
      if (record.exitStatus === 2) return `${reviewed}: ${threads(open)} ${open === 1 ? "is" : "are"} open. Run ${review} to read ${them}.`;
      if (open === 0) return `${reviewed}: nothing is open, and the episode has closed. Run ${review} to read the close.`;
      return `${reviewed}: the episode has closed with ${threads(open)} open. Run ${review} to read ${them}.`;
    }
    case "failed": {
      const next =
        closed === undefined
          ? [`A new commit, or running ${review} once, retries it.`]
          : closedLines(closed, `A new commit, or running ${review}, posts its summary.`);
      return [`Squiz could not review PR #${pullRequest} at ${at}: ${sentence(record.reason)} \`squiz status\` lists it.`, ...next].join(" ");
    }
    case "not reviewed":
      return `Squiz did not review PR #${pullRequest} at ${at}: ${sentence(record.reason)}`;
  }
}

function threads(count: number): string {
  return count === 1 ? "1 thread" : `${count} threads`;
}

// A reason can come from a tool's own message, which may already end its sentence.
function sentence(reason: string): string {
  return /[.!?]$/u.test(reason) ? reason : `${reason}.`;
}
