/**
 * The branch the hook fired on, resolved by asking git from the working
 * directory the hook was given.
 *
 * The branch is resolved rather than read: the payload's `cwd` and the hook's
 * own working directory are the session's directory, which is somewhere inside
 * the worktree and not necessarily its root. A branch answers the same from any
 * subdirectory, so this is all the gate needs.
 * (docs/notes/the-worktree-toplevel-separates-concurrent-subagents.md)
 */

import { spawnSync } from "node:child_process";

/** What asking git established. `failed` carries the line the caller reports. */
export type BranchLookup =
  | { readonly outcome: "branch"; readonly name: string }
  | { readonly outcome: "detached" }
  | { readonly outcome: "failed"; readonly reason: string };

// git says "HEAD is not a symbolic ref" by exiting 1, and every other failure,
// a directory that is no repository included, by exiting 128.
const DETACHED = 1;

/**
 * Ask git which branch is checked out in `directory`.
 *
 * `symbolic-ref` rather than `rev-parse --abbrev-ref`, because its exit status
 * separates a detached HEAD from a git that could not answer at all.
 * `rev-parse` prints the literal `HEAD` for a detached HEAD, and a caller
 * cannot tell that from a branch of that name.
 *
 * Never throws. A git that is missing or that failed comes back as `failed`,
 * carrying the reason as a single line.
 */
export function currentBranch(directory: string): BranchLookup {
  const result = spawnSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd: directory,
    encoding: "utf8",
  });

  if (result.error !== undefined) {
    return failed(`git could not be run: ${result.error.message}`);
  }
  if (result.status === DETACHED) return { outcome: "detached" };
  if (result.status !== 0) {
    const said = result.stderr.split("\n", 1)[0]?.trim() ?? "";
    const exit = describeExit(result.status, result.signal);
    return failed(said === "" ? `${exit} and said nothing` : `${exit}: ${said}`);
  }

  const name = result.stdout.trim();
  // A git that exits 0 having named no branch has answered a question nobody
  // asked. Reporting it as a failure is the only reading that stays honest.
  if (name === "") return failed("git named no branch and gave no reason");
  return { outcome: "branch", name };
}

function failed(reason: string): BranchLookup {
  return { outcome: "failed", reason };
}

function describeExit(status: number | null, signal: NodeJS.Signals | null): string {
  return status === null ? `git was killed by ${signal ?? "a signal"}` : `git exited ${status}`;
}
