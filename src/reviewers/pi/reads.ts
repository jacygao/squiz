/**
 * The reviewer's reads outside the snapshot, refused inside `pi` before they run.
 *
 * `pi`'s `read`, `grep`, `find` and `ls` open whatever path they are given,
 * with the user's access. The tree under review can carry text asking the
 * reviewer to read a credential, and a link pointing at one, and a finding that
 * quotes it is posted on the pull request. So a path is let through only where
 * its real path, every link resolved, is inside the snapshot's.
 *
 * The path is resolved as `pi` resolves it before opening it: a leading `@`
 * dropped, `~` taken as the home directory, a `file://` URL as its path, and the
 * rest against the snapshot. Where the path does not exist, `read` opens the
 * first of the spellings macOS gives a screenshot's name that does, and that is
 * the one checked. A spelling `pi` comes to expand that this does not is a
 * way out this does not see.
 */

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { type Refusal, refusal, type ToolCall } from "./refusals.ts";

/** The tools that take a path, which every one of them reads. */
const READ_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];

/** What `pi` reads as a space in a path. */
const UNICODE_SPACES = /[  -   　]/gu;

/**
 * Refuse a read whose path leads out of `snapshot`, or let it through.
 *
 * `undefined` is a call nothing here objects to, a call that is not a read
 * among them. Where the snapshot itself cannot be resolved, every read is
 * refused. Never throws.
 */
export function refuseRead(call: ToolCall, snapshot: string): Refusal | undefined {
  if (!READ_TOOLS.includes(call.toolName)) return undefined;

  const path = pathOf(call.input);
  if (path === null) {
    return refusal(`the path could not be read out of this \`${call.toolName}\` call, so nothing here could check it.`);
  }

  let root: string;
  try {
    root = realpathSync(snapshot);
  } catch {
    return refusal(`the snapshot ${snapshot} could not be resolved, so no path could be checked against it.`);
  }

  const resolved = resolvedAs(path, snapshot);
  const opened = call.toolName === "read" ? spellingReadOpens(resolved) : resolved;
  const real = realOf(opened);
  if (real === undefined || !(real === root || real.startsWith(root + sep))) {
    return refusal(
      `\`${path}\` is outside the code under review. Read only what is in the working directory.`,
    );
  }
  return undefined;
}

/**
 * The path a read was given, `.` where it was given none, or `null` where what
 * it was given is not a path.
 *
 * `read` requires one and the others default to the working directory. `pi`
 * checks the schema, so a missing path never reaches `read`.
 */
function pathOf(input: unknown): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const path = (input as Readonly<Record<string, unknown>>)["path"];
  if (path === undefined) return ".";
  return typeof path === "string" ? path : null;
}

/** The absolute path `pi` opens for `path`, before it tries any other spelling. */
function resolvedAs(path: string, cwd: string): string {
  let normalized = path.replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~") normalized = homedir();
  else if (normalized.startsWith("~/")) normalized = join(homedir(), normalized.slice(2));
  else if (normalized.startsWith("file://")) normalized = fileURLToPath(normalized);
  return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

/**
 * The spelling `read` opens: the path where it exists, and otherwise the first
 * other spelling that does, in the order `read` tries them.
 */
function spellingReadOpens(path: string): string {
  if (existsSync(path)) return path;
  const decomposed = path.normalize("NFD");
  const others = [
    path.replace(/ (AM|PM)\./giu, "\u202F$1."),
    decomposed,
    path.replaceAll("'", "\u2019"),
    decomposed.replaceAll("'", "\u2019"),
  ];
  return others.find((other) => other !== path && existsSync(other)) ?? path;
}

/**
 * The real path, every link resolved, or `undefined` where it cannot be had.
 *
 * Where the path does not exist, it is the real path of its nearest ancestor
 * that does, with the rest after it, so a read of a missing file in the
 * snapshot is let through to fail on its own.
 */
function realOf(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch (cause) {
    const code = (cause as { code?: unknown }).code;
    const parent = dirname(path);
    if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === path) return undefined;
    const above = realOf(parent);
    return above === undefined ? undefined : join(above, basename(path));
  }
}
