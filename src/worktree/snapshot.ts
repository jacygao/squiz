/**
 * A round's snapshot: a detached worktree at the head commit under review,
 * which only the reviewer reads and writes.
 *
 * The coding agent may be editing its own worktree while the round runs, so the
 * reviewer never reads that. The snapshot sits under the gitignored `.squiz/`
 * inside the agent's worktree and shares its object store, so it shows in
 * neither the agent's `git status` nor its commits.
 *
 * Nothing here throws. Each failure comes back as a reason for the caller to
 * report.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Deadline } from "../reviewers/deadline.ts";
import { runGit } from "./git.ts";

/** The snapshot made, and whether its commit had to be fetched first, or why not. */
export type SnapshotAddition =
  | { readonly outcome: "added"; readonly path: string; readonly fetched: boolean }
  | {
      readonly outcome: "failed";
      readonly reason: string;
      /**
       * Where git made the snapshot before the add failed, for the caller to
       * remove once the round has its result. Absent where nothing was made.
       */
      readonly leftBehind?: string;
    };

export type SnapshotRemoval =
  | { readonly outcome: "removed" }
  | { readonly outcome: "failed"; readonly reason: string };

/** Which round the snapshot is for, and the head commit GitHub reports for it. */
export type SnapshotOf = {
  readonly pullRequest: number;
  readonly round: number;
  readonly commit: string;
};

// A full object name, SHA-1 or SHA-256. Anything else may name a branch that
// moves, or reach git as an option.
const FULL_COMMIT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/**
 * Add the round's snapshot at `.squiz/<pull request>/rounds/<round>/tree` inside
 * `worktree`, the coding agent's worktree root.
 *
 * Where the repository lacks the commit it is fetched from `origin` first, and
 * checked for again before anything is added: a snapshot of anything else is
 * worse than none.
 *
 * `until` bounds every git call, and a call with nothing left on it is not
 * started. Fails where:
 *
 * - the commit is not a full object name;
 * - anything already stands at the path, which is a killed round's snapshot
 *   for recovery to remove;
 * - the fetch fails, or finishes without bringing the commit;
 * - git refuses the add, or the deadline passes.
 *
 * Git makes the snapshot before the add can fail, so a failed add that left
 * anything at the path says so in `leftBehind`. Nothing here removes it, because
 * removal grows with the snapshot and does not belong before the review.
 */
export function addSnapshot(worktree: string, of: SnapshotOf, until: Deadline): SnapshotAddition {
  if (!FULL_COMMIT_NAME.test(of.commit)) {
    return failed(`${JSON.stringify(of.commit)} is not a full commit name`);
  }
  const path = join(worktree, ".squiz", String(of.pullRequest), "rounds", String(of.round), "tree");
  // Git adds into an empty directory that is already there, so its own refusal
  // is not enough to keep a leftover from being reused.
  if (existsSync(path)) return failed(`something already stands at ${path}`);

  const present = hasCommit(worktree, of.commit, until);
  if (!present.known) return failed(`whether ${of.commit} is here could not be told: ${present.reason}`);

  if (!present.has) {
    const fetched = runGit(
      worktree,
      // FETCH_HEAD is shared with the coding agent, so it is left as it was.
      ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin", of.commit],
      { until },
    );
    if (!fetched.ran) return failed(`${of.commit} could not be fetched: ${fetched.reason}`);
    const arrived = hasCommit(worktree, of.commit, until);
    if (!arrived.known) return failed(`whether ${of.commit} arrived could not be told: ${arrived.reason}`);
    if (!arrived.has) return failed(`the fetch finished without bringing ${of.commit}`);
  }

  const added = runGit(
    worktree,
    // The project's checkout hooks are for the coding agent's worktree. In a
    // snapshot they would spend the deadline, and could write outside it.
    ["-c", "core.hooksPath=/dev/null", "worktree", "add", "--quiet", "--detach", path, of.commit],
    { until },
  );
  if (!added.ran) {
    const reason = `the snapshot could not be added at ${path}: ${added.reason}`;
    // The path was clear before the add, so whatever stands there now is its.
    return existsSync(path) ? { outcome: "failed", reason, leftBehind: path } : failed(reason);
  }
  return { outcome: "added", path, fetched: !present.has };
}

/**
 * Remove the snapshot at `path`, with whatever the reviewer left in it, and
 * prune its registration from the repository.
 *
 * Unbounded: it runs after the round has recorded its result, and takes as long
 * as the files in the snapshot take to delete.
 */
export function removeSnapshot(worktree: string, path: string): SnapshotRemoval {
  const removed = runGit(worktree, ["worktree", "remove", "--force", path]);
  if (!removed.ran) return failed(`the snapshot at ${path} could not be removed: ${removed.reason}`);
  const pruned = runGit(worktree, ["worktree", "prune"]);
  if (!pruned.ran) return failed(`the snapshot at ${path} was removed but not pruned: ${pruned.reason}`);
  return { outcome: "removed" };
}

type Presence =
  | { readonly known: true; readonly has: boolean }
  | { readonly known: false; readonly reason: string };

function hasCommit(worktree: string, commit: string, until: Deadline): Presence {
  // Exit 1 with nothing said is a commit the repository does not have. A
  // `cat-file -e` of the same name exits 128 for that, as it does for a
  // repository it cannot read.
  const checked = runGit(worktree, ["rev-parse", "--quiet", "--verify", `${commit}^{commit}`], {
    until,
    answers: [0, 1],
  });
  if (!checked.ran) return { known: false, reason: checked.reason };
  return { known: true, has: checked.status === 0 };
}

function failed(reason: string): { readonly outcome: "failed"; readonly reason: string } {
  return { outcome: "failed", reason };
}
