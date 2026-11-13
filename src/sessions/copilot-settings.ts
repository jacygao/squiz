/**
 * The user's own Copilot directory and the settings Copilot keeps in it, which
 * every Copilot session of that user starts with, and the flags every Copilot
 * session squiz starts carries.
 *
 * Nothing here throws. Every outcome is a value the caller reads.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The flags every Copilot run squiz starts carries, the fixer's as well as the
 * reviewer's. They turn off the built-in GitHub MCP server, and leave the run
 * reaching GitHub's API and its model host, and no other.
 */
export const COPILOT_QUIET_FLAGS: readonly string[] = ["--disable-builtin-mcps", "--no-auto-update", "--disable-client-telemetry"];

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
  return objectIn(join(copilotHome(environment), "settings.json"), "settings", "are");
}

/** The fields of the user's `config.json` that say who is signed in, and nothing that holds a token. */
const LOGIN_FIELDS = ["loggedInUsers", "lastLoggedInUser"] as const;

/**
 * Who the user is signed in to Copilot as: the `LOGIN_FIELDS` of their own
 * `<COPILOT_HOME>/config.json`, where Copilot's `login` records them. Copilot
 * finds a login in the system's credential store only through them. Every other
 * field is left out, the tokens and the trusted folders among them.
 */
export function userLogins(environment: NodeJS.ProcessEnv): UserSettings {
  const read = objectIn(join(copilotHome(environment), "config.json"), "configuration", "is");
  if (read.outcome !== "read") return read;
  const logins = Object.fromEntries(LOGIN_FIELDS.filter((field) => field in read.settings).map((field) => [field, read.settings[field]]));
  return { ...read, settings: logins };
}

/**
 * Write who the user is signed in to Copilot as into `home`'s `config.json`, so
 * that Copilot under `home` finds their login in the system's credential store.
 * Writes nothing where the user's own configuration names no login. Returns why
 * it failed, or `undefined`.
 */
export function carryLogins(home: string, environment: NodeJS.ProcessEnv): string | undefined {
  const read = userLogins(environment);
  if (read.outcome === "absent") return undefined;
  if (read.outcome === "unreadable") return read.problem;
  if (Object.keys(read.settings).length === 0) return undefined;
  const file = join(home, "config.json");
  try {
    writeFileSync(file, `${JSON.stringify(read.settings)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (cause) {
    return `who the user is signed in to Copilot as could not be written to ${file}: ${reasonFor(cause)}`;
  }
  return undefined;
}

function objectIn(file: string, what: string, are: "are" | "is"): UserSettings {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (cause) {
    if (codeOf(cause) === "ENOENT") return { outcome: "absent", file };
    return { outcome: "unreadable", file, problem: `the user's Copilot ${what} ${file} could not be read: ${reasonFor(cause)}` };
  }
  let settings: unknown;
  try {
    // Copilot heads the files it manages with `//` lines, which JSON does not allow.
    settings = JSON.parse(text.replace(/^\s*\/\/.*$/gmu, ""));
  } catch (cause) {
    return { outcome: "unreadable", file, problem: `the user's Copilot ${what} ${file} ${are} not JSON: ${reasonFor(cause)}` };
  }
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    return { outcome: "unreadable", file, problem: `the user's Copilot ${what} ${file} ${are} not an object` };
  }
  return { outcome: "read", file, settings: settings as Record<string, unknown> };
}

function codeOf(cause: unknown): unknown {
  return typeof cause === "object" && cause !== null ? (cause as { code?: unknown }).code : undefined;
}

function reasonFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
