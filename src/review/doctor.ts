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
 * names the reviewer, which every row that reads the repository shares. It
 * reads settings files and plugin manifests, and writes nothing anywhere.
 */

import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { configFileName, defaultConfig, loadConfig, type Config } from "../config/config.ts";
import { adapterFor } from "../reviewers/adapters.ts";
import { copilotHome, userSettings } from "../sessions/copilot-settings.ts";
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
  /** The system whose limit on a socket path applies. */
  readonly platform: NodeJS.Platform;
};

/**
 * One dependency's check. It never throws: whatever went wrong is its line.
 * It may print more than one line, and an empty list prints nothing, for a row
 * with nothing to say on this machine or in this project.
 */
export type Check = (context: DoctorContext) => Row | readonly Row[];

export type DoctorPrinted = { readonly stdout: string; readonly stderr: string; readonly exit: number };

/** Run `checks` in order, printing a line each, and exit 1 where any failed. */
export function squizDoctor(context: DoctorContext, checks: readonly Check[] = CHECKS): DoctorPrinted {
  const rows = checks.flatMap((check) => check(context));
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

// One run of the check asks each tool its version once, though more than one row reads it.
const versionsAsked = new WeakMap<DoctorContext, Map<string, Version>>();

function versionOf(command: string, args: readonly string[], context: DoctorContext): Version {
  const asked = versionsAsked.get(context) ?? new Map<string, Version>();
  versionsAsked.set(context, asked);
  const key = [command, ...args].join("\0");
  const known = asked.get(key);
  if (known !== undefined) return known;
  const version = askVersion(command, args, context);
  asked.set(key, version);
  return version;
}

function askVersion(command: string, args: readonly string[], context: DoctorContext): Version {
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

/**
 * Claude Code. Its absence is no failure where a `copilot` that runs can be
 * the coding agent instead. One installed and broken still fails.
 */
const claudeCode: Check = (context) => {
  const found = versionOf("claude", ["--version"], context);
  if (found.outcome === "found") return { level: "present", line: `Claude Code ${found.version}` };
  if (found.outcome === "failed") return { level: "failed", line: `Claude Code: could not be run: ${found.reason}` };
  if (versionOf("copilot", ["--version"], context).outcome !== "found") return { level: "failed", line: "Claude Code: not found" };
  return { level: "present", line: "Claude Code: not found. Not required: copilot is installed, and either can be the coding agent" };
};

/**
 * Copilot as a coding agent, wherever `copilot` is installed, since nothing
 * says whether it writes this person's code. A review wakes its session only
 * through the plugin's extension, which needs experimental features on and a
 * socket path the system accepts. For the same reason, nothing here is more
 * than a warning.
 */
const copilot: Check = (context) => {
  const found = versionOf("copilot", ["--version"], context);
  if (found.outcome === "absent") return [];
  if (found.outcome === "failed") return { level: "warning", line: `copilot: warning: could not be run: ${found.reason}` };
  return [experimentalFeatures(found.version, context), ...socketFits(context)];
};

function experimentalFeatures(version: string, context: DoctorContext): Row {
  const unknown = (reason: string): Row => ({
    level: "warning",
    line: `warning: copilot ${version}: whether experimental features are on is unknown: ${reason}`,
  });
  const read = userSettings(context.environment);
  if (read.outcome === "unreadable") return unknown(read.problem);
  const setting = read.outcome === "read" ? read.settings["experimental"] : undefined;
  if (setting === true) return { level: "present", line: `copilot ${version}, experimental features on` };
  // Copilot starts without experimental features where its settings do not turn them on.
  if (setting !== undefined && setting !== false) return unknown(`"experimental" is ${JSON.stringify(setting)} in ${read.file}`);
  return {
    level: "warning",
    line: `warning: copilot ${version} has experimental features off. If Copilot writes your code, it is never woken when a review finishes. Run /experimental on in Copilot, or start it once with copilot --experimental`,
  };
}

// Copilot names a session's state directory by its id, a 36-character UUID.
const SESSION_ID_LENGTH = 36;

/** A warning where the extension's socket path is longer than the system lets a socket be bound at. */
function socketFits(context: DoctorContext): Row[] {
  const longest = join(copilotHome(context.environment), "session-state", "x".repeat(SESSION_ID_LENGTH), "squiz.sock");
  const bytes = Buffer.byteLength(longest, "utf8");
  const [limit, system] = context.platform === "linux" ? [108, "Linux"] : [104, "macOS"];
  if (bytes <= limit) return [];
  const shown = join(copilotHome(context.environment), "session-state", "<session id>", "squiz.sock");
  return [
    {
      level: "warning",
      line: `warning: copilot's extension cannot listen: its socket ${shown} is ${bytes} bytes, over the ${limit} ${system} allows. Set COPILOT_HOME to a shorter directory`,
    },
  ];
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
export function pathLink(target: () => string = thisSquiz, directory: () => string = () => process.cwd()): (context: DoctorContext) => Row {
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
 * Each copy of squiz Copilot keeps, against this squiz's version, where
 * `copilot` is on `PATH`.
 *
 * Copilot's hook runs its own copy, so two versions write one state file
 * wherever the two differ. A difference, or a version that cannot be read, is a
 * warning. Nothing prints where Copilot has no copy.
 */
export function copilotCopies(target: () => string = thisSquiz): Check {
  return (context) => {
    if (versionOf("copilot", ["--version"], context).outcome === "absent") return [];
    const plugins = join(copilotHome(context.environment), "installed-plugins");
    let copies: string[];
    const unlisted: Row[] = [];
    try {
      copies = copiesIn(plugins, (directory, error) =>
        unlisted.push({ level: "warning", line: `Copilot's squiz: warning: ${directory} could not be read: ${describe(error)}` }),
      );
    } catch (error) {
      if (codeOf(error) === "ENOENT") return [];
      return { level: "warning", line: `Copilot's squiz: warning: ${plugins} could not be read: ${describe(error)}` };
    }
    if (copies.length === 0) return unlisted;
    let root: string;
    try {
      root = dirname(dirname(target()));
    } catch (error) {
      return { level: "warning", line: `Copilot's squiz: warning: this squiz could not be found: ${describe(error)}` };
    }
    const ours = manifestOf(root);
    return [...unlisted, ...copies.flatMap((copy) => compared(copy, manifestOf(copy), root, ours))];
  };
}

/**
 * Every directory under `plugins` that may be squiz, sorted.
 *
 * A marketplace install is `<marketplace>/squiz`, and a direct one is
 * `_direct/<name>`, named for its source. A direct copy counts where its
 * manifest names squiz, or where it has no readable manifest and holds
 * `bin/squiz`, so that a broken copy is reported rather than passed over.
 *
 * Throws where `plugins` itself cannot be listed. A `_direct` that cannot be
 * listed goes to `unlisted`, and the marketplace copies are still returned.
 */
function copiesIn(plugins: string, unlisted: (directory: string, error: unknown) => void): string[] {
  const candidates: string[] = [];
  for (const entry of readdirSync(plugins, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name !== "_direct") {
      const copy = join(plugins, entry.name, "squiz");
      if (mayExist(copy)) candidates.push(copy);
      continue;
    }
    const directory = join(plugins, entry.name);
    let directs;
    try {
      directs = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      unlisted(directory, error);
      continue;
    }
    for (const direct of directs) {
      if (!direct.isDirectory()) continue;
      const copy = join(plugins, entry.name, direct.name);
      const manifest = manifestOf(copy);
      if (manifest.outcome === "read" || (manifest.outcome === "unreadable" && mayExist(join(copy, "bin", "squiz")))) {
        candidates.push(copy);
      }
    }
  }
  return candidates.sort();
}

// Only a path the system says is missing is absent. One it refuses to look at may be a copy, and is reported as one.
function mayExist(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    const code = codeOf(error);
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

/** What a plugin's `.claude-plugin/plugin.json` says: squiz's version, another plugin, or why it could not be read. */
type Manifest =
  | { readonly outcome: "read"; readonly version: string }
  | { readonly outcome: "other" }
  | { readonly outcome: "unreadable"; readonly reason: string };

function manifestOf(root: string): Manifest {
  const file = join(root, ".claude-plugin", "plugin.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) return { outcome: "unreadable", reason: `${file} is not JSON: ${error.message}` };
    return { outcome: "unreadable", reason: `${file} could not be read: ${describe(error)}` };
  }
  if (!isRecord(parsed)) return { outcome: "unreadable", reason: `${file} is not an object` };
  const name = parsed["name"];
  if (typeof name !== "string" || name.trim() === "") return { outcome: "unreadable", reason: `${file} names no plugin` };
  if (name !== "squiz") return { outcome: "other" };
  const version = parsed["version"];
  if (typeof version !== "string" || version.trim() === "") return { outcome: "unreadable", reason: `${file} names no version` };
  return { outcome: "read", version };
}

function compared(copy: string, theirs: Manifest, root: string, ours: Manifest): Row[] {
  if (theirs.outcome === "other") return [];
  if (theirs.outcome === "unreadable") {
    return [{ level: "warning", line: `Copilot's squiz: warning: the version of ${copy} could not be read: ${theirs.reason}` }];
  }
  if (ours.outcome !== "read") {
    const reason = ours.outcome === "unreadable" ? ours.reason : `${root} is not squiz`;
    return [
      {
        level: "warning",
        line: `Copilot's squiz: warning: ${copy} is ${theirs.version}, and the version of this squiz at ${root} could not be read: ${reason}`,
      },
    ];
  }
  if (theirs.version === ours.version) {
    return [{ level: "present", line: `Copilot's squiz: ${copy} is ${theirs.version}, as this squiz is` }];
  }
  const older = olderOf(theirs.version, ours.version);
  const update =
    older === "first" ? "Update Copilot's copy, which is older" : older === "second" ? "Update this squiz, which is older" : "Update the older one";
  return [
    {
      level: "warning",
      line: `Copilot's squiz: warning: ${copy} is ${theirs.version}, and this squiz at ${root} is ${ours.version}. Copilot's hook runs its own copy, so two versions write one state file. ${update}`,
    },
  ];
}

const DOTTED = /^\d+(?:\.\d+)*$/u;

/** Which of two different versions is older, or `undefined` where either is more than dotted numbers. */
function olderOf(first: string, second: string): "first" | "second" | undefined {
  if (!DOTTED.test(first) || !DOTTED.test(second)) return undefined;
  const a = first.split(".").map(Number);
  const b = second.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference < 0 ? "first" : "second";
  }
  return undefined;
}

function codeOf(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

/**
 * The reviewer `.squiz.json` names, whether it is installed, and the model it
 * runs on.
 *
 * Outside a repository, or in one without the file, the reviewer is the
 * default. A file the configuration refuses fails the row, because no round
 * starts under it, and so does a git that cannot name the repository.
 */
const reviewer: Check = (context) => {
  const project = projectOf(context);
  if (project.outcome === "failed") return { level: "failed", line: project.line };
  const { config } = project;

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

/**
 * The project's own reviewer settings that a review leaves unused, and the
 * context file that reaches the reviewer all the same.
 *
 * It reports configuration only: that the files exist where the reviewer would
 * look. Whether the reviewer leaves them unused is not tested here. Nothing
 * prints for a reviewer whose adapter reads no project settings, outside a
 * repository, or where the reviewer's row failed on the repository and already
 * said why.
 */
const projectSettings: Check = (context) => {
  const project = projectOf(context);
  if (project.outcome === "failed" || project.root === undefined) return [];
  const { reviewer } = project.config;
  const read = adapterFor(reviewer).projectSettings;
  if (read === undefined) return [];
  const { unused, contextFile } = read(project.root);
  if (unused.length === 0) return [];
  const named = unused.map(({ path, keys }) => (keys.length === 0 ? path : `${path} (${keys.join(", ")})`));
  const reaches = contextFile === undefined ? "" : `. ${contextFile} still reaches the reviewer`;
  return {
    level: "present",
    line: `${reviewer} project settings: a review does not use ${inProse(named)}, and takes your own ${reviewer} settings instead${reaches}`,
  };
};

function inProse(items: readonly string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;
}

/** The repository's root, `undefined` outside one, and the configuration read there. */
type Project =
  | { readonly outcome: "found"; readonly root: string | undefined; readonly config: Config }
  | { readonly outcome: "failed"; readonly line: string };

const projects = new WeakMap<DoctorContext, Project>();

/** The project the check runs in, found once per run and shared by every row that reads it. */
function projectOf(context: DoctorContext): Project {
  const known = projects.get(context);
  if (known !== undefined) return known;
  const found = findProject(context);
  projects.set(context, found);
  return found;
}

function findProject(context: DoctorContext): Project {
  const root = repositoryRoot(context);
  if (root.outcome === "failed") return { outcome: "failed", line: `Reviewer: the repository could not be found: ${root.reason}` };
  if (root.outcome === "outside") return { outcome: "found", root: undefined, config: { ...defaultConfig } };
  try {
    return { outcome: "found", root: root.path, config: loadConfig(root.path) };
  } catch (cause) {
    return { outcome: "failed", line: `Reviewer: ${configFileName} refused: ${reasonFor(cause)}` };
  }
}

type Root =
  | { readonly outcome: "found"; readonly path: string }
  | { readonly outcome: "outside" }
  | { readonly outcome: "failed"; readonly reason: string };

// Git's message is matched as text, so it is asked for untranslated.
const NOT_A_REPOSITORY = /fatal: not a git repository/u;

/**
 * The root of the repository the check runs in. Only git saying this is no
 * repository is `outside`; any other refusal is `failed`, because a round run
 * here would stop on it too.
 */
function repositoryRoot(context: DoctorContext): Root {
  const untranslated = { ...context, environment: { ...context.environment, LC_ALL: "C" } };
  const asked = probe("git", ["rev-parse", "--show-toplevel"], untranslated);
  if (asked.outcome === "absent") return { outcome: "failed", reason: "git is not on PATH" };
  if (asked.outcome === "failed") {
    return NOT_A_REPOSITORY.test(asked.reason) ? { outcome: "outside" } : { outcome: "failed", reason: asked.reason };
  }
  const root = asked.stdout.trim();
  return root === "" ? { outcome: "failed", reason: "git named no worktree for this directory" } : { outcome: "found", path: root };
}

function reasonFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Every dependency a project needs, in the order they print. */
export const CHECKS: readonly Check[] = [
  required("git", "git", ["--version"]),
  gh,
  claudeCode,
  copilot,
  node,
  optional("tmux", "tmux", ["-V"], MULTIPLEXER_OPTIONAL),
  optional("Herdr", "herdr", ["--version"], MULTIPLEXER_OPTIONAL),
  pathLink(),
  copilotCopies(),
  reviewer,
  projectSettings,
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
