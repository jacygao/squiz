/**
 * The wake that starts a turn in an idle owner session: its note's text, posted
 * to the messaging socket its hook recorded.
 *
 * **A session is never woken twice for one note.** The note is claimed by moving
 * it into `delivered/` before the post, so whoever else would deliver it finds it
 * gone. A post that does not arrive puts it back to wait for a pull.
 *
 * Nothing here throws. Every answer is a value the caller reads.
 */

import { postMessage } from "../sessions/messaging.ts";
import { deliverNote, releaseNote } from "../sessions/notes.ts";

// Long enough for a local socket that is being read, and short enough that a
// stalled one does not hold up the host's next round.
const POST_BOUND_MS = 5_000;

export type WakeNote = {
  /** The notes directory the note was written under. */
  readonly notes: string;
  readonly sessionId: string;
  /** The note's name, as its write returned it. */
  readonly name: string;
  readonly socket: string;
  readonly text: string;
};

export type Wake =
  | { readonly outcome: "woken" }
  | { readonly outcome: "already delivered" }
  | { readonly outcome: "not woken"; readonly reason: string };

/** Claim `note` and post its text to the owner's socket. */
export async function wakeOwner(note: WakeNote): Promise<Wake> {
  const claimed = deliverNote(note.notes, note.sessionId, note.name);
  if (claimed.outcome === "lost") return { outcome: "already delivered" };
  if (claimed.outcome === "failed") return { outcome: "not woken", reason: claimed.reason };

  const posted = await postMessage(note.socket, note.text, POST_BOUND_MS);
  if (posted.outcome === "delivered") return { outcome: "woken" };
  const released = releaseNote(note.notes, note.sessionId, note.name);
  if (released.outcome === "failed") return { outcome: "not woken", reason: `${posted.reason}; and ${released.reason}` };
  return { outcome: "not woken", reason: posted.reason };
}
