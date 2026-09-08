// The top-level trap. § 7 says every failure the harness controls exits 0: the
// hook may fail in any way except by preventing the coding agent from finishing
// its turn, and a non-zero exit is exactly that. So a throw from anywhere
// beneath the entry point ends the hook at exit 0, with one line on stderr
// naming what failed. Exiting 0 in silence would read as a clean review, which
// § 7 forbids just as firmly.

import { reportFailure } from "./report.ts";

/** The two exits § 3 gives a round: 0 lets the turn finish, 2 blocks it. */
export type HookExit = 0 | 2;

/**
 * Run the hook's entry point with the trap around it.
 *
 * A `main` that returns decides the exit code. A `main` that fails in any way —
 * by throwing, by rejecting, or by leaving a rejection or a throw behind in a
 * callback the entry point is no longer waiting on — exits 0 and writes the
 * failure pointer.
 */
export async function runUnderTrap(main: () => HookExit | Promise<HookExit>): Promise<void> {
  // A `try` around the call catches neither of the last two. Node's default for
  // an unhandled rejection is a non-zero exit, so without these listeners a
  // promise nobody awaited decides whether the coding agent finishes its turn.
  process.on("uncaughtException", reportAndExit);
  process.on("unhandledRejection", reportAndExit);

  let exit: HookExit;
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

function reportAndExit(error: unknown): never {
  reportFailure(`the hook failed: ${describe(error)}`);
  process.exit(0);
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
