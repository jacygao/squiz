/**
 * `squiz doctor`: one line per dependency, saying it is present or what is
 * wrong with it, for a person setting squiz up.
 *
 * Each line comes from one check in `CHECKS`, and a later dependency is one
 * more check appended there. Only a check that fails changes the exit status.
 * A warning is printed and leaves it alone.
 *
 * It starts each tool once to ask its version, `gh` a second time for its
 * sign-in, and `git` a second time for the repository whose `.squiz.json`
 * names the reviewer. It reads settings files and writes nothing anywhere.
 */

import { spawnSync } from "node:child_process";

import { configFileName, loadConfig, type Config } from "../config/config.ts";
import { adapterFor } from "../reviewers/adapters.ts";
import { squizzesOnPath, thisSquiz } from "./path-link.ts";

/**
 * How one line bears on the exit status.
 *
 * - `present`: nothing wrong, or an optional tool that is absent.
 * - `warning`: something a person should see that squiz still runs without.
 * - `failed`: a required dependency is missing, unusable or unauthenticated.
 */
export type Level = "present" | "warning" | "failed";

export type Row = { readonly level: Level; readonly line: string };

export type DoctorContext = {
  /** The environment every probe runs in. Its `PATH` decides which tools are found. */
  readonly environment: NodeJS.ProcessEnv;
  /** Where it was run. Every probe starts there, and the reviewer is the one its repository configures. */
  readonly directory: string;
  /** The version of the Node running squiz, without the leading `v`. */
  readonly nodeVersion: string;
  /** How long one probe may run before it is killed and reported as not answering. */
  readonly boundMs: number;
};

/** One dependency's check. It never throws: whatever went wrong is its line. */
export type Check = (context: DoctorContext) => Row;

export type DoctorPrinted = { readonly stdout: string; readonly stderr: string; readonly exit: number };

/** Run `checks` in order, printing a line each, and exit 1 where any failed. */
export function squizDoctor(context: DoctorContext, checks: readonly Check[] = CHECKS): DoctorPrinted {
  const rows = checks.map((check) => check(context));
  const stdout = rows.map((row) => `${row.line}\n`).join("");
  return { stdout, stderr: "", exit: rows.some((row) => row.level === "failed") ? 1 : 0 };
}

/** What starting a tool came to. */
export type Probe =
  | { readonly outcome: "answered"; readonly stdout: string }
  | { readonly outcome: "absent" }
  | { readonly outcome: "failed"; readonly reason: string };

/**
 * Run `command` with `args` under the context's environment and bound.
 *
 * A command no directory on `PATH` holds is `absent`. One that was found but
 * could not start, ran out of time, or exited non-zero is `failed`, so a tool
 * that is installed and broken is never read as either missing or present.
 */
export function probe(command: string, args: readonly string[], context: DoctorContext): Probe {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: context.environment,
    cwd: context.directory,
    timeout: context.boundMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) {
    const code = "code" in result.error ? result.error.code : undefined;
    if (code === "ENOENT") return { outcome: "absent" };
    if (code === "ETIMEDOUT") {
      return { outcome: "failed", reason: `${command} did not answer within ${context.boundMs / 1_000} seconds` };
    }
    return { outcome: "failed", reason: `${command} could not be started: ${result.error.message}` };
  }
  if (result.status !== 0) {
    const exit = result.status === null ? `was killed by ${result.signal ?? "a signal"}` : `exited ${result.status}`;
    const said = firstLine(result.stderr) || firstLine(result.stdout);
    return { outcome: "failed", reason: said === "" ? `${command} ${exit} and said nothing` : `${command} ${exit}: ${said}` };
  }
  return { outcome: "answered", stdout: result.stdout };
}

/** What a version probe came to: the version, or the line saying why there is none. */
type Version =
  | { readonly outcome: "found"; readonly version: string }
  | { readonly outcome: "absent" }
  | { readonly outcome: "failed"; readonly reason: string };

// `3.7b` is how tmux numbers a release, so a trailing letter belongs to it.
const VERSION = /\b\d+(?:\.\d+)+[a-z]?\b/u;

function versionOf(command: string, args: readonly string[], context: DoctorContext): Version {
  const probed = probe(command, args, context);
  if (probed.outcome !== "answered") return probed;
  const found = VERSION.exec(probed.stdout)?.[0];
  if (found === undefined) {
    return { outcome: "failed", reason: `${command} printed no version: ${firstLine(probed.stdout)}` };
  }
  return { outcome: "found", version: found };
}

/** A check for a tool squiz cannot run without. */
function required(label: string, command: string, args: readonly string[]): Check {
  return (context) => {
    const found = versionOf(command, args, context);
    if (found.outcome === "found") return { level: "present", line: `${label} ${found.version}` };
    if (found.outcome === "absent") return { level: "failed", line: `${label}: not found` };
    return { level: "failed", line: `${label}: could not be run: ${found.reason}` };
  };
}

const MULTIPLEXER_OPTIONAL = "Not required: without tmux or Herdr, reviews run detached";

/** A check for a tool squiz uses where it is installed, and whose absence fails nothing. */
function optional(label: string, command: string, args: readonly string[], absent: string): Check {
  return (context) => {
    const found = versionOf(command, args, context);
    if (found.outcome === "found") return { level: "present", line: `${label} ${found.version}` };
    if (found.outcome === "absent") return { level: "present", line: `${label}: not found. ${absent}` };
    return { level: "warning", line: `${label}: warning: could not be run: ${found.reason}` };
  };
}

/**
 * `gh`'s version and whether it is signed in.
 *
 * The sign-in is read from `gh auth status --json`, which exits 0 whatever the
 * login's state and says it per host. `gh auth token` is no test: it can print
 * a token from the system's credential store that `gh` itself does not use.
 */
const gh: Check = (context) => {
  const found = versionOf("gh", ["--version"], context);
  if (found.outcome === "absent") return { level: "failed", line: "gh: not found" };
  if (found.outcome === "failed") return { level: "failed", line: `gh: could not be run: ${found.reason}` };
  const label = `gh ${found.version}`;

  const status = probe("gh", ["auth", "status", "--json", "hosts", "--active"], context);
  if (status.outcome === "absent") return { level: "failed", line: `${label}: its sign-in could not be checked: gh vanished from PATH` };
  if (status.outcome === "failed") return { level: "failed", line: `${label}: its sign-in could not be checked: ${status.reason}` };
  const accounts = accountsIn(status.stdout);
  if (accounts === undefined) {
    return { level: "failed", line: `${label}: its sign-in could not be checked: gh printed something other than JSON` };
  }

  const signedIn = accounts.find((account) => account.state === "success");
  if (signedIn !== undefined) {
    const where = signedIn.host === "github.com" ? "" : ` on ${signedIn.host}`;
    return { level: "present", line: `${label}, signed in as ${signedIn.login}${where}` };
  }
  const refused = accounts[0];
  if (refused === undefined) return { level: "failed", line: `${label}: not signed in. Run gh auth login` };
  const detail = refused.error === "" ? "" : `: ${refused.error}`;
  return {
    level: "failed",
    line: `${label}: not signed in: the login ${refused.login} on ${refused.host} failed its check${detail}`,
  };
};

type Account = { readonly state: string; readonly host: string; readonly login: string; readonly error: string };

/** The active account of each host `gh auth status --json hosts` lists, or `undefined` where it printed no such object. */
function accountsIn(stdout: string): Account[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isRecord(parsed["hosts"])) return undefined;
  const accounts: Account[] = [];
  for (const [host, entries] of Object.entries(parsed["hosts"])) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries as unknown[]) {
      if (!isRecord(entry)) continue;
      accounts.push({
        state: text(entry["state"]),
        host: text(entry["host"]) || host,
        login: text(entry["login"]),
        error: firstLine(text(entry["error"])),
      });
    }
  }
  return accounts;
}

/**
 * The Node that runs squiz, which is the one `bin/squiz` found on `PATH` when
 * it was started. A Node too old to strip types fails in the shim before it
 * reaches this line.
 */
const node: Check = (context) => {
  const major = Number(context.nodeVersion.split(".", 1)[0]);
  if (Number.isInteger(major) && major >= 24) return { level: "present", line: `Node ${context.nodeVersion}` };
  return { level: "failed", line: `Node ${context.nodeVersion}: too old. Squiz needs Node 24 or later` };
};

/**
 * What `squiz init`'s link would find on `PATH` for `target`, the squiz that is
 * running, with relative entries read from `directory`.
 *
 * No link is not a failure, because Claude Code's own shell runs squiz without
 * one. Anything `squiz init` would refuse or change is a warning, in its words,
 * and takes the same precedence it does.
 */
export function pathLink(target: () => string = thisSquiz, directory: () => string = () => process.cwd()): Check {
  return (context) => {
    let found;
    try {
      found = squizzesOnPath(target(), context.environment, directory());
    } catch (error) {
      return { level: "warning", line: `squiz link: warning: PATH could not be read: ${describe(error)}` };
    }
    const blocking = found.find((each) => each.kind === "conflict");
    if (blocking !== undefined) return { level: "warning", line: `squiz link: warning: ${blocking.reason}` };
    const earlier = found.find((each) => each.kind === "earlier");
    if (earlier !== undefined) {
      return {
        level: "warning",
        line: `squiz link: warning: ${earlier.entry} links to ${earlier.final}, another version of this install. Run squiz init to move it to this one`,
      };
    }
    const linked = found.find((each) => each.kind === "this");
    if (linked !== undefined) return { level: "present", line: `squiz link: ${linked.entry} already links to this squiz` };
    return {
      level: "present",
      line: "squiz link: none on PATH. Not required in Claude Code, whose own shell runs squiz; for another coding agent, run squiz init",
    };
  };
}

/**
 * The reviewer `.squiz.json` names, whether it is installed, and the model it
 * runs on.
 *
 * Outside a repository, or in one without the file, the reviewer is the
 * default. A file the configuration refuses fails the row, because no round
 * starts under it.
 */
const reviewer: Check = (context) => {
  let config: Config;
  try {
    config = loadConfig(repositoryRoot(context) ?? context.directory);
  } catch (cause) {
    return { level: "failed", line: `Reviewer: ${configFileName} refused: ${reasonFor(cause)}` };
  }

  const label = `Reviewer ${config.reviewer}`;
  const found = versionOf(config.reviewer, ["--version"], context);
  if (found.outcome === "absent") return { level: "failed", line: `${label}: not found` };
  if (found.outcome === "failed") return { level: "failed", line: `${label}: could not be run: ${found.reason}` };
  const installed = `${label} ${found.version}`;
  // No Copilot command reports its login without starting a session.
  const signIn = config.reviewer === "copilot" ? ". Its sign-in is not checked" : "";

  if (config.model !== null) {
    return { level: "present", line: `${installed}, model ${config.model}, from ${configFileName}${signIn}` };
  }
  const cli = config.reviewer === "pi" ? "pi" : "Copilot";
  const user = adapterFor(config.reviewer).userModel?.(context.environment);
  if (typeof user === "string") return { level: "present", line: `${installed}, model ${user}, ${cli}'s default${signIn}` };
  if (user === undefined) {
    return { level: "present", line: `${installed}, model unknown: neither ${configFileName} nor ${cli}'s settings name one${signIn}` };
  }
  if (user.failsTheRound) return { level: "failed", line: `${installed}: model unknown: ${user.problem}` };
  return { level: "warning", line: `${installed}: warning: model unknown: ${user.problem}` };
};

/** The root of the repository the check runs in, or `undefined` where git names none. */
function repositoryRoot(context: DoctorContext): string | undefined {
  const asked = probe("git", ["rev-parse", "--show-toplevel"], context);
  if (asked.outcome !== "answered") return undefined;
  const root = asked.stdout.trim();
  return root === "" ? undefined : root;
}

function reasonFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Every dependency a project needs, in the order they print. */
export const CHECKS: readonly Check[] = [
  required("git", "git", ["--version"]),
  gh,
  required("Claude Code", "claude", ["--version"]),
  node,
  optional("tmux", "tmux", ["-V"], MULTIPLEXER_OPTIONAL),
  optional("Herdr", "herdr", ["--version"], MULTIPLEXER_OPTIONAL),
  pathLink(),
  reviewer,
];

function firstLine(output: string): string {
  return output.trim().split("\n", 1)[0]?.trim() ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
