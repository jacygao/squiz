/**
 * The failure pointer: the one line a command writes to stderr for each thing
 * that failed, or for a branch with no pull request to review.
 *
 * There is one function because every line has one shape, so a second output
 * format has nowhere to grow.
 */

import { writeToStderr } from "./stderr.ts";

// A pointer naming nothing would read as silence, which a failure must never
// do.
const UNNAMED = "the hook failed for a reason it could not name";

/** The exact bytes of the pointer for `reason`, flattened to one line, newline included. */
export function failureLine(reason: string): string {
  const flattened = oneLine(reason);
  return `squiz: ${flattened === "" ? UNNAMED : flattened}\n`;
}

/**
 * `text` as one line. A line break, with the whitespace around it, becomes one
 * space. Whitespace within a line is left alone, because text can carry a path.
 */
export function oneLine(text: string): string {
  return text.replace(/\s*[\n\r\v\f\u0085\u2028\u2029]\s*/gu, " ").trim();
}

/** Write the failure pointer for `reason` to stderr, and nothing else anywhere. */
export function reportFailure(reason: string): void {
  writeToStderr(failureLine(reason));
}
