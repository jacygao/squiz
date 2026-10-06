/**
 * The line that resumes the session a round's Copilot kept.
 *
 * Copilot keeps each session under `COPILOT_HOME`, in
 * `session-state/<session id>/`, and the first line of its `events.jsonl` is a
 * `session.start` event carrying the id and when it started. A round that ran
 * Copilot twice keeps two, and the later is the round's.
 */

import { closeSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";

/** Past what any `session.start` line holds. Reading on would read a conversation. */
const HEADER_LIMIT = 64 * 1024;

// The ids Copilot writes, which also keeps the line one word to a shell.
const sessionId = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;

/**
 * `COPILOT_HOME=<spelled> copilot --resume=<id>` for the latest session kept in
 * `home`, or `undefined` where there is none that could be read.
 */
export function resumeLine(home: string, spelled: string): readonly string[] | undefined {
  const states = join(home, "session-state");
  let names: string[];
  try {
    names = readdirSync(states);
  } catch {
    return undefined;
  }
  let latest: { readonly id: string; readonly started: number } | undefined;
  for (const name of names) {
    if (!sessionId.test(name)) continue;
    const started = startOf(join(states, name, "events.jsonl"), name);
    if (started !== undefined && (latest === undefined || started > latest.started)) {
      latest = { id: name, started };
    }
  }
  if (latest === undefined) return undefined;
  return [`COPILOT_HOME=${spelled}`, "copilot", `--resume=${latest.id}`];
}

/** When the session `id` started, where its record opens with its own `session.start`. */
function startOf(file: string, id: string): number | undefined {
  let line: string;
  try {
    line = firstLine(file);
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { type, data } = parsed as Record<string, unknown>;
  if (type !== "session.start" || typeof data !== "object" || data === null) return undefined;
  const { sessionId: named, startTime } = data as Record<string, unknown>;
  if (named !== id || typeof startTime !== "string") return undefined;
  const started = Date.parse(startTime);
  return Number.isNaN(started) ? undefined : started;
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
