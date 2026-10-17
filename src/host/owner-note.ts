/**
 * The note the round host leaves for the session that owns a state, once the
 * state's result is recorded.
 *
 * A note for open threads carries them, so that a woken session has its work in
 * front of it.
 *
 * Nothing here touches the filesystem or GitHub.
 */

import { closedLines, type ClosedBy } from "../github/failure-body.ts";
import type { ReviewThread } from "../github/threads.ts";
import { printedThread, workTheThreads } from "../review/output.ts";
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
 *
 * `listed` is the review threads on the pull request as they stand. A note for
 * open threads prints those of them the round left open and that are still
 * open. Where it is absent, or holds none of them, the note points to
 * `squiz review`.
 */
export function ownerNote(
  pullRequest: number,
  record: StateRecord,
  name: string,
  closed?: ClosedBy,
  listed?: readonly ReviewThread[],
): OwnerNote | undefined {
  const { owner } = record;
  if (owner === undefined) return undefined;
  const at = owner.subagent === undefined ? name : `${name}, the work of subagent ${owner.subagent}`;
  const text = textOf(pullRequest, record, at, closed, listed);
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

// The wake carries the note whole, and no runtime has said how much text it takes.
const PRINTED_THREADS = 10;

function textOf(
  pullRequest: number,
  record: StateRecord,
  at: string,
  closed: ClosedBy | undefined,
  listed: readonly ReviewThread[] | undefined,
): string | undefined {
  const review = `\`squiz review ${pullRequest}\``;
  switch (record.status) {
    case "queued":
    case "reviewing":
      return undefined;
    case "reviewed": {
      if (record.result === "clean, episode open") return undefined;
      const reviewed = `Squiz reviewed PR #${pullRequest} at ${at}`;
      if (record.openThreads.length === 0) return `${reviewed}: nothing is open, and the episode has closed. Run ${review} to read the close.`;
      const open = threadsToPrint(record.openThreads, listed ?? []);
      const counted = open.length > 0 ? open.length : record.openThreads.length;
      const heading =
        record.exitStatus === 2
          ? `${reviewed}: ${threads(counted)} ${counted === 1 ? "is" : "are"} open`
          : `${reviewed}: the episode has closed with ${threads(counted)} open`;
      if (open.length === 0) return `${heading}. Run ${review} to read ${counted === 1 ? "it" : "them"}.`;
      const rest = open.length - PRINTED_THREADS;
      return [
        `${heading}:`,
        ...open.slice(0, PRINTED_THREADS).map(printedThread),
        ...(record.exitStatus === 2 ? [workTheThreads(pullRequest)] : []),
        ...(rest > 0 ? [`${rest} more ${rest === 1 ? "thread is" : "threads are"} open. ${review} prints them all.`] : []),
      ].join("\n\n");
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

/** The threads of `listed` that are among `openThreads` and still open, in the listing's order. */
export function threadsToPrint(openThreads: readonly string[], listed: readonly ReviewThread[]): readonly ReviewThread[] {
  return listed.filter((thread) => !thread.isResolved && openThreads.includes(thread.id));
}

function threads(count: number): string {
  return count === 1 ? "1 thread" : `${count} threads`;
}

// A reason can come from a tool's own message, which may already end its sentence.
function sentence(reason: string): string {
  return /[.!?]$/u.test(reason) ? reason : `${reason}.`;
}
