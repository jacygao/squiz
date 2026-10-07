/**
 * The user's default model as `pi`'s global settings give it.
 *
 * A project's own `.pi/settings.json` is not read, because a review runs `pi`
 * with the project untrusted and it never applies. Nothing here throws.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { UserModel } from "../adapter.ts";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function reasonFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
