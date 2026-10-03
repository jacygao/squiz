/**
 * Whether a subagent's run ended by handing its report back.
 *
 * A subagent in auto mode reports through a `SubagentHandback` call, and its
 * run is over once that call goes through. The transcript is the one place that
 * says how a run ended: the payload names neither the call nor its absence.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** The tool a subagent in auto mode hands its report back through. */
export const HANDBACK_TOOL = "SubagentHandback";

// Enough for the last assistant entry, which holds the whole report the
// subagent handed back, without reading a transcript of many megabytes whole.
const TAIL_BYTES = 1024 * 1024;

/**
 * True where the last assistant entry in the transcript at `path` calls the
 * hand-back.
 *
 * False wherever that cannot be read, so a transcript that is missing or in a
 * shape not seen before runs the round as it always has. Never throws.
 */
export function endedInHandback(path: string): boolean {
  const tail = tailOf(path);
  if (tail === null) return false;

  const lines = tail.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const entry = parsed(lines[index] ?? "");
    if (entry === null || entry["type"] !== "assistant") continue;
    return callsHandback(entry);
  }
  return false;
}

function callsHandback(entry: Readonly<Record<string, unknown>>): boolean {
  const message = entry["message"];
  if (typeof message !== "object" || message === null) return false;
  const content: unknown = (message as Readonly<Record<string, unknown>>)["content"];
  if (!Array.isArray(content)) return false;
  return content.some(
    (block: unknown) =>
      typeof block === "object" &&
      block !== null &&
      (block as Readonly<Record<string, unknown>>)["type"] === "tool_use" &&
      (block as Readonly<Record<string, unknown>>)["name"] === HANDBACK_TOOL,
  );
}

function parsed(line: string): Readonly<Record<string, unknown>> | null {
  if (line.trim() === "") return null;
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : null;
  } catch {
    // The first line of a tail usually starts mid-entry.
    return null;
  }
}

function tailOf(path: string): string | null {
  let descriptor: number;
  try {
    descriptor = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(descriptor).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(descriptor, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    return null;
  } finally {
    closeSync(descriptor);
  }
}
