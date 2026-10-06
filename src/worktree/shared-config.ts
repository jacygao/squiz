/**
 * A reading of the git files the snapshot shares with every other worktree of the
 * repository, and what two readings disagree about.
 *
 * A snapshot added by `git worktree add` has a git directory of its own and shares
 * the repository's config, hooks and exclude file with the coding agent's
 * worktree. A test command run in the snapshot can write those, and a `prepare`
 * script that sets `core.hooksPath` does. Nothing in the snapshot changes, so the
 * tracked-file comparison cannot see it, and the coding agent's next commit reads
 * the result.
 *
 * Contents are compared, never modification times. Nothing here writes to what
 * it reads.
 */

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readlinkSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type { Deadline } from "../reviewers/deadline.ts";
import { runGit } from "./git.ts";
import { hashOfFile } from "./tracked-files.ts";

/** One shared file's content, and its keys where git reads it as a config. */
type Stands = {
  /** The content hashed, the kind of a path that is no file, or `absent`. */
  readonly stands: string;
  /**
   * Each key, by the hash of its full name, against what it is named as and the
   * hash of its values. Absent where the file is no config, or one git could not
   * read as one.
   */
  readonly keys?: ReadonlyMap<string, Key>;
};

type Key = {
  /** The key with its subsection written as `*`. */
  readonly name: string;
  /** The hash of every value the key is given, in the order the file gives them. */
  readonly values: string;
};

/** The shared files at one moment, or why they could not be read. */
export type SharedConfigReading =
  | {
      readonly outcome: "read";
      /** The directory every worktree shares, which every name below is relative to. */
      readonly common: string;
      /** Each file read, by its path relative to `common` with `/` between parts. */
      readonly files: ReadonlyMap<string, Stands>;
    }
  | { readonly outcome: "failed"; readonly reason: string };

/** A shared file that changed, and the key within it where one can be named. */
export type SharedChange = { readonly file: string; readonly key?: string };

/**
 * What two readings say about the shared files.
 *
 * `unknown` is a reading that could not be taken, and never `unchanged`.
 */
export type SharedConfigComparison =
  | { readonly outcome: "unchanged" }
  | { readonly outcome: "changed"; readonly changes: readonly SharedChange[] }
  | { readonly outcome: "unknown"; readonly reason: string };

/**
 * Read the files the snapshot at `snapshot` shares with `worktree`, the coding
 * agent's worktree:
 *
 * - `config`, the repository's local config;
 * - `config.worktree`, the main worktree's own config;
 * - the coding agent's own `config.worktree`, where it works in a linked worktree;
 * - `info/exclude`;
 * - everything under `hooks/`.
 *
 * Each `config.worktree` is read whether or not `extensions.worktreeConfig` turns
 * it on. A file that is not there is read as absent, which is an answer: one that
 * appears or goes away is a change.
 *
 * Never throws. A git that fails, a path that cannot be read for any reason but
 * that nothing stands there, and a deadline that passes all come back as
 * `failed`.
 */
export function readSharedConfig(
  snapshot: string,
  worktree: string,
  until?: Deadline,
): SharedConfigReading {
  const common = gitPath(snapshot, "--git-common-dir", until);
  if (!common.found) return { outcome: "failed", reason: common.reason };
  const agent = gitPath(worktree, "--git-dir", until);
  if (!agent.found) return { outcome: "failed", reason: agent.reason };

  const configs = ["config", "config.worktree"];
  // The main worktree's git directory is the shared one, whose own config is
  // already in the list.
  if (agent.path !== common.path) configs.push(named(relative(common.path, join(agent.path, "config.worktree"))));

  const files = new Map<string, Stands>();
  for (const name of configs) {
    const read = readConfig(common.path, name, until);
    if (!read.read) return { outcome: "failed", reason: read.reason };
    files.set(name, read.stands);
  }
  const exclude = readPlain(common.path, "info/exclude", until);
  if (!exclude.read) return { outcome: "failed", reason: exclude.reason };
  files.set("info/exclude", exclude.stands);

  const hooks = readTree(common.path, "hooks", files, until);
  if (hooks !== null) return { outcome: "failed", reason: hooks };
  // A reading that finished after its deadline was not taken inside it.
  if (until?.passed() === true) return { outcome: "failed", reason: RAN_OUT };

  return { outcome: "read", common: common.path, files };
}

/**
 * Name every shared file the two readings disagree about.
 *
 * A config is named by the keys whose values changed, and by the file alone where
 * no key did, as for a comment, or where either reading could not list its keys.
 */
export function compareSharedConfig(
  before: SharedConfigReading,
  after: SharedConfigReading,
): SharedConfigComparison {
  if (before.outcome === "failed") {
    return { outcome: "unknown", reason: `the reading before could not be taken: ${before.reason}` };
  }
  if (after.outcome === "failed") {
    return { outcome: "unknown", reason: `the reading after could not be taken: ${after.reason}` };
  }
  if (before.common !== after.common) {
    return {
      outcome: "unknown",
      reason: `the readings are of two repositories, ${before.common} and ${after.common}`,
    };
  }

  const changes: SharedChange[] = [];
  const names = [...new Set([...before.files.keys(), ...after.files.keys()])].sort();
  for (const file of names) {
    const was = before.files.get(file);
    const is = after.files.get(file);
    if (was?.stands === is?.stands) continue;
    const keys = keysChanged(was, is);
    if (keys.length === 0) changes.push({ file });
    else changes.push(...keys.map((key) => ({ file, key })));
  }
  return changes.length === 0 ? { outcome: "unchanged" } : { outcome: "changed", changes };
}

function keysChanged(was: Stands | undefined, is: Stands | undefined): readonly string[] {
  if (was?.keys === undefined || is?.keys === undefined) return [];
  const keys = new Set([...was.keys.keys(), ...is.keys.keys()]);
  const changed = [...keys].flatMap((key) => {
    const before = was.keys?.get(key);
    const after = is.keys?.get(key);
    if (before?.values === after?.values) return [];
    return [(before ?? after)?.name ?? ""];
  });
  // Two keys that differ only in their subsection are named alike, and once.
  return [...new Set(changed)].sort();
}

type Found =
  | { readonly found: true; readonly path: string }
  | { readonly found: false; readonly reason: string };

function gitPath(directory: string, which: string, until?: Deadline): Found {
  const asked = runGit(directory, ["rev-parse", "--path-format=absolute", which], {
    until,
    ranOut: RAN_OUT,
  });
  if (!asked.ran) return { found: false, reason: asked.reason };
  const path = asked.stdout.trim();
  if (path === "") return { found: false, reason: `git named no directory for ${which}` };
  return { found: true, path };
}

type Read =
  | { readonly read: true; readonly stands: Stands }
  | { readonly read: false; readonly reason: string };

/**
 * One config file, with its keys.
 *
 * The keys are git's own reading of the file, so they are named as git names
 * them, with the section and the key lowercased. A subsection is written as `*`,
 * because it can be a URL and a URL can carry a credential.
 */
function readConfig(common: string, name: string, until?: Deadline): Read {
  const plain = readPlain(common, name, until);
  if (!plain.read) return plain;
  // A config that is not there holds no keys, so one that appears or goes away is
  // named by the keys it holds.
  if (plain.stands.stands === "absent") return { read: true, stands: { ...plain.stands, keys: new Map() } };
  if (!plain.stands.stands.startsWith("file:")) return plain;
  const listed = runGit(common, ["config", "--file", join(common, name), "--list", "-z"], {
    until,
    ranOut: RAN_OUT,
  });
  if (!listed.ran) {
    if (listed.reason === RAN_OUT) return { read: false, reason: RAN_OUT };
    // A file git cannot read as a config is still compared by its content, and
    // named as a file where that changes.
    return plain;
  }
  return { read: true, stands: { ...plain.stands, keys: keysOf(listed.stdout) } };
}

/**
 * Each key, by the hash of its full name, against its name and its values.
 *
 * Full names and values are kept as hashes, so that two keys differing only in a
 * subsection stay two keys while neither the subsection nor the value is held.
 */
function keysOf(stdout: string): ReadonlyMap<string, Key> {
  const values = new Map<string, string[]>();
  for (const record of stdout.split("\0")) {
    if (record === "") continue;
    // A key given no value, which git reads as true, has no newline after it.
    const newline = record.indexOf("\n");
    const key = newline === -1 ? record : record.slice(0, newline);
    const value = newline === -1 ? "\0no value" : record.slice(newline + 1);
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  const keys = new Map<string, Key>();
  for (const [key, given] of values) {
    keys.set(digestOf(Buffer.from(key)), {
      name: withoutSubsection(key),
      values: digestOf(Buffer.from(given.join("\0"))),
    });
  }
  return keys;
}

/**
 * `section.subsection.key` as `section.*.key`. The section and the key hold no
 * dot, so whatever lies between the first dot and the last is the subsection.
 */
function withoutSubsection(key: string): string {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  return first === last ? key : `${key.slice(0, first)}.*${key.slice(last)}`;
}

/** A file's content as a value two readings can be compared by. */
function readPlain(common: string, name: string, until?: Deadline): Read {
  if (until?.passed() === true) return { read: false, reason: RAN_OUT };
  try {
    const stands = standsAt(join(common, name), until);
    if (stands === null) return { read: false, reason: RAN_OUT };
    return { read: true, stands: { stands } };
  } catch (cause) {
    if (isMissing(cause)) return { read: true, stands: { stands: "absent" } };
    return { read: false, reason: `${name} could not be read: ${reasonFor(cause)}` };
  }
}

/**
 * Everything under `name`, added to `files`, or the reason it could not be read.
 *
 * A directory that is not there adds nothing, so a hook that appears in a hooks
 * directory that did not exist is still named.
 */
function readTree(
  common: string,
  name: string,
  files: Map<string, Stands>,
  until?: Deadline,
): string | null {
  let entries: string[];
  try {
    entries = readdirSync(join(common, name));
  } catch (cause) {
    if (isMissing(cause)) return null;
    // A path that is something other than a directory is compared as one entry.
    if (isNotDirectory(cause)) {
      const read = readPlain(common, name, until);
      if (!read.read) return read.reason;
      files.set(name, read.stands);
      return null;
    }
    return `${name} could not be read: ${reasonFor(cause)}`;
  }
  for (const entry of entries.sort()) {
    const path = `${name}/${entry}`;
    const read = readPlain(common, path, until);
    if (!read.read) return read.reason;
    if (read.stands.stands === "kind:directory") {
      const nested = readTree(common, path, files, until);
      if (nested !== null) return nested;
    } else {
      files.set(path, read.stands);
    }
  }
  return null;
}

/**
 * What stands at one path, or `null` where the deadline passed inside it. A link
 * is read rather than followed, and only a regular file is opened, because
 * opening a pipe waits for a writer that may never come.
 */
function standsAt(path: string, until?: Deadline): string | null {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) return `link:${digestOf(readlinkSync(path, "buffer"))}`;
  if (entry.isFile()) {
    const hashed = hashOfFile(path, until);
    return hashed === null ? null : `file:${hashed}`;
  }
  if (entry.isDirectory()) return "kind:directory";
  return "kind:other";
}

function named(path: string): string {
  return path.split(sep).join("/");
}

function digestOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** What a reading cut short at its bound says, which is never a config nobody changed. */
const RAN_OUT = "the reading ran out of the time it was given";

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isNotDirectory(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOTDIR";
}

function reasonFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
