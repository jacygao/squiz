/**
 * Notes left for a session, one file each, and their delivery.
 *
 * A session's notes are the files in `<directory>/<session id>/`, as `key=value`
 * lines. The keys are the caller's.
 *
 * - **A note is never seen half-written.** It is written under a temporary name
 *   in the same directory, which no listing returns, and renamed into place.
 * - **The name carries the order.** It begins with the millisecond it was written
 *   and a sequence within that millisecond, because modification times share a
 *   second and can be changed.
 * - **Delivery is the move into `delivered/`.** A rename succeeds for exactly one
 *   of the processes that race for it, so whoever moves the note delivers it, and
 *   every other is told it lost.
 * - **A value stays on its line.** A backslash, a line feed and a carriage return
 *   in it are written as `\\`, `\n` and `\r`, and read back as themselves.
 *
 * A session id and a note's name become paths, so each must be one plain name.
 *
 * Nothing here throws. Every answer is a value the caller reads.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type NoteFields = Readonly<Record<string, string>>;

export type Written =
  | { readonly outcome: "written"; readonly name: string }
  | { readonly outcome: "failed"; readonly reason: string };

export type WaitingNote =
  | { readonly outcome: "read"; readonly name: string; readonly fields: NoteFields }
  | { readonly outcome: "unreadable"; readonly name: string; readonly reason: string };

export type Listing =
  | { readonly outcome: "listed"; readonly notes: readonly WaitingNote[] }
  | { readonly outcome: "failed"; readonly reason: string };

export type Delivery =
  | { readonly outcome: "delivered" }
  | { readonly outcome: "lost" }
  | { readonly outcome: "failed"; readonly reason: string };

// Starting with a letter or digit rules out `.`, `..` and hidden names.
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const KEY = /^[A-Za-z0-9_.-]+$/u;
const NOTE_NAME = /^(\d{15})-(\d{6,})-([0-9a-f]{16})\.note$/u;

let lastWrittenAt = 0;
let sequence = 0;

/** Write `fields` as a note for `sessionId`, and resolve with the note's name. */
export function writeNote(directory: string, sessionId: string, fields: NoteFields): Written {
  if (!SESSION_ID.test(sessionId)) return { outcome: "failed", reason: `${JSON.stringify(sessionId)} is no session id` };
  const lines: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!KEY.test(key)) return { outcome: "failed", reason: `${JSON.stringify(key)} is no key` };
    lines.push(`${key}=${encode(value)}\n`);
  }

  const session = join(directory, sessionId);
  const name = nextName();
  const temporary = join(session, `.${name}.tmp`);
  try {
    mkdirSync(session, { recursive: true });
    writeFileSync(temporary, lines.join(""), { flag: "wx" });
    renameSync(temporary, join(session, name));
  } catch (error) {
    const reason = `the note for ${sessionId} was not written: ${describe(error)}`;
    // The path that refused the write can refuse its cleanup too, and `force` excuses only a missing file.
    try {
      rmSync(temporary, { force: true });
    } catch (cleanup) {
      return { outcome: "failed", reason: `${reason}; and its temporary file was not removed: ${describe(cleanup)}` };
    }
    return { outcome: "failed", reason };
  }
  return { outcome: "written", name };
}

/** The notes waiting for `sessionId`, oldest first. A session with no directory has none. */
export function waitingNotes(directory: string, sessionId: string): Listing {
  if (!SESSION_ID.test(sessionId)) return { outcome: "failed", reason: `${JSON.stringify(sessionId)} is no session id` };
  const session = join(directory, sessionId);
  let entries: string[];
  try {
    entries = readdirSync(session);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return { outcome: "listed", notes: [] };
    return { outcome: "failed", reason: `the notes for ${sessionId} were not listed: ${describe(error)}` };
  }

  const notes: WaitingNote[] = [];
  for (const name of entries.filter((entry) => NOTE_NAME.test(entry)).sort(oldestFirst)) {
    let text: string;
    try {
      text = readFileSync(join(session, name), "utf8");
    } catch (error) {
      // Delivered by someone else since the directory was read.
      if (codeOf(error) === "ENOENT") continue;
      notes.push({ outcome: "unreadable", name, reason: describe(error) });
      continue;
    }
    const parsed = parse(text);
    notes.push(typeof parsed === "string" ? { outcome: "unreadable", name, reason: parsed } : { outcome: "read", name, fields: parsed });
  }
  return { outcome: "listed", notes };
}

/**
 * Claim the note `name` for `sessionId` by moving it into `delivered/` beside it.
 *
 * Resolves lost when the note is no longer waiting, which is what a deliverer
 * that lost the race is told. Only a caller told delivered may deliver it.
 */
export function deliverNote(directory: string, sessionId: string, name: string): Delivery {
  if (!SESSION_ID.test(sessionId)) return { outcome: "failed", reason: `${JSON.stringify(sessionId)} is no session id` };
  if (!NOTE_NAME.test(name)) return { outcome: "failed", reason: `${JSON.stringify(name)} is no note's name` };
  const session = join(directory, sessionId);
  try {
    mkdirSync(join(session, "delivered"));
  } catch (error) {
    const code = codeOf(error);
    // A session with no directory has no note to deliver.
    if (code === "ENOENT") return { outcome: "lost" };
    if (code !== "EEXIST") return { outcome: "failed", reason: `delivered/ was not made: ${describe(error)}` };
  }
  try {
    renameSync(join(session, name), join(session, "delivered", name));
  } catch (error) {
    if (codeOf(error) === "ENOENT") return { outcome: "lost" };
    return { outcome: "failed", reason: `${name} was not moved into delivered/: ${describe(error)}` };
  }
  return { outcome: "delivered" };
}

// The sequence orders notes this process writes within one millisecond, and
// keeps them in order if the clock steps back. Notes written by two processes
// in the same millisecond have no order to keep, and the random part settles it.
function nextName(): string {
  const now = Date.now();
  if (now > lastWrittenAt) {
    lastWrittenAt = now;
    sequence = 0;
  } else {
    sequence++;
  }
  const at = String(lastWrittenAt).padStart(15, "0");
  return `${at}-${String(sequence).padStart(6, "0")}-${randomBytes(8).toString("hex")}.note`;
}

// Compared as numbers, because a sequence past six digits outgrows its padding.
function oldestFirst(left: string, right: string): number {
  const [, leftAt = "", leftSequence = "", leftRandom = ""] = NOTE_NAME.exec(left) ?? [];
  const [, rightAt = "", rightSequence = "", rightRandom = ""] = NOTE_NAME.exec(right) ?? [];
  return (
    Number(leftAt) - Number(rightAt) ||
    Number(leftSequence) - Number(rightSequence) ||
    (leftRandom < rightRandom ? -1 : leftRandom > rightRandom ? 1 : 0)
  );
}

function encode(value: string): string {
  return value.replace(/[\\\n\r]/gu, (character) => (character === "\\" ? "\\\\" : character === "\n" ? "\\n" : "\\r"));
}

/** The fields `text` holds, or why it holds none. */
function parse(text: string): NoteFields | string {
  if (!text.endsWith("\n")) return "the note does not end its last line";
  const fields: Record<string, string> = {};
  for (const line of text.slice(0, -1).split("\n")) {
    const at = line.indexOf("=");
    const key = line.slice(0, at);
    if (at < 0 || !KEY.test(key)) return `${JSON.stringify(line.slice(0, 80))} is no key=value line`;
    if (Object.hasOwn(fields, key)) return `${key} appears twice`;
    const value = decode(line.slice(at + 1));
    if (value === undefined) return `the value of ${key} has an escape no writer writes`;
    fields[key] = value;
  }
  return fields;
}

function decode(encoded: string): string | undefined {
  let broken = false;
  const decoded = encoded.replace(/\\(.?)/gsu, (_, escaped: string) => {
    if (escaped === "\\") return "\\";
    if (escaped === "n") return "\n";
    if (escaped === "r") return "\r";
    broken = true;
    return "";
  });
  return broken ? undefined : decoded;
}

function codeOf(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
