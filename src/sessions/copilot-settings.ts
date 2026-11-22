/**
 * The user's own Copilot directory and the settings Copilot keeps in it, which
 * every Copilot session of that user starts with, and the token squiz signs
 * them in with.
 *
 * Nothing here throws. Every outcome is a value the caller reads.
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The user's Copilot directory: `COPILOT_HOME` where it is set, and `~/.copilot` otherwise. */
export function copilotHome(environment: NodeJS.ProcessEnv): string {
  const theirs = environment["COPILOT_HOME"];
  return theirs !== undefined && theirs.trim() !== "" ? resolve(theirs) : join(homeOf(environment), ".copilot");
}

/** The user's home directory: `HOME` where it is set, and the system's record of it otherwise. */
function homeOf(environment: NodeJS.ProcessEnv): string {
  const home = environment["HOME"];
  return home !== undefined && home.trim() !== "" ? resolve(home) : homedir();
}

/** The file Copilot's token is read from where `.squiz.json` names no `copilotTokenFile`. */
export function defaultTokenFile(environment: NodeJS.ProcessEnv): string {
  return join(homeOf(environment), ".config", "squiz", "copilot-token");
}

/**
 * Where the reviewer's Copilot takes its token from:
 *
 * - `named`: the `copilotTokenFile` that `.squiz.json` names, read or not;
 * - `default`: the default file, which exists and holds one token;
 * - `login`: Copilot's own login, with a `problem` where the default file
 *   exists and cannot be used.
 *
 * Only a named file fails a round. A default file that cannot be used leaves
 * Copilot on its own login.
 */
export type TokenSource =
  | { readonly source: "named"; readonly file: string }
  | { readonly source: "default"; readonly file: string }
  | { readonly source: "login"; readonly problem?: string };

export function tokenSource(named: string | null, environment: NodeJS.ProcessEnv): TokenSource {
  if (named !== null) return { source: "named", file: named };
  const file = defaultTokenFile(environment);
  try {
    statSync(file);
  } catch (cause) {
    // Only a file that is not there is passed over silently. One squiz cannot reach is a problem.
    const code = codeOf(cause);
    if (code === "ENOENT" || code === "ENOTDIR") return { source: "login" };
    return { source: "login", problem: `the Copilot token file ${file} could not be read: ${reasonFor(cause)}` };
  }
  const read = copilotToken(file);
  return "problem" in read ? { source: "login", problem: read.problem } : { source: "default", file };
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

/**
 * The token in `file`, the one `tokenSource` names, with the spaces, tabs and
 * line ends around it dropped.
 *
 * Copilot leaves `COPILOT_GITHUB_TOKEN` out of the environment it gives its
 * hooks, so a round host that a Copilot run's hook started never has it. The
 * file is how a token reaches the Copilot processes squiz starts there. The
 * token goes into their environment and nowhere else: never into an
 * argument, a log or a problem.
 *
 * Anything but letters, digits and `_` is refused. The reviewer's shell line
 * reads the file again, deleting those four characters, so only a file that
 * passes here reads the same in both.
 */
export function copilotToken(file: string): { readonly token: string } | { readonly problem: string } {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (cause) {
    return { problem: `the Copilot token file ${file} could not be read: ${reasonFor(cause)}` };
  }
  const token = text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/gu, "");
  if (token === "") return { problem: `the Copilot token file ${file} is empty` };
  if (!/^\w+$/u.test(token)) return { problem: `the Copilot token file ${file} holds something other than one token of letters, digits and _` };
  return { token };
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
