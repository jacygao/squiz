/**
 * A reading of a worktree's tracked files, and what two readings disagree about.
 *
 * Two readings, one taken before the reviewer runs and one when it exits, are
 * what catches a write the reviewer made through the shell. A shell is itself a
 * write primitive, and nothing else names the file it changed.
 *
 * Nothing here writes to the worktree it reads, git's index included. A
 * mechanism that dirties what it measures is worse than none.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readSync, readlinkSync } from "node:fs";
import { join } from "node:path";

import { worktreeToplevel } from "./toplevel.ts";

/** A worktree's tracked files at one moment, or why git could not say. */
export type TrackedFilesReading =
  | {
      readonly outcome: "read";
      /** The worktree root, which every path below is relative to. */
      readonly root: string;
      /** Every path git gave a status for, against its two letters. */
      readonly status: ReadonlyMap<string, string>;
      /**
       * Every tracked path, against what stands in the worktree at it: the
       * content hashed, where a link points, or that nothing stands there.
       */
      readonly content: ReadonlyMap<string, string>;
    }
  | { readonly outcome: "failed"; readonly reason: string };

/**
 * What two readings say about a worktree.
 *
 * `unknown` is a reading that could not be taken, and is not `unchanged`: a
 * round that read a failed git as a tree nobody touched would report a reviewer
 * that touched nothing.
 */
export type TrackedFilesComparison =
  | { readonly outcome: "unchanged" }
  | { readonly outcome: "changed"; readonly paths: readonly string[] }
  | { readonly outcome: "unknown"; readonly reason: string };

const STATUS_ARGUMENTS = [
  // A plain status refreshes the index's cached stat information and writes the
  // index back, which is a write to the repository being measured.
  "--no-optional-locks",
  "status",
  "--porcelain=v1",
  // Paths arrive as git holds them, so one holding a space or a newline needs no
  // unquoting.
  "-z",
  // An untracked file is a file the coding agent would commit. Without this git
  // collapses a new directory to its name and never says what is inside it.
  "--untracked-files=all",
  // One path per record. A rename record carries two, and a rename is a
  // deletion and an addition as far as a comparison is concerned.
  "--no-renames",
] as const;

/**
 * Read what stands in every tracked file of the worktree holding `directory`.
 *
 * Gitignored paths are absent from a reading, because git leaves them out of
 * both answers it gives here: nothing ignored is tracked, and a status without
 * `--ignored` names none of them. Writes there are permitted, and the
 * reviewer's own CLI compiles into the scratch space inside the tree on every
 * round.
 *
 * Never throws. A git that is missing, a directory that is no repository, and a
 * tracked file that cannot be read all come back as `failed`, carrying the
 * reason as a single line.
 */
export function readTrackedFiles(directory: string): TrackedFilesReading {
  const toplevel = worktreeToplevel(directory);
  if (toplevel.outcome === "failed") return { outcome: "failed", reason: toplevel.reason };
  const root = toplevel.path;

  const reported = git(root, STATUS_ARGUMENTS);
  if (!reported.ran) return { outcome: "failed", reason: reported.reason };
  // `ls-files` answers about the directory it runs in and names paths relative
  // to it, so it runs at the root, where it covers the whole worktree and names
  // a path the way a status does.
  const listed = git(root, ["ls-files", "-z"]);
  if (!listed.ran) return { outcome: "failed", reason: listed.reason };

  const content = contentOf(root, records(listed.stdout));
  if (!content.read) return { outcome: "failed", reason: content.reason };

  return {
    outcome: "read",
    root,
    status: statusOf(records(reported.stdout)),
    content: content.paths,
  };
}

/**
 * Name every path the two readings disagree about.
 *
 * A path is named where git's status for it differs, and where what stands at it
 * differs, so a file whose content changed under a status entry that did not is
 * named as well. A reading that could not be taken makes the answer `unknown`.
 */
export function compareTrackedFiles(
  before: TrackedFilesReading,
  after: TrackedFilesReading,
): TrackedFilesComparison {
  if (before.outcome === "failed") {
    return { outcome: "unknown", reason: `the reading before could not be taken: ${before.reason}` };
  }
  if (after.outcome === "failed") {
    return { outcome: "unknown", reason: `the reading after could not be taken: ${after.reason}` };
  }
  // Two roots are two worktrees, and one path names a different file in each.
  if (before.root !== after.root) {
    return {
      outcome: "unknown",
      reason: `the readings are of two worktrees, ${before.root} and ${after.root}`,
    };
  }

  const paths = new Set([
    ...before.status.keys(),
    ...after.status.keys(),
    ...before.content.keys(),
    ...after.content.keys(),
  ]);
  const changed = [...paths]
    .filter(
      (path) =>
        before.status.get(path) !== after.status.get(path) ||
        before.content.get(path) !== after.content.get(path),
    )
    .sort();

  if (changed.length === 0) return { outcome: "unchanged" };
  return { outcome: "changed", paths: changed };
}

/** The two letters git gave each path it named. */
function statusOf(records: readonly string[]): ReadonlyMap<string, string> {
  const status = new Map<string, string>();
  for (const record of records) {
    // Two status letters, a space, then the path.
    status.set(record.slice(3), record.slice(0, 2));
  }
  return status;
}

type Content =
  | { readonly read: true; readonly paths: ReadonlyMap<string, string> }
  | { readonly read: false; readonly reason: string };

function contentOf(root: string, paths: readonly string[]): Content {
  const content = new Map<string, string>();
  for (const path of paths) {
    // A path in a conflict is listed once per stage.
    if (content.has(path)) continue;
    try {
      content.set(path, standsAt(join(root, path)));
    } catch (cause) {
      // A tracked path the worktree does not hold is a deletion, which is a
      // change to name rather than a reading that failed.
      if (isMissing(cause)) {
        content.set(path, "absent");
        continue;
      }
      return { read: false, reason: `${path} could not be read: ${reasonFor(cause)}` };
    }
  }
  return { read: true, paths: content };
}

/**
 * What stands at one path, as a value two readings can be compared by.
 *
 * The kind is part of it, so a file replaced by a link to a file of the same
 * content is a change.
 */
function standsAt(path: string): string {
  const entry = lstatSync(path);
  // A link is read rather than followed. What it points at may be outside the
  // worktree, or not there at all, and neither is this worktree's content.
  if (entry.isSymbolicLink()) return `link:${digestOf(readlinkSync(path, "buffer"))}`;
  // A submodule is a directory here and a commit in the index. Its own files
  // belong to another repository, and a status names a submodule that moved.
  if (entry.isDirectory()) return "submodule";
  return `file:${hashOfFile(path)}`;
}

/** Hashed in chunks, so that a large tracked file is never held in memory. */
function hashOfFile(path: string): string {
  const digest = createHash("sha256");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  const file = openSync(path, "r");
  try {
    for (;;) {
      const read = readSync(file, chunk, 0, chunk.length, null);
      if (read === 0) break;
      digest.update(chunk.subarray(0, read));
    }
  } finally {
    closeSync(file);
  }
  return digest.digest("hex");
}

function digestOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type GitOutput =
  | { readonly ran: true; readonly stdout: string }
  | { readonly ran: false; readonly reason: string };

function git(root: string, args: readonly string[]): GitOutput {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    // Node's default stops at a mebibyte and hands back what it got, so a list
    // of paths arrives as one that reads whole with files missing from the end.
    maxBuffer: Infinity,
  });

  if (result.error !== undefined) {
    return { ran: false, reason: `git could not be run: ${result.error.message}` };
  }
  if (result.status !== 0) {
    const said = result.stderr.split("\n", 1)[0]?.trim() ?? "";
    const exit = describeExit(result.status, result.signal);
    return { ran: false, reason: said === "" ? `${exit} and said nothing` : `${exit}: ${said}` };
  }
  return { ran: true, stdout: result.stdout };
}

/** The NUL-terminated records of git's output, without the empty trailer. */
function records(stdout: string): readonly string[] {
  return stdout.split("\0").filter((record) => record !== "");
}

function describeExit(status: number | null, signal: NodeJS.Signals | null): string {
  return status === null ? `git was killed by ${signal ?? "a signal"}` : `git exited ${status}`;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function reasonFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
