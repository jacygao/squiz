/**
 * The `SubagentStop` entry point: one round.
 * (review-harness-spec, "The `squiz` binary")
 */

import { findPullRequestForBranch } from "../github/pull-request.ts";
import { currentBranch } from "./branch.ts";
import { reportFailure } from "./report.ts";
import type { HookExit } from "./trap.ts";

/**
 * Run one round, and return the exit it decides: 0 lets the subagent's turn
 * finish, 2 blocks it with the reason on stderr.
 *
 * The gate comes first: a branch with no pull request ends the round here,
 * having posted nothing, run nothing and said nothing.
 * (review-harness-spec, "A round, step by step")
 */
export function runHook(): HookExit {
  // The hook reads nothing from the payload. Everything the gate needs comes
  // from git and gh, asked from the directory the hook was fired in.
  const directory = process.cwd();

  const branch = currentBranch(directory);
  if (branch.outcome === "failed") {
    reportFailure(`no review ran: the current branch could not be resolved: ${branch.reason}`);
    return 0;
  }
  // A detached HEAD is no branch, so no pull request can have it as a head.
  // That is an answer of none rather than a failure, and none is silent.
  if (branch.outcome === "detached") return 0;

  const pullRequest = findPullRequestForBranch(branch.name, directory);
  if (pullRequest.outcome === "failed") {
    const named = JSON.stringify(branch.name);
    reportFailure(
      `no review ran: the pull request for ${named} could not be looked up: ${pullRequest.reason}`,
    );
  }

  // Both remaining outcomes end the round here. Spawning the reviewer against
  // the number is the step after the gate.
  // (review-harness-spec, "A round, step by step")
  return 0;
}
