/**
 * The top-level trap. A throw from anywhere beneath the entry point ends the
 * process with one line on stderr naming what failed, at exit 0 for the hook.
 *
 * Every failure the harness controls exits 0, because a non-zero exit is the
 * one thing that stops the coding agent finishing its turn. Exiting 0 in
 * silence is forbidden just as firmly: it would read as a clean review.
 */

import { reportFailure } from "./report.ts";

// The two exits a round has: 0 lets the turn finish, 2 blocks it.
export type HookExit = 0 | 2;

/**
 * How a throw ends the process. The hook's is the default.
 *
 * `squiz review` passes exit 1, because a run whose status reads as an outcome
 * after a throw would have the coding agent act on a review that never ran.
 */
export type Trapped = { readonly exit: number; readonly failed: string };

const hookTrapped: Trapped = { exit: 0, failed: "the hook failed" };

/**
 * Run the entry point with the trap around it.
 *
 * A `main` that returns decides the exit code. A `main` that fails in any way —
 * by throwing, by rejecting, or by leaving a rejection or a throw behind in a
 * callback the entry point is no longer waiting on — exits as `trapped` says
 * and writes the failure pointer.
 */
export async function runUnderTrap(main: () => number | Promise<number>, trapped: Trapped = hookTrapped): Promise<void> {
  function reportAndExit(error: unknown): never {
    reportFailure(`${trapped.failed}: ${describe(error)}`);
    process.exit(trapped.exit);
  }
  // A `try` around the call catches neither of the last two. Node's default for
  // an unhandled rejection is a non-zero exit, so without these listeners a
  // promise nobody awaited decides whether the coding agent finishes its turn.
  process.on("uncaughtException", reportAndExit);
  process.on("unhandledRejection", reportAndExit);

  let exit: number;
  try {
    exit = await main();
  } catch (error) {
    reportAndExit(error);
  }

  // Set rather than exited. Exiting here would end the process with the entry
  // point's own output still queued, and would end it before anything left
  // pending could fail and be reported. The failure path cannot afford that
  // patience and does not need it: its one line is written by a `write(2)`
  // that has already returned.
  process.exitCode = exit;
}

/** What was thrown, in as much of one line as it can account for. */
function describe(error: unknown): string {
  try {
    if (error instanceof Error) {
      return error.message === "" ? error.name : `${error.name}: ${error.message}`;
    }
    return String(error);
  } catch {
    // A thrown object whose own description throws. It happened, and that is
    // the whole of what can be said about it.
    return "something that could not be described";
  }
}
