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

/** Whether a round's session can be resumed, and with what. */
export type Resume =
  | { readonly kind: "resumable"; readonly line: readonly string[] }
  /** The run wrote no session that `pi` would list. */
  | { readonly kind: "none" }
  /**
   * A session may be there, and could not be read. Any line given instead could
   * resume a different conversation from the round's, so none is.
   */
  | { readonly kind: "unreadable"; readonly reason: string };

type Header = { readonly id: string; readonly started: number };

/**
 * How to resume the latest session kept in `sessionDirectory`.
 *
 * `pi` writes nothing until the first assistant message arrives, so a run
 * stopped before then has no session, and neither has a directory never made.
 * Run from the directory the reviewer ran in, the line resumes the session in
 * place. From anywhere else `pi` offers to fork the session instead.
 */
export function resumeLine(sessionDirectory: string): Resume {
  let names: string[];
  try {
    names = readdirSync(sessionDirectory);
  } catch (cause) {
    if (codeOf(cause) === "ENOENT") return { kind: "none" };
    const reason = `${sessionDirectory} could not be listed: ${messageOf(cause)}`;
    return { kind: "unreadable", reason };
  }
  let latest: Header | undefined;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const file = join(sessionDirectory, name);
    let line: string;
    try {
      line = firstLine(file);
    } catch (cause) {
      return { kind: "unreadable", reason: `${file} could not be read: ${messageOf(cause)}` };
    }
    const header = headerIn(line);
    if (header !== undefined && (latest === undefined || header.started > latest.started)) {
      latest = header;
    }
  }
  if (latest === undefined) return { kind: "none" };
  const line = ["pi", "--session-dir", sessionDirectory, "--session", latest.id];
  return { kind: "resumable", line };
}

/** The header `line` holds, where it is one `pi` wrote. */
function headerIn(line: string): Header | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { type, id, timestamp } = parsed as Record<string, unknown>;
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

function codeOf(cause: unknown): unknown {
  return typeof cause === "object" && cause !== null ? (cause as { code?: unknown }).code : undefined;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
