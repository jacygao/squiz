/**
 * The root of the worktree a hook fired in, resolved by asking git.
 *
 * It is resolved rather than read. The payload's `cwd` and the hook process's
 * own working directory are both the session's directory, which is only the
 * worktree root when the session happened to be started there, and two sessions
 * started in two subdirectories of one shared tree carry two of them. The
 * toplevel is the one answer that is normalised, stable across firings, and the
 * same for every session inside one worktree.
 */

import { spawnSync } from "node:child_process";

/** Where the worktree's root is, or why git could not say. */
export type ToplevelLookup =
  | { readonly outcome: "resolved"; readonly path: string }
  | { readonly outcome: "failed"; readonly reason: string };

/**
 * Ask git for the root of the worktree holding `directory`.
 *
 * Never throws. A git that is missing, a directory that is no repository and a
 * git that answered nothing all come back as `failed`, carrying the reason as a
 * single line.
 */
export function worktreeToplevel(directory: string): ToplevelLookup {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: directory,
    encoding: "utf8",
  });

  if (result.error !== undefined) {
    return failed(`git could not be run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const said = result.stderr.split("\n", 1)[0]?.trim() ?? "";
    const exit = describeExit(result.status, result.signal);
    return failed(said === "" ? `${exit} and said nothing` : `${exit}: ${said}`);
  }

  const path = result.stdout.trim();
  // A bare repository has no worktree, and git answers one with an empty line.
  // The episode's state and the code under review both live in a worktree, so
  // there is nothing here to run a round against.
  if (path === "") return failed("git named no worktree for this directory");
  return { outcome: "resolved", path };
}

function failed(reason: string): ToplevelLookup {
  return { outcome: "failed", reason };
}

function describeExit(status: number | null, signal: NodeJS.Signals | null): string {
  return status === null ? `git was killed by ${signal ?? "a signal"}` : `git exited ${status}`;
}
