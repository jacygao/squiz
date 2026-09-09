/**
 * The failure pointer: the one line the hook writes to stderr when a round
 * exits 0 having failed.
 *
 * The hook's other stderr channel, the blocking reason a round exits 2 with,
 * does not come through here. There is one function because there is one line,
 * so a second output format has nowhere to grow.
 * (review-harness-spec, "The hook's stderr")
 */

import { writeSync } from "node:fs";

// Written to by descriptor rather than through `process.stderr`. Claude Code
// runs the hook with its stderr on a pipe, and on macOS a pipe's writes through
// `process.stderr` are asynchronous. `process.exit` does not wait for them, so
// a pointer written that way is lost exactly when it matters. `fs.writeSync` is
// a `write(2)` call that has already happened by the time it returns.
const STDERR = 2;

// A pointer naming nothing would read as silence, which a failure must never
// do. (review-harness-spec, "Failure modes")
const UNNAMED = "the hook failed for a reason it could not name";

// A full pipe is the one write error worth waiting out, because the reader is
// Claude Code and it drains. Bounded so the loop ends whatever the descriptor
// does: about a second of waiting, well under the runtime's own kill, which is
// the single failure outside the harness's control.
// (review-harness-spec, "Failure modes")
const WRITE_ATTEMPTS = 1000;

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

/**
 * Write the failure pointer for `reason` to stderr, and nothing else anywhere.
 *
 * A stderr that will not take the line is swallowed rather than raised. A
 * reporter that threw while reporting a failure would take the exit code with
 * it, and by then there is nowhere left to say so.
 */
export function reportFailure(reason: string): void {
  const bytes = Buffer.from(failureLine(reason), "utf8");
  let written = 0;
  for (let attempt = 0; written < bytes.length && attempt < WRITE_ATTEMPTS; attempt += 1) {
    try {
      written += writeSync(STDERR, bytes, written);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") {
        return;
      }
      waitForTheReader();
    }
  }
}

/** A synchronous millisecond. Retrying without one would spin. */
function waitForTheReader(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
}
