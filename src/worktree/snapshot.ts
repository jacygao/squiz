/**
 * A round's snapshot: a clone of the coding agent's repository, checked out
 * detached at the head commit under review, which only the reviewer reads and
 * writes.
 *
 * The coding agent may be editing its own worktree while the round runs, so the
 * reviewer never reads that. The clone borrows the repository's objects and
 * shares nothing else: a test command that sets config, installs a hook, or
 * makes a branch in the snapshot does it to the clone's own git directory, which
 * goes when the snapshot does.
 *
 * Borrowing means the clone reads the repository's objects in place. One
 * pruned from the repository while the snapshot stands is gone from it too.
 *
 * It sits in the temporary directory, under no component that begins with a
 * dot, wherever the worktree is. A suite that matches its own absolute paths
 * against a glob, as mocha's `--ignore` does, skips every file under such a
 * component, and would fail in the snapshot where it passes in a fresh checkout.
 *
 * Nothing here throws. Each failure comes back as a reason for the caller to
 * report.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import type { Deadline } from "../reviewers/deadline.ts";
import { type GitOutput, runGit } from "./git.ts";

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
 * Add the round's snapshot of `worktree`, the coding agent's worktree root, at
 * the path `snapshotPath` gives.
 *
 * Where the repository lacks the commit it is fetched from `origin` first, and
 * checked for again before anything is added: a snapshot of anything else is
 * worse than none.
 *
 * `until` bounds every git call, and a call with nothing left on it is not
 * started. Fails where:
 *
 * - the commit is not a full object name;
 * - the snapshots directory cannot be made, or is not this user's alone;
 * - anything already stands at the path, which is a killed round's snapshot
 *   for recovery to remove;
 * - the fetch fails, or finishes without bringing the commit;
 * - git refuses the clone or the checkout, or the deadline passes.
 *
 * A checkout can fail after the clone is made, so a failed addition that left
 * anything at the path says so in `leftBehind`. Nothing here removes it, because
 * removal grows with the snapshot and does not belong before the review.
 */
export function addSnapshot(worktree: string, of: SnapshotOf, until: Deadline): SnapshotAddition {
  if (!FULL_COMMIT_NAME.test(of.commit)) {
    return failed(`${JSON.stringify(of.commit)} is not a full commit name`);
  }
  const unowned = ownSnapshotsDirectory();
  if (unowned !== null) return failed(unowned);
  const path = snapshotPath(worktree, of);
  // Git clones into an empty directory that is already there, so its own refusal
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

  const common = runGit(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { until });
  if (!common.ran) return failed(`the repository of ${worktree} could not be found: ${common.reason}`);

  // A commit fetched by its name is on no ref, and a clone copies refs. The
  // clone reads the repository's objects in place, so it has the commit and its
  // history all the same.
  const cloned = madeAt(
    path,
    runGit(
      worktree,
      [
        "clone",
        "--quiet",
        "--shared",
        "--no-checkout",
        // The clone's origin is the coding agent's repository, whose refs a
        // push would write.
        "--config",
        "remote.origin.pushurl=/dev/null",
        common.stdout.trim(),
        path,
      ],
      { until },
    ),
  );
  if (cloned !== null) return cloned;
  // A checkout hook from the user's own config or template would spend the
  // deadline, and could write outside the snapshot.
  const checkedOut = madeAt(
    path,
    runGit(path, ["-c", "core.hooksPath=/dev/null", "checkout", "--quiet", "--detach", of.commit], { until }),
  );
  if (checkedOut !== null) return checkedOut;
  return { outcome: "added", path, fetched: !present.has };
}

/**
 * Remove the snapshot at `path`, with whatever the reviewer left in it. The
 * episode's directories above it go too, where nothing else is in them.
 *
 * Refuses any path but a round's snapshot in this user's snapshots directory,
 * because it deletes whatever it is given.
 *
 * Unbounded: it runs after the round has recorded its result, and takes as long
 * as the files in the snapshot take to delete.
 */
export function removeSnapshot(path: string): SnapshotRemoval {
  const parts = relative(snapshotsDirectory(), path).split(sep);
  const isSnapshot =
    isAbsolute(path) && parts.length === 4 && parts[0] !== ".." && parts[1] === "rounds" && parts[3] === "tree";
  if (!isSnapshot) return failed(`${path} is not the path of a round's snapshot`);
  try {
    rmSync(path, { recursive: true });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return failed(`the snapshot at ${path} could not be removed: ${reason}`);
  }
  // `rounds/<round>`, `rounds` and the episode's own directory. One round of an
  // episode runs at a time, so no add races these.
  let directory = path;
  for (let level = 0; level < 3; level++) {
    directory = dirname(directory);
    try {
      rmdirSync(directory);
    } catch {
      break;
    }
  }
  return { outcome: "removed" };
}

/**
 * Where the snapshot of `worktree` for one round goes:
 * `<temporary directory>/squiz-<uid>/<worktree digest>-<pull request>/rounds/<round>/tree`.
 *
 * The same worktree, pull request and round always give the same path, so a
 * killed round's snapshot is found from its record's round number.
 */
export function snapshotPath(worktree: string, of: Pick<SnapshotOf, "pullRequest" | "round">): string {
  const digest = createHash("sha256").update(worktree).digest("hex").slice(0, 16);
  return join(snapshotsDirectory(), `${digest}-${of.pullRequest}`, "rounds", String(of.round), "tree");
}

// `os.userInfo` throws for a user with no password entry, and this never does.
// Every system the harness runs on has `getuid`.
function userId(): number {
  return process.getuid?.() ?? -1;
}

// One per user, because the temporary directory may be shared, as `/tmp` is.
function snapshotsDirectory(): string {
  return join(tmpdir(), `squiz-${userId()}`);
}

/**
 * Make the snapshots directory where it is missing, and say why not where
 * anyone but this user could put something in it.
 *
 * In a shared temporary directory another user can name the path first, with a
 * link to somewhere of theirs or a directory they can write.
 */
function ownSnapshotsDirectory(): string | null {
  const directory = snapshotsDirectory();
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) {
      return `${directory} could not be made: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }
  try {
    const found = lstatSync(directory);
    const alone = found.isDirectory() && found.uid === userId() && (found.mode & 0o022) === 0;
    return alone ? null : `${directory} is not a directory of this user's alone`;
  } catch (cause) {
    return `${directory} could not be read: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
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

/** The failure one step of making the snapshot came to, or null where it ran. */
function madeAt(path: string, step: GitOutput): SnapshotAddition | null {
  if (step.ran) return null;
  const reason = `the snapshot could not be made at ${path}: ${step.reason}`;
  // The path was clear before the snapshot was begun, so whatever stands there now is its.
  return existsSync(path) ? { outcome: "failed", reason, leftBehind: path } : failed(reason);
}

function failed(reason: string): { readonly outcome: "failed"; readonly reason: string } {
  return { outcome: "failed", reason };
}
