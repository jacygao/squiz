/**
 * A reading of a worktree's files, tracked and untracked, and of where its `HEAD`
 * points, and what two readings disagree about.
 *
 * Two readings, one taken before the reviewer runs and one when it exits, are
 * what catches a write the reviewer made through the shell. A shell is itself a
 * write primitive, and nothing else names the file it changed. A commit changes
 * what the coding agent would commit while leaving every file as it was, so
 * `HEAD` is part of the reading.
 *
 * Nothing here writes to the worktree it reads, git's index included. A
 * mechanism that dirties what it measures is worse than none.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readSync, readlinkSync, type Stats } from "node:fs";
import { join } from "node:path";

import type { Deadline } from "../reviewers/deadline.ts";
import { worktreeToplevel } from "./toplevel.ts";

/** A worktree's files at one moment, or why git could not say. */
export type TrackedFilesReading =
  | {
      readonly outcome: "read";
      /** The worktree root, which every path below is relative to. */
      readonly root: string;
      /** Every path git gave a status for, against its two letters. */
      readonly status: ReadonlyMap<string, string>;
      /**
       * Every path a commit could carry, tracked or untracked, against what
       * stands at it. That is the content hashed, where a link points, the
       * revision a submodule is staged at, the kind of a path that is none of
       * those, or that nothing stands there at all.
       */
      readonly content: ReadonlyMap<string, string>;
      /** Where `HEAD` points, as one line: the branch and its commit, or the commit. */
      readonly head: string;
    }
  | { readonly outcome: "failed"; readonly reason: string };

/** `HEAD` as two readings found it, where the two differ. */
export type HeadMove = { readonly before: string; readonly after: string };

/**
 * What two readings say about a worktree.
 *
 * `unknown` is a reading that could not be taken, and is not `unchanged`: a
 * round that read a failed git as a tree nobody touched would report a reviewer
 * that touched nothing.
 */
export type TrackedFilesComparison =
  | { readonly outcome: "unchanged" }
  | {
      readonly outcome: "changed";
      /** Possibly empty, where `HEAD` moved and no path changed. */
      readonly paths: readonly string[];
      /** Absent where `HEAD` did not move. */
      readonly head?: HeadMove;
    }
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
  // Without this git collapses a new directory to its name and never says which
  // files are inside it.
  "--untracked-files=all",
  // One path per record. A rename record carries two, and a rename is a
  // deletion and an addition as far as a comparison is concerned.
  "--no-renames",
] as const;

/**
 * Read what stands at every path of the worktree holding `directory` that a
 * commit could carry, and where its `HEAD` points.
 *
 * Tracked paths and untracked ones both count, because a file the coding agent
 * has not staged is still one it would commit. Gitignored paths are absent,
 * because git leaves them out of both answers it gives here: nothing ignored is
 * tracked, and a status without `--ignored` names none of them. Writes there are
 * permitted, and the reviewer's own CLI compiles into the scratch space inside
 * the tree on every round.
 *
 * `until` bounds the whole reading, git and the hashing alike: a git that has not
 * answered by it is killed, the walk stops at the next path, and the answer is a
 * `failed` saying the time ran out. Without one the reading runs as long as the
 * worktree takes, which is a caller that has nothing else to spend.
 *
 * Never throws. A git that is missing, a directory that is no repository, a path
 * that cannot be read and a reading that ran out of time all come back as
 * `failed`, carrying the reason as a single line.
 */
export function readTrackedFiles(directory: string, until?: Deadline): TrackedFilesReading {
  const toplevel = worktreeToplevel(directory, until);
  if (toplevel.outcome === "failed") return { outcome: "failed", reason: toplevel.reason };
  const root = toplevel.path;

  const reported = git(root, STATUS_ARGUMENTS, until);
  if (!reported.ran) return { outcome: "failed", reason: reported.reason };
  // `ls-files` answers about the directory it runs in and names paths relative
  // to it, so it runs at the root, where it covers the whole worktree and names
  // a path the way a status does. `--stage` carries each entry's mode and
  // object, and the object is the only place a submodule's revision is written.
  const listed = git(root, ["ls-files", "-z", "--stage"], until);
  if (!listed.ran) return { outcome: "failed", reason: listed.reason };
  const staged = stagedEntries(listed.stdout);
  if (!staged.listed) return { outcome: "failed", reason: staged.reason };

  const status = statusOf(records(reported.stdout));
  const content = contentOf(root, staged.entries, untrackedIn(status), until);
  if (!content.read) return { outcome: "failed", reason: content.reason };

  const head = headOf(root, until);
  if (!head.read) return { outcome: "failed", reason: head.reason };

  return { outcome: "read", root, status, content: content.paths, head: head.at };
}

/**
 * Name every path the two readings disagree about, and `HEAD` where it moved.
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

  if (before.head !== after.head) {
    return { outcome: "changed", paths: changed, head: { before: before.head, after: after.head } };
  }
  if (changed.length === 0) return { outcome: "unchanged" };
  return { outcome: "changed", paths: changed };
}

type Head =
  | { readonly read: true; readonly at: string }
  | { readonly read: false; readonly reason: string };

/**
 * Where `HEAD` points, as one line.
 *
 * The branch counts as well as the commit. A switch to another branch at the same
 * commit leaves every file as it was and sends the coding agent's next commit to a
 * branch the pull request is not on.
 */
function headOf(root: string, until?: Deadline): Head {
  // Exit 1 with nothing said is a detached `HEAD`, which is an answer.
  const branch = git(root, ["symbolic-ref", "--quiet", "HEAD"], until, [0, 1]);
  if (!branch.ran) return { read: false, reason: branch.reason };
  const named = branch.status === 0 ? branch.stdout.trim() : null;

  // Exit 1 with nothing said is a name that resolves to no commit. On a branch
  // that is a branch nothing has been committed to yet.
  const commit = git(root, ["rev-parse", "--quiet", "--verify", "HEAD^{commit}"], until, [0, 1]);
  if (!commit.ran) return { read: false, reason: commit.reason };
  const at = commit.status === 0 ? commit.stdout.trim() : null;

  if (named === null) {
    if (at === null) return { read: false, reason: "a detached HEAD names no commit" };
    return { read: true, at: `a detached HEAD at ${at}` };
  }
  return { read: true, at: at === null ? `${named} with no commit` : `${named} at ${at}` };
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

function untrackedIn(status: ReadonlyMap<string, string>): readonly string[] {
  return [...status].filter(([, code]) => code === "??").map(([path]) => path);
}

type StagedEntry = {
  readonly mode: string;
  /** The object the index holds at the path, which for a submodule is a commit. */
  readonly object: string;
  readonly path: string;
};

type Staged =
  | { readonly listed: true; readonly entries: readonly StagedEntry[] }
  | { readonly listed: false; readonly reason: string };

function stagedEntries(stdout: string): Staged {
  const entries: StagedEntry[] = [];
  for (const record of records(stdout)) {
    // The mode, the object and the stage, then a tab, because a path may hold a
    // space. A record in any other shape would drop a tracked file out of the
    // reading, and a hole in a reading reads as a file nobody touched.
    const tab = record.indexOf("\t");
    const fields = tab === -1 ? [] : record.slice(0, tab).split(" ");
    const [mode, object] = fields;
    if (mode === undefined || object === undefined) {
      return { listed: false, reason: `git listed a file as ${JSON.stringify(record)}` };
    }
    entries.push({ mode, object, path: record.slice(tab + 1) });
  }
  return { listed: true, entries };
}

const SUBMODULE = "160000";

type Content =
  | { readonly read: true; readonly paths: ReadonlyMap<string, string> }
  | { readonly read: false; readonly reason: string };

function contentOf(
  root: string,
  entries: readonly StagedEntry[],
  untracked: readonly string[],
  until?: Deadline,
): Content {
  const wanted: readonly { readonly path: string; readonly marker?: string }[] = [
    ...entries.map((entry) =>
      // A submodule's own files belong to another repository, and the revision
      // the index holds is what a commit here would carry. That revision moves
      // under a status entry that does not, so a reading holds it rather than
      // anything about the directory in the worktree.
      entry.mode === SUBMODULE
        ? { path: entry.path, marker: `gitlink:${entry.object}` }
        : { path: entry.path },
    ),
    ...untracked.map((path) => ({ path })),
  ];

  const content = new Map<string, string>();
  for (const { path, marker } of wanted) {
    // A path in a conflict is listed once per stage, and the first stands for it.
    if (content.has(path)) continue;
    if (marker !== undefined) {
      content.set(path, marker);
      continue;
    }
    // Read between paths as well as inside one, so a worktree of many small files
    // is bounded as well as a worktree of one enormous one.
    if (until?.passed() === true) return { read: false, reason: RAN_OUT };
    try {
      const stands = standsAt(join(root, path), until);
      if (stands === null) return { read: false, reason: RAN_OUT };
      content.set(path, stands);
    } catch (cause) {
      // A path the worktree does not hold is a deletion, which is a change to
      // name rather than a reading that failed.
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
 * What stands at one path, as a value two readings can be compared by, or `null`
 * where the reading ran out of time inside it.
 *
 * The kind is part of it, so a file replaced by a link to a file of the same
 * content is a change, and so is one replaced by a pipe.
 */
function standsAt(path: string, until?: Deadline): string | null {
  const entry = lstatSync(path);
  // A link is read rather than followed. What it points at may be outside the
  // worktree, or not there at all, and neither is this worktree's content.
  if (entry.isSymbolicLink()) return `link:${digestOf(readlinkSync(path, "buffer"))}`;
  // Only a regular file is opened. An open of a pipe waits for a writer that may
  // never arrive, and no timer interrupts a synchronous open, so a reading that
  // tried it would hang the round and the round would be killed with nothing
  // posted.
  if (entry.isFile()) {
    const hashed = hashOfFile(path, until);
    return hashed === null ? null : `file:${hashed}`;
  }
  return `kind:${kindOf(entry)}`;
}

function kindOf(entry: Stats): string {
  if (entry.isDirectory()) return "directory";
  if (entry.isFIFO()) return "pipe";
  if (entry.isSocket()) return "socket";
  if (entry.isBlockDevice()) return "block-device";
  if (entry.isCharacterDevice()) return "character-device";
  return "unknown";
}

/**
 * Hashed in chunks, so that a large file is never held in memory, and `null`
 * where the deadline passed before the end of it.
 *
 * The clock is read between chunks, because one file can be larger than
 * everything else in the worktree together.
 */
function hashOfFile(path: string, until?: Deadline): string | null {
  const digest = createHash("sha256");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  const file = openSync(path, "r");
  try {
    for (;;) {
      if (until?.passed() === true) return null;
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
  | { readonly ran: true; readonly stdout: string; readonly status: number }
  | { readonly ran: false; readonly reason: string };

/**
 * `answers` are the exit statuses that are answers rather than failures. One
 * other than 0 is an answer only where git said nothing on stderr.
 */
function git(
  root: string,
  args: readonly string[],
  until?: Deadline,
  answers: readonly number[] = [0],
): GitOutput {
  if (until?.passed() === true) return { ran: false, reason: RAN_OUT };

  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    // Node's default stops at a mebibyte and hands back what it got, so a list
    // of paths arrives as one that reads whole with files missing from the end.
    maxBuffer: Infinity,
    // A timeout of zero is no timeout at all, so a deadline with nothing left
    // still bounds the call.
    ...(until === undefined ? {} : { timeout: Math.max(1, until.remaining()) }),
  });

  if (result.error !== undefined) {
    if (ranOut(result.error)) return { ran: false, reason: RAN_OUT };
    return { ran: false, reason: `git could not be run: ${result.error.message}` };
  }
  const answered =
    result.status === 0 ||
    (result.status !== null && answers.includes(result.status) && result.stderr.trim() === "");
  if (!answered || result.status === null) {
    const said = result.stderr.split("\n", 1)[0]?.trim() ?? "";
    const exit = describeExit(result.status, result.signal);
    return { ran: false, reason: said === "" ? `${exit} and said nothing` : `${exit}: ${said}` };
  }
  return { ran: true, stdout: result.stdout, status: result.status };
}

/** The NUL-terminated records of git's output, without the empty trailer. */
function records(stdout: string): readonly string[] {
  return stdout.split("\0").filter((record) => record !== "");
}

function describeExit(status: number | null, signal: NodeJS.Signals | null): string {
  return status === null ? `git was killed by ${signal ?? "a signal"}` : `git exited ${status}`;
}

/**
 * What a reading cut short at its bound says.
 *
 * Its own answer, and never a tree nobody touched: a caller that read this as
 * `unchanged` would report a reviewer that changed nothing.
 */
const RAN_OUT = "the reading ran out of the time it was given";

function ranOut(error: Error): boolean {
  return "code" in error && error.code === "ETIMEDOUT";
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function reasonFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
