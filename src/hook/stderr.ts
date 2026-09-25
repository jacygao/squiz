/**
 * Writing to the hook's stderr, which is the only place Claude Code surfaces
 * what the hook has to say.
 *
 * By descriptor rather than through `process.stderr`. Claude Code runs the hook
 * with its stderr on a pipe, and on macOS a pipe's writes through
 * `process.stderr` are asynchronous. `process.exit` does not wait for them, so a
 * line written that way is lost exactly when it matters. `fs.writeSync` is a
 * `write(2)` call that has already happened by the time it returns.
 *
 * What is written is the caller's. Two different things go to this stream — the
 * failure pointer a round exits 0 with and the blocking reason a round exits 2
 * with — and each is composed somewhere else, so neither can grow into the
 * other here.
 */

import { writeSync } from "node:fs";

const STDERR = 2;

// A full pipe is the one write error worth waiting out, because the reader is
// Claude Code and it drains. Bounded so the loop ends whatever the descriptor
// does: about a second of waiting, well under the runtime's own kill, which is
// the single failure outside the harness's control.
const WRITE_ATTEMPTS = 1000;

/**
 * Write `text` to stderr, and nothing else anywhere.
 *
 * A stderr that will not take it is swallowed rather than raised. A write that
 * threw while reporting what a round came to would take the exit code with it,
 * and by then there is nowhere left to say so.
 */
export function writeToStderr(text: string): void {
  const bytes = Buffer.from(text, "utf8");
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
