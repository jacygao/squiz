/**
 * The failure pointer: the one line the hook writes to stderr when a round
 * exits 0 having failed.
 *
 * The hook's other stderr channel, the blocking reason a round exits 2 with,
 * does not come through here. There is one function because there is one line,
 * so a second output format has nowhere to grow.
 */

import { writeToStderr } from "./stderr.ts";

// A pointer naming nothing would read as silence, which a failure must never
// do.
const UNNAMED = "the hook failed for a reason it could not name";

/**
 * The exact bytes of the pointer for `reason`, newline included.
 *
 * Whitespace is collapsed, so a reason that arrived with line breaks in it
 * still leaves as one line.
 */
export function failureLine(reason: string): string {
  const flattened = reason.replace(/\s+/gu, " ").trim();
  return `squiz: ${flattened === "" ? UNNAMED : flattened}\n`;
}

/** Write the failure pointer for `reason` to stderr, and nothing else anywhere. */
export function reportFailure(reason: string): void {
  writeToStderr(failureLine(reason));
}
