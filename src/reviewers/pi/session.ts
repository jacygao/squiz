/**
 * The command that resumes the session a round's `pi` kept.
 *
 * `pi` keeps a session as a `.jsonl` file in the directory `--session-dir`
 * names, and its first line is a header carrying the session's id. `--session`
 * takes that id. The file name carries the id too, but the header is the part
 * `pi` documents.
 */

import { closeSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";

/**
 * Past what any header `pi` writes holds. A first line longer than this is not
 * a header, and reading on would read a whole conversation.
 */
const HEADER_LIMIT = 64 * 1024;

// The ids `pi` accepts, which also keeps the line one word to a shell.
const sessionId = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

type Header = { readonly id: string; readonly started: number };

/**
 * The command line that resumes the latest session kept in `sessionDirectory`,
 * or `undefined` where there is none.
 *
 * `pi` writes nothing until the first assistant message arrives, so a run
 * stopped before then has no session to resume. Run from the directory the
 * reviewer ran in, it resumes the session in place. From anywhere else `pi`
 * offers to fork the session instead.
 */
export function resumeLine(sessionDirectory: string): readonly string[] | undefined {
  let names: string[];
  try {
    names = readdirSync(sessionDirectory);
  } catch {
    return undefined;
  }
  let latest: Header | undefined;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const header = headerOf(join(sessionDirectory, name));
    if (header !== undefined && (latest === undefined || header.started > latest.started)) {
      latest = header;
    }
  }
  return latest === undefined ? undefined : ["pi", "--session-dir", sessionDirectory, "--session", latest.id];
}

/** The header on the first line of `file`, where that line is one `pi` wrote. */
function headerOf(file: string): Header | undefined {
  let line: unknown;
  try {
    line = JSON.parse(firstLine(file));
  } catch {
    return undefined;
  }
  if (typeof line !== "object" || line === null) return undefined;
  const { type, id, timestamp } = line as Record<string, unknown>;
  if (type !== "session" || typeof id !== "string" || !sessionId.test(id)) return undefined;
  const started = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
  return Number.isNaN(started) ? undefined : { id, started };
}

function firstLine(file: string): string {
  const buffer = Buffer.alloc(HEADER_LIMIT);
  const descriptor = openSync(file, "r");
  try {
    const read = readSync(descriptor, buffer, 0, HEADER_LIMIT, 0);
    const text = buffer.subarray(0, read).toString("utf8");
    const end = text.indexOf("\n");
    return end === -1 ? text : text.slice(0, end);
  } finally {
    closeSync(descriptor);
  }
}
