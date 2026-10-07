/**
 * The user's own Copilot directory and the settings Copilot keeps in it, which
 * every Copilot session of that user starts with.
 *
 * Nothing here throws. Every outcome is a value the caller reads.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The user's Copilot directory: `COPILOT_HOME` where it is set, and `~/.copilot` otherwise. */
export function copilotHome(environment: NodeJS.ProcessEnv): string {
  const theirs = environment["COPILOT_HOME"];
  return theirs !== undefined && theirs.trim() !== "" ? resolve(theirs) : join(environment["HOME"] ?? homedir(), ".copilot");
}

export type UserSettings =
  | { readonly outcome: "read"; readonly file: string; readonly settings: Readonly<Record<string, unknown>> }
  | { readonly outcome: "absent"; readonly file: string }
  | { readonly outcome: "unreadable"; readonly file: string; readonly problem: string };

/** The user's own `<COPILOT_HOME>/settings.json`. A project's settings are never read. */
export function userSettings(environment: NodeJS.ProcessEnv): UserSettings {
  const file = join(copilotHome(environment), "settings.json");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (cause) {
    if (codeOf(cause) === "ENOENT") return { outcome: "absent", file };
    return { outcome: "unreadable", file, problem: `the user's Copilot settings ${file} could not be read: ${reasonFor(cause)}` };
  }
  let settings: unknown;
  try {
    // Copilot heads the files it manages with `//` lines, which JSON does not allow.
    settings = JSON.parse(text.replace(/^\s*\/\/.*$/gmu, ""));
  } catch (cause) {
    return { outcome: "unreadable", file, problem: `the user's Copilot settings ${file} are not JSON: ${reasonFor(cause)}` };
  }
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    return { outcome: "unreadable", file, problem: `the user's Copilot settings ${file} are not an object` };
  }
  return { outcome: "read", file, settings: settings as Record<string, unknown> };
}

function codeOf(cause: unknown): unknown {
  return typeof cause === "object" && cause !== null ? (cause as { code?: unknown }).code : undefined;
}

function reasonFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
