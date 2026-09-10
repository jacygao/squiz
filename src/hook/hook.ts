/**
 * The `SubagentStop` entry point: one round.
 * (review-harness-spec, "The `squiz` binary")
 */

import type { HookExit } from "./trap.ts";

/**
 * Run one round, and return the exit it decides: 0 lets the subagent's turn
 * finish, 2 blocks it with the reason on stderr.
 *
 * The gate that decides between them, on whether the branch has a pull request,
 * is #40.
 */
export function runHook(): HookExit {
  return 0;
}
