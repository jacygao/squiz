/**
 * What `pi` takes from settings files: the user's default model from its global
 * settings, and which of a project's own settings a review leaves unused.
 *
 * A review runs `pi` with the project untrusted, so no project setting applies
 * and none is read as the model. Nothing here throws.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ProjectSettings, UnusedSetting, UserModel } from "../adapter.ts";

/**
 * `defaultProvider` and `defaultModel`, as `provider/id`, from `settings.json`
 * under `PI_CODING_AGENT_DIR`, or under `~/.pi/agent` where that is unset.
 * `pi` starts without settings it cannot read, so that never fails a round.
 */
export function userModel(environment: NodeJS.ProcessEnv): UserModel {
  const set = environment["PI_CODING_AGENT_DIR"];
  const directory = set !== undefined && set.trim() !== "" ? set : join(environment["HOME"] ?? homedir(), ".pi", "agent");
  const file = join(directory, "settings.json");
  const unreadable = (problem: string): UserModel => ({ problem: `pi's settings ${file} ${problem}`, failsTheRound: false });

  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch (cause) {
    if (isRecord(cause) && cause["code"] === "ENOENT") return undefined;
    return unreadable(`could not be read: ${reasonFor(cause)}`);
  }
  let settings: unknown;
  try {
    settings = JSON.parse(source);
  } catch (cause) {
    return unreadable(`are not JSON: ${reasonFor(cause)}`);
  }
  if (!isRecord(settings)) return unreadable("are not an object");
  const model = text(settings["defaultModel"]).trim();
  const provider = text(settings["defaultProvider"]).trim();
  if (model === "") return undefined;
  return provider === "" ? model : `${provider}/${model}`;
}

/**
 * What `pi` reads only from a trusted project, in the order `pi` checks for
 * them. `.agents/skills` is looked for in every directory above as well, which
 * for a review's snapshot holds nothing of the project's.
 */
const TRUSTED_ONLY = [
  ".pi/settings.json",
  ".pi/extensions",
  ".pi/skills",
  ".pi/prompts",
  ".pi/themes",
  ".pi/SYSTEM.md",
  ".pi/APPEND_SYSTEM.md",
  ".agents/skills",
] as const;

/**
 * Each of the project's files under `root` that `pi` would take from a trusted
 * project, with the top-level keys of `.pi/settings.json` where it is a JSON
 * object, and the context file `pi` loads from `root` whatever the trust.
 * Nothing is unused where the project has none of them, as for a bare `.pi`.
 */
export function projectSettings(root: string): ProjectSettings {
  const unused: UnusedSetting[] = TRUSTED_ONLY.filter((path) => existsSync(join(root, path))).map((path) => ({
    path,
    keys: path === ".pi/settings.json" ? settingsKeys(join(root, path)) : [],
  }));
  return { unused, contextFile: contextFileIn(root) };
}

function settingsKeys(file: string): readonly string[] {
  try {
    const settings: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isRecord(settings) ? Object.keys(settings) : [];
  } catch {
    return [];
  }
}

// `pi` loads the first of these in a directory, and only that one.
const CONTEXT_FILES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;

function contextFileIn(root: string): string | undefined {
  return CONTEXT_FILES.find((name) => {
    try {
      return statSync(join(root, name)).isFile();
    } catch {
      return false;
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function reasonFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
