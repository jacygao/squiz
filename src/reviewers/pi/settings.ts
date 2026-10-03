/**
 * The settings directory squiz hands `pi`, and why there is one.
 *
 * `pi` runs a configured line inside every shell tool it starts, and the line is
 * a setting rather than a flag: there is no argument that carries it. `pi`
 * resolves its settings to `<agent directory>/settings.json`, and the agent
 * directory is `PI_CODING_AGENT_DIR` where that is set. So the round points that
 * at a directory of its own and writes the setting there.
 *
 * **The whole of `pi`'s configuration moves with that variable**, not the
 * settings alone: its credential, its model catalogue and the binaries it puts on
 * the shell's path are all resolved against the same directory. So the directory
 * is a mirror of the user's own — every entry of it linked, and only
 * `settings.json` written afresh, from the user's settings with the prefix added.
 * A round that wrote the setting alone would run a reviewer with no credential
 * and, because the command line names no model, a different model from the one
 * the user configured.
 *
 * The links are followed rather than replaced, so a write `pi` makes through one
 * reaches the user's own file, which is where it would have gone anyway. Only
 * `settings.json` is the round's, and the user's own copy of it is never written.
 *
 * **A trusted project's own settings would merge over the mirror**, which is why
 * the command line untrusts the tree under review. `shellCommandPrefix` is a
 * string, so a project that set one would replace the round's line outright and
 * no shell would record anything. Writing the setting into the tree instead is not
 * open: the file would stand in the worktree under review, where the round's own
 * reading of the files reports it as a change the round made.
 *
 * So the prefix the project configured is resolved here rather than by `pi`, and
 * the recording line goes in front of it. It still runs; nothing else of the
 * project's does.
 *
 * Nothing here throws. Every outcome is a value the caller reads.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import type { Confinement, Invocation } from "../adapter.ts";
import { shellPrefix } from "../groups.ts";

/** The variable `pi` reads its configuration directory from. */
const AGENT_DIRECTORY_VARIABLE = "PI_CODING_AGENT_DIR";

/** What `pi` calls the file holding the setting, inside that directory. */
const SETTINGS_FILE = "settings.json";

/** What `pi` calls the directory a project's own settings sit in, inside the tree. */
const PROJECT_DIRECTORY = ".pi";

/** The setting whose value `pi` runs inside every shell tool, before the command. */
const PREFIX_SETTING = "shellCommandPrefix";

/** Where `pi` looks when `PI_CODING_AGENT_DIR` is unset. */
function defaultAgentDirectory(): string {
  return join(homedir(), ".pi", "agent");
}

/**
 * Put `pi`'s settings where `pi` reads them, and say what to add to its
 * environment.
 *
 * At a depth granting no shell there is nothing to record, so nothing is written
 * and `pi` reads the user's own configuration exactly as it would without the
 * harness.
 */
export function confine(invocation: Invocation): Confinement {
  const space = invocation.roundSpace;
  if (space === undefined) return { outcome: "prepared", environment: {} };

  const theirs = userAgentDirectory(invocation.directory);
  const mine = join(space.directory, "pi-agent");

  const settings = readSettings(join(theirs, SETTINGS_FILE));
  if ("problem" in settings) return { outcome: "failed", reason: settings.problem };

  try {
    mkdirSync(mine, { recursive: true });
    link(theirs, mine);
    writeFileSync(
      join(mine, SETTINGS_FILE),
      `${JSON.stringify(withPrefix(settings.settings, invocation.directory), null, 2)}\n`,
      "utf8",
    );
  } catch (cause) {
    return {
      outcome: "failed",
      reason: `the reviewer's settings could not be written to ${mine}: ${reasonFor(cause)}`,
    };
  }

  return { outcome: "prepared", environment: { [AGENT_DIRECTORY_VARIABLE]: mine } };
}

/**
 * The configuration directory `pi` would read without the harness.
 *
 * Resolved the way `pi` resolves it, because what is mirrored has to be what the
 * user's own runs would read. A relative value is resolved against the tree under
 * review, which is where `pi` runs and so what it would resolve against.
 */
function userAgentDirectory(directory: string): string {
  const set = process.env[AGENT_DIRECTORY_VARIABLE];
  if (set === undefined || set.trim() === "") return defaultAgentDirectory();
  const expanded = set.startsWith("~/") ? join(homedir(), set.slice(2)) : set;
  return isAbsolute(expanded) ? expanded : resolve(directory, expanded);
}

type SettingsRead = { readonly settings: Record<string, unknown> } | { readonly problem: string };

/**
 * The user's own settings, which the mirror carries forward whole.
 *
 * A file that is not there is a user with no settings. A file that is there and
 * will not read is a failure rather than an empty object: the harness names no
 * model on the command line, so settings silently dropped are a round reviewed
 * by a model nobody chose.
 */
function readSettings(path: string): SettingsRead {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (cause) {
    if (isMissing(cause)) return { settings: {} };
    return { problem: `${path} could not be read: ${reasonFor(cause)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    return { problem: `${path} is not valid JSON: ${reasonFor(cause)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { problem: `${path} holds no JSON object` };
  }
  return { settings: parsed as Record<string, unknown> };
}

/**
 * The user's settings with the recording prefix in front of whatever prefix they
 * configured.
 *
 * In front, because a prefix of the user's that exits or fails would otherwise
 * stop the recording line from ever running.
 */
function withPrefix(
  settings: Record<string, unknown>,
  directory: string,
): Record<string, unknown> {
  const theirs = configuredPrefix(settings, directory);
  const mine =
    typeof theirs === "string" && theirs !== "" ? `${shellPrefix}\n${theirs}` : shellPrefix;
  return { ...settings, [PREFIX_SETTING]: mine };
}

/**
 * The prefix `pi` would resolve if it read the tree under review, the project's
 * own file included.
 *
 * A project that sets the key replaces the global value rather than adding to it,
 * which is what merging two strings comes to, so the project's own is the whole of
 * the answer wherever it is there. A value that is not a string sets no prefix,
 * exactly as it would for `pi`.
 *
 * A project file that is missing or will not read contributes nothing, and that is
 * `pi`'s own reading too: the command line untrusts the tree, so `pi` drops the
 * file whole whatever is in it.
 */
function configuredPrefix(global: Record<string, unknown>, directory: string): unknown {
  const project = readSettings(join(directory, PROJECT_DIRECTORY, SETTINGS_FILE));
  if ("problem" in project) return global[PREFIX_SETTING];
  if (PREFIX_SETTING in project.settings) return project.settings[PREFIX_SETTING];
  return global[PREFIX_SETTING];
}

/**
 * Link every entry of the user's configuration directory into the round's own,
 * leaving the settings to be written over the top.
 *
 * A directory that is not there is a user with no `pi` configuration, which is a
 * reviewer that will fail to authenticate and say so itself.
 */
function link(theirs: string, mine: string): void {
  let entries: readonly string[];
  try {
    entries = readdirSync(theirs);
  } catch (cause) {
    if (isMissing(cause)) return;
    throw cause;
  }
  for (const entry of entries) {
    if (entry === SETTINGS_FILE) continue;
    const at = join(mine, entry);
    if (existsSync(at)) continue;
    symlinkSync(join(theirs, entry), at);
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function reasonFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
