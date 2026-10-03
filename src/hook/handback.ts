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

// The transcript is read backwards in steps of this size, so a long one is not
// read whole. The last assistant entry holds the whole report and has no bound.
const CHUNK_BYTES = 1024 * 1024;

/**
 * True where the last assistant entry in the transcript at `path` calls the
 * hand-back.
 *
 * False wherever that cannot be read, so a transcript that is missing or in a
 * shape not seen before runs the round as it always has. Never throws.
 */
export function endedInHandback(path: string): boolean {
  const last = lastAssistantEntry(path);
  return last !== null && callsHandback(last);
}

/**
 * The last entry of type `assistant`, reading back from the end until one
 * whole line holds it, or `null` where there is none or the file cannot be read.
 */
function lastAssistantEntry(path: string): Readonly<Record<string, unknown>> | null {
  let descriptor: number;
  try {
    descriptor = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    let position = fstatSync(descriptor).size;
    // Bytes from `position` to the end of the file that are not yet a whole line.
    let pending = Buffer.alloc(0);
    while (position > 0) {
      const length = Math.min(position, CHUNK_BYTES);
      position -= length;
      const chunk = Buffer.alloc(length);
      readSync(descriptor, chunk, 0, length, position);
      pending = Buffer.concat([chunk, pending]);

      // Every line after the first newline is whole. Before it, the line may
      // start in a chunk not read yet, unless the file starts here.
      const firstBreak = position === 0 ? -1 : pending.indexOf(0x0a);
      if (position > 0 && firstBreak === -1) continue;
      const whole = pending.subarray(firstBreak + 1).toString("utf8").split("\n");
      for (let index = whole.length - 1; index >= 0; index--) {
        const entry = parsed(whole[index] ?? "");
        if (entry !== null && entry["type"] === "assistant") return entry;
      }
      pending = pending.subarray(0, firstBreak + 1);
    }
    return null;
  } catch {
    return null;
  } finally {
    closeSync(descriptor);
  }
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
    return null;
  }
}
