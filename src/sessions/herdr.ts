/**
 * Start a command in a Herdr pane a person can watch, and close the pane.
 *
 * Every start ends in one of three outcomes:
 *
 * - **Started**: the command runs in the pane, and its process group's leader
 *   is known.
 * - **Refused**: Herdr opened no pane, for certain, so the caller can start the
 *   command somewhere else without running it twice.
 * - **Failed**: anything else. A pane may have opened, but the command never
 *   ran. A pane this module opened is closed before it says so, and named where
 *   the close could not be confirmed.
 *
 * **The start returns once the command is running, however long it runs.**
 * The command is typed into the pane's shell behind a gate: a `/bin/sh` that
 * writes its pid, waits for the gate to open, and then becomes the command. The
 * gate opens only once the leader has been read, so a command that would exit
 * at once is still running when it is read, and a start that fails never lets
 * the command run.
 *
 * **The leader is the pane's foreground group, read while the gate is shut.**
 * `shell_pid` is the pane's shell, whose group does not hold the command, so a
 * group equal to the shell's is never returned.
 *
 * Herdr is before 1.0. Each answer is read field by field, and one that cannot
 * be read is a failure, never a pane. Nothing here throws.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { identityOf, type ProcessIdentity } from "./process.ts";

export type HerdrEnvironment = Readonly<Record<string, string | undefined>>;

export type HerdrOptions = {
  /** What every `herdr` runs with. Its `HERDR_SOCKET_PATH` names the server. */
  readonly environment: HerdrEnvironment;
  /**
   * Bounds each `herdr` and `ps` this runs, since one cut short could not tell
   * what it did. Also bounds the wait for a new pane's shell to reach its prompt.
   */
  readonly boundMs: number;
};

export type PaneCommand = {
  readonly directory: string;
  /** The tab's label. */
  readonly name: string;
  /** The executable, found on the path of the pane's shell. */
  readonly program: string;
  readonly arguments: readonly string[];
  /** How long the command may take to start running once the pane's shell has it. */
  readonly startsWithinMs: number;
  /** The workspace the tab opens in. Absent, it opens in the focused one. */
  readonly workspace?: string;
  /**
   * Set in the pane's shell, and again on the command's line. Herdr starts the shell
   * with the server's environment, so the client's own reaches it only through these.
   */
  readonly variables?: Readonly<Record<string, string>>;
};

export type PaneStart =
  | { readonly outcome: "started"; readonly pane: string; readonly leader: ProcessIdentity }
  | { readonly outcome: "refused"; readonly reason: string }
  | { readonly outcome: "failed"; readonly reason: string; readonly paneLeftOpen?: string };

export type PaneClose = { readonly outcome: "closed" } | { readonly outcome: "failed"; readonly reason: string };

export function insideHerdr(environment: HerdrEnvironment): boolean {
  return (environment["HERDR_SOCKET_PATH"] ?? "") !== "";
}

/** Whether `id` has the shape of a Herdr workspace id, such as `w2`. */
export function isHerdrWorkspace(id: string): boolean {
  return /^w[1-9][0-9]{0,8}$/u.test(id);
}

/**
 * Open a tab in `command.directory`, and start the command in its pane.
 *
 * A workspace Herdr no longer has opens the tab in the focused workspace, as if
 * none were given. Herdr refused, so nothing opened and nothing runs twice, and
 * the person still sees the command. Herdr does not reuse a workspace id, so the
 * refusal cannot mean some other workspace.
 */
export function startInHerdrPane(command: PaneCommand, options: HerdrOptions): PaneStart {
  // The pane's shell reads the command as typed, so a control character in it
  // would be a key: a newline would end the line early, and a tab would complete.
  const unsafe = command.arguments.findIndex((argument) => CONTROL.test(argument));
  if (unsafe !== -1) {
    const reason = `argument ${unsafe + 1} holds a control character, which a pane's shell would read as a key`;
    return { outcome: "refused", reason };
  }
  let gate: string;
  try {
    gate = mkdtempSync(join(tmpdir(), "squiz-gate-"));
  } catch (cause) {
    return { outcome: "refused", reason: `no gate could be made to hold the command back: ${String(cause)}` };
  }
  const started = startBehind(gate, command, options);
  // An opened gate is the command's to remove, on its way to running.
  if (started.outcome !== "started") rmSync(gate, { recursive: true, force: true });
  return started;
}

/** Close `pane`, and confirm with Herdr that it no longer has it. */
export function closeHerdrPane(pane: string, options: HerdrOptions): PaneClose {
  // What the close said is not trusted either way. Only asking for the pane afterwards confirms it.
  const close = herdr(["pane", "close", pane], options.environment, options.boundMs);
  const after = herdr(["pane", "get", pane], options.environment, options.boundMs);
  if (after.outcome === "refused" && after.code === "pane_not_found") return { outcome: "closed" };
  const closeSaid = close.outcome === "answered" ? "closed" : describe(close);
  const afterSaid = after.outcome === "answered" ? "Herdr still has the pane" : describe(after);
  return { outcome: "failed", reason: `herdr pane close: ${closeSaid}; then herdr pane get: ${afterSaid}` };
}

/**
 * What the pane's shell runs: `/bin/sh -c GATE <gate> <polls> <program> <arguments…>`.
 *
 * It writes its pid to `<gate>/pid`, or `<gate>/absent` where the program is not
 * on its path. It then waits for `<gate>/go`, and becomes the program. It gives
 * up after `<polls>` waits without ever running the program, so a start that
 * failed and could not close its pane still runs nothing.
 */
const GATE = [
  'd=$0; n=$1; shift',
  'command -v "$1" >/dev/null 2>&1 || { : > "$d/absent"; exit 127; }',
  'echo $$ > "$d/pid.part" && mv "$d/pid.part" "$d/pid" || exit 125',
  'while [ ! -e "$d/go" ]; do n=$((n - 1)); [ "$n" -gt 0 ] || exit 125; sleep 0.05; done',
  'rm -f "$d/go"; rmdir "$d" 2>/dev/null',
  'exec "$@"',
].join("; ");

const GATE_POLL_MS = 50;

// Longer than every step between the pid appearing and the gate opening, each
// of which is bounded once.
const GATE_HOLDS_BOUNDS = 4;

// Any C0 control character, and DEL.
const CONTROL = /[\u0000-\u001f\u007f]/u;

function startBehind(gate: string, command: PaneCommand, options: HerdrOptions): PaneStart {
  const polls = Math.ceil((GATE_HOLDS_BOUNDS * options.boundMs) / GATE_POLL_MS);
  // Set again on the line, because the pane's shell runs a person's startup
  // files after `--env`, and those can set any of them. `env` becomes the gate
  // with the same pid.
  const assigned = Object.entries(command.variables ?? {}).map(([name, value]) => `${name}=${value}`);
  const settings = assigned.length === 0 ? [] : ["/usr/bin/env", ...assigned];
  const gated = [...settings, "/bin/sh", "-c", GATE, gate, String(polls), command.program, ...command.arguments]
    .map(quoted)
    .join(" ");
  if (CONTROL.test(gated)) {
    return { outcome: "refused", reason: `the gate ${JSON.stringify(gate)} holds a control character` };
  }
  const line = typeable(gated, gate);
  if (line.outcome === "unwritten") return { outcome: "refused", reason: line.reason };
  const variables = Object.entries(command.variables ?? {}).flatMap(([name, value]) => ["--env", `${name}=${value}`]);
  const tab = ["tab", "create", "--cwd", command.directory, "--label", command.name, "--no-focus", ...variables];
  let created: Answer;
  if (command.workspace === undefined) {
    created = herdr(tab, options.environment, options.boundMs);
  } else {
    // A malformed id is a bug upstream, and one like `--focus` would be read as a flag.
    if (!isHerdrWorkspace(command.workspace)) {
      return { outcome: "refused", reason: `${JSON.stringify(command.workspace)} is not a Herdr workspace id` };
    }
    created = herdr([...tab, "--workspace", command.workspace], options.environment, options.boundMs);
    if (created.outcome === "refused" && created.code === "workspace_not_found") {
      created = herdr(tab, options.environment, options.boundMs);
    }
  }
  if (created.outcome === "absent") return { outcome: "refused", reason: created.reason };
  if (created.outcome === "refused") {
    return { outcome: "refused", reason: `herdr tab create refused: ${created.code}: ${created.message}` };
  }
  if (created.outcome === "unknown") return { outcome: "failed", reason: `herdr tab create: ${created.reason}` };
  const pane = field(field(created.result, "root_pane"), "pane_id");
  if (typeof pane !== "string" || pane === "") {
    return { outcome: "failed", reason: `herdr tab create named no pane: ${JSON.stringify(created.result)}` };
  }

  // A new pane's shell runs its own startup first, and a line typed meanwhile
  // can be lost to it.
  const notReady = atPrompt(pane, options);
  if (notReady !== undefined) return abandon(pane, notReady, options);

  // `pane run` types the line and returns at once. Whatever it answered, the
  // line may have been typed, which is safe only because the gate is still shut.
  const sent = herdr(["pane", "run", pane, line.typed], options.environment, options.boundMs);
  if (sent.outcome !== "answered") return abandon(pane, `herdr pane run: ${describe(sent)}`, options);

  const pid = gatedPid(gate, command);
  if (pid.outcome !== "read") return abandon(pane, pid.reason, options);
  // The gate becomes the command without changing its pid, group or start
  // time, so the identity read now is the command's.
  const group = foregroundGroup(pane, options);
  if (group.outcome !== "read") return abandon(pane, group.reason, options);
  if (group.group !== pid.pid) {
    return abandon(pane, `the pane's foreground group is ${group.group}, not the command's ${pid.pid}`, options);
  }
  const leader = identityOf(pid.pid, options.boundMs);
  if (leader.outcome === "gone") return abandon(pane, `the command ${pid.pid} had gone before its gate opened`, options);
  if (leader.outcome === "unknown") return abandon(pane, leader.reason, options);
  // A group id is not reused while the group has a member, so the same group
  // afterwards means the identity read in between is its leader's, not a stranger's.
  const again = foregroundGroup(pane, options);
  if (again.outcome !== "read") return abandon(pane, again.reason, options);
  if (again.group !== group.group) {
    const changed = `the pane's foreground group changed from ${group.group} to ${again.group} while it was read`;
    return abandon(pane, changed, options);
  }
  try {
    writeFileSync(join(gate, "go"), "");
  } catch (cause) {
    return abandon(pane, `the gate could not be opened: ${String(cause)}`, options);
  }
  return { outcome: "started", pane, leader: leader.identity };
}

/**
 * The most a line typed into a pane may hold.
 *
 * A new pane's shell may not have started its line editor when the line
 * arrives. The terminal then keeps 1024 bytes of an unfinished line on macOS,
 * and a line cut inside a quoted word runs nothing.
 */
const TYPED_AT_MOST = 512;

type Typeable =
  | { readonly outcome: "typeable"; readonly typed: string }
  | { readonly outcome: "unwritten"; readonly reason: string };

/**
 * `gated` as it is typed: whole where it fits, and otherwise a short line that
 * runs it from a file in the gate.
 *
 * The file is written whole before anything is typed. It removes itself and
 * then becomes the gated line, so the gate's pid is still the typed command's.
 */
function typeable(gated: string, gate: string): Typeable {
  if (Buffer.byteLength(gated) <= TYPED_AT_MOST) return { outcome: "typeable", typed: gated };
  const file = join(gate, "line");
  try {
    writeFileSync(file, `rm -f "$0"; exec ${gated}\n`, { mode: 0o600 });
  } catch (cause) {
    return { outcome: "unwritten", reason: `the command's line could not be written to the gate: ${String(cause)}` };
  }
  return { outcome: "typeable", typed: ["/bin/sh", file].map(quoted).join(" ") };
}

/** Close a pane a start opened and could not finish, and say why the start failed. */
function abandon(pane: string, reason: string, options: HerdrOptions): PaneStart {
  const closed = closeHerdrPane(pane, options);
  if (closed.outcome === "closed") return { outcome: "failed", reason };
  return { outcome: "failed", reason: `${reason}; and ${closed.reason}`, paneLeftOpen: pane };
}

const RETRY_MS = 100;

/** Block this thread for `ms`. The start is synchronous throughout, so there is nothing to yield to. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Wait for the pane's shell to hold the foreground alone, and say why not where it never did. */
function atPrompt(pane: string, options: HerdrOptions): string | undefined {
  const until = Date.now() + options.boundMs;
  for (;;) {
    const info = processInfo(pane, options);
    if (info.outcome !== "read") return info.reason;
    if (info.group === info.shell) return undefined;
    if (Date.now() >= until) {
      return `the pane's shell was still running ${info.group} in the foreground after ${options.boundMs}ms`;
    }
    pause(RETRY_MS);
  }
}

type PidRead = { readonly outcome: "read"; readonly pid: number } | { readonly outcome: "unknown"; readonly reason: string };

/** The pid the gate wrote, once it has. */
function gatedPid(gate: string, command: PaneCommand): PidRead {
  const until = Date.now() + command.startsWithinMs;
  for (;;) {
    if (existsSync(join(gate, "absent"))) {
      return { outcome: "unknown", reason: `the pane's shell found no ${command.program} on its path` };
    }
    let written: string | undefined;
    try {
      written = readFileSync(join(gate, "pid"), "utf8").trim();
    } catch {
      written = undefined;
    }
    if (written !== undefined) {
      const pid = Number(written);
      if (isPid(pid)) return { outcome: "read", pid };
      return { outcome: "unknown", reason: `the gate wrote ${JSON.stringify(written)}, which is no pid` };
    }
    if (Date.now() >= until) {
      return { outcome: "unknown", reason: `the command did not start in the pane within ${command.startsWithinMs}ms` };
    }
    pause(GATE_POLL_MS);
  }
}

type GroupRead =
  | { readonly outcome: "read"; readonly group: number }
  | { readonly outcome: "unknown"; readonly reason: string };

/** The pane's foreground process group, where it is not the shell's. */
function foregroundGroup(pane: string, options: HerdrOptions): GroupRead {
  const info = processInfo(pane, options);
  if (info.outcome !== "read") return info;
  if (info.group === info.shell) {
    const reason = `the pane's foreground group ${info.group} is its shell's, so the command was not running`;
    return { outcome: "unknown", reason };
  }
  return { outcome: "read", group: info.group };
}

type InfoRead =
  | { readonly outcome: "read"; readonly group: number; readonly shell: number }
  | { readonly outcome: "unknown"; readonly reason: string };

function processInfo(pane: string, options: HerdrOptions): InfoRead {
  const answer = herdr(["pane", "process-info", "--pane", pane], options.environment, options.boundMs);
  if (answer.outcome !== "answered") {
    return { outcome: "unknown", reason: `herdr pane process-info: ${describe(answer)}` };
  }
  const info = field(answer.result, "process_info");
  const group = field(info, "foreground_process_group_id");
  const shell = field(info, "shell_pid");
  if (!isPid(group) || !isPid(shell)) {
    const said = JSON.stringify(answer.result);
    return { outcome: "unknown", reason: `herdr pane process-info named no group and shell: ${said}` };
  }
  return { outcome: "read", group, shell };
}

/**
 * `text` as one word to a POSIX shell, zsh or fish.
 *
 * Inside single quotes all three take every character literally but the quote,
 * which closes the quotes, is written escaped, and opens them again.
 */
function quoted(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

type Answer =
  | { readonly outcome: "answered"; readonly result: unknown }
  | { readonly outcome: "refused"; readonly code: string; readonly message: string }
  | { readonly outcome: "absent"; readonly reason: string }
  | { readonly outcome: "unknown"; readonly reason: string };

/**
 * Run `herdr` with `args`, and read its answer.
 *
 * - **Answered**: it exited 0 with a `result` and no `error`, or exited 0 and
 *   printed nothing at all, as `pane run` does.
 * - **Refused**: it exited non-zero with an `error` carrying a `code`, and no `result`.
 * - **Absent**: there is no `herdr` to run, so it did nothing.
 * - **Unknown**: anything else, which may have done anything.
 */
function herdr(args: readonly string[], environment: HerdrEnvironment, boundMs: number): Answer {
  const run = spawnSync("herdr", args, {
    encoding: "utf8",
    env: environment as NodeJS.ProcessEnv,
    // Never zero, which `spawnSync` reads as no bound at all.
    timeout: Math.max(1, boundMs),
  });

  if (run.error !== undefined) {
    const code = "code" in run.error ? run.error.code : undefined;
    if (code === "ETIMEDOUT") return { outcome: "unknown", reason: `herdr did not answer within ${boundMs}ms` };
    if (code === "ENOENT") return { outcome: "absent", reason: "there is no herdr on the path" };
    return { outcome: "unknown", reason: `herdr could not be run: ${run.error.message}` };
  }
  if (run.status === null) return { outcome: "unknown", reason: `herdr was killed by ${run.signal ?? "a signal"}` };

  // Herdr prints an answer on stdout and a refusal on stderr.
  const said = run.stdout.trim() === "" ? run.stderr.trim() : run.stdout.trim();
  if (run.status === 0 && said === "") return { outcome: "answered", result: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(said);
  } catch {
    const line = JSON.stringify(firstLine(said));
    return { outcome: "unknown", reason: `herdr exited ${run.status} and printed no JSON: ${line}` };
  }
  const result = field(parsed, "result");
  const error = field(parsed, "error");
  if (run.status === 0 && result !== undefined && error === undefined) return { outcome: "answered", result };
  const code = field(error, "code");
  if (run.status !== 0 && result === undefined && typeof code === "string") {
    const message = field(error, "message");
    return { outcome: "refused", code, message: typeof message === "string" ? message : "" };
  }
  return { outcome: "unknown", reason: `herdr exited ${run.status} with an answer it cannot be read by: ${said}` };
}

function describe(answer: Answer): string {
  switch (answer.outcome) {
    case "answered":
      return JSON.stringify(answer.result);
    case "refused":
      return `refused: ${answer.code}: ${answer.message}`;
    case "absent":
    case "unknown":
      return answer.reason;
  }
}

/** `value[name]` where `value` is a plain object, and nothing otherwise. */
function field(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[name];
}

function isPid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0] ?? "";
}
