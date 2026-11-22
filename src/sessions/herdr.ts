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
 * **Herdr execs the pane's argv itself, with no shell, and that argv is a gate.**
 * The gate is a `/bin/sh` that writes its pid, waits for the gate to open, and
 * then becomes the command. The gate opens only once the leader has been read,
 * so a command that would exit at once is still running when it is read, and a
 * start that fails never lets the command run.
 *
 * Every call goes to the socket `HERDR_SOCKET_PATH` names, through a Node
 * process of its own, since the start is synchronous throughout. Herdr is
 * before 1.0. Each answer is read field by field, and one that cannot be read
 * is a failure, never a pane. Nothing here throws.
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { identityOf, type ProcessIdentity } from "./process.ts";

export type HerdrEnvironment = Readonly<Record<string, string | undefined>>;

export type HerdrOptions = {
  /** Its `HERDR_SOCKET_PATH` names the server. */
  readonly environment: HerdrEnvironment;
  /** Bounds each call to Herdr and each `ps`, since one cut short could not tell what it did. */
  readonly boundMs: number;
};

export type PaneCommand = {
  readonly directory: string;
  /** The tab's label, and the pane's. */
  readonly name: string;
  /** The executable, found on the path `variables` or the caller's environment gives. */
  readonly program: string;
  readonly arguments: readonly string[];
  /** How long the gate may take to start running once Herdr has opened the pane. */
  readonly startsWithinMs: number;
  /** The workspace the tab opens in. Absent, it opens in the focused one. */
  readonly workspace?: string;
  /** Set in the command's environment, over the Herdr server's own. */
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
  // A malformed id is a bug upstream.
  if (command.workspace !== undefined && !isHerdrWorkspace(command.workspace)) {
    return { outcome: "refused", reason: `${JSON.stringify(command.workspace)} is not a Herdr workspace id` };
  }
  // The pane's process has the server's PATH, which may lack a directory the
  // caller's has, so the program is found on the caller's.
  const path = command.variables?.["PATH"] ?? options.environment["PATH"] ?? "";
  const program = command.program.includes("/") ? command.program : onPath(command.program, path, command.directory);
  if (program === undefined) return { outcome: "refused", reason: `there is no ${command.program} on the path` };
  let gate: string;
  try {
    gate = mkdtempSync(join(tmpdir(), "squiz-gate-"));
  } catch (cause) {
    return { outcome: "refused", reason: `no gate could be made to hold the command back: ${String(cause)}` };
  }
  const started = startBehind(gate, { ...command, program }, options);
  // An opened gate is the command's to remove, on its way to running.
  if (started.outcome !== "started") rmSync(gate, { recursive: true, force: true });
  return started;
}

/** Close `pane`, and confirm with Herdr that it no longer has it. */
export function closeHerdrPane(pane: string, options: HerdrOptions): PaneClose {
  // What the close said is not trusted either way. Only asking for the pane afterwards confirms it.
  const close = herdr("pane.close", { pane_id: pane }, options);
  const after = herdr("pane.get", { pane_id: pane }, options);
  if (after.outcome === "refused" && after.code === "pane_not_found") return { outcome: "closed" };
  const closeSaid = close.outcome === "answered" ? "closed" : describe(close);
  const afterSaid = after.outcome === "answered" ? "Herdr still has the pane" : describe(after);
  return { outcome: "failed", reason: `pane.close: ${closeSaid}; then pane.get: ${afterSaid}` };
}

/**
 * The pane's argv: `/bin/sh -c GATE <gate> <polls> <program> <arguments…>`.
 *
 * It writes its pid to `<gate>/pid`, or `<gate>/absent` where the program is not
 * on its path. It then waits for `<gate>/go`, removes the gate, and becomes the program. It gives
 * up after `<polls>` waits without ever running the program, so a start that
 * failed and could not close its pane still runs nothing.
 */
const GATE = [
  'd=$0; n=$1; shift',
  'command -v "$1" >/dev/null 2>&1 || { : > "$d/absent"; exit 127; }',
  'echo $$ > "$d/pid.part" && mv "$d/pid.part" "$d/pid" || exit 125',
  'while [ ! -e "$d/go" ]; do n=$((n - 1)); [ "$n" -gt 0 ] || exit 125; sleep 0.05; done',
  'rm -f "$d/go" "$d/pid"; rmdir "$d" 2>/dev/null',
  'exec "$@"',
].join("; ");

const GATE_POLL_MS = 50;

// Longer than every step between the pid appearing and the gate opening, each
// of which is bounded once.
const GATE_HOLDS_BOUNDS = 4;

function startBehind(gate: string, command: PaneCommand, options: HerdrOptions): PaneStart {
  const polls = Math.ceil((GATE_HOLDS_BOUNDS * options.boundMs) / GATE_POLL_MS);
  const root = {
    type: "pane",
    command: ["/bin/sh", "-c", GATE, gate, String(polls), command.program, ...command.arguments],
    cwd: command.directory,
    env: command.variables ?? {},
    label: command.name,
  };
  const layout = { root, tab_label: command.name, focus: false };
  let created: Answer;
  if (command.workspace === undefined) {
    created = herdr("layout.apply", layout, options);
  } else {
    created = herdr("layout.apply", { ...layout, workspace_id: command.workspace }, options);
    if (created.outcome === "refused" && created.code === "workspace_not_found") {
      created = herdr("layout.apply", layout, options);
    }
  }
  if (created.outcome === "absent") return { outcome: "refused", reason: created.reason };
  if (created.outcome === "refused") {
    return { outcome: "refused", reason: `layout.apply refused: ${created.code}: ${created.message}` };
  }
  if (created.outcome === "unknown") return { outcome: "failed", reason: `layout.apply: ${created.reason}` };
  const pane = field(field(field(created.result, "layout"), "root"), "pane_id");
  if (typeof pane !== "string" || pane === "") {
    return { outcome: "failed", reason: `layout.apply named no pane: ${JSON.stringify(created.result)}` };
  }

  const pid = gatedPid(gate, command);
  if (pid.outcome !== "read") return abandon(pane, pid.reason, options);
  const leader = identityOf(pid.pid, options.boundMs);
  if (leader.outcome === "gone") return abandon(pane, `the command ${pid.pid} had gone before its gate opened`, options);
  if (leader.outcome === "unknown") return abandon(pane, leader.reason, options);
  // Herdr removes a pane once its process exits, and a pid is not reused while
  // its process lives. So a pane still led by the pid afterwards means the
  // identity read in between is the gate's, not a stranger's.
  const info = processInfo(pane, options);
  if (info.outcome !== "read") return abandon(pane, info.reason, options);
  if (info.shell !== pid.pid || info.group !== pid.pid) {
    const reason = `the pane's process is ${info.shell} in the foreground group ${info.group}, not the command's ${pid.pid}`;
    return abandon(pane, reason, options);
  }
  try {
    writeFileSync(join(gate, "go"), "");
  } catch (cause) {
    return abandon(pane, `the gate could not be opened: ${String(cause)}`, options);
  }
  return { outcome: "started", pane, leader: leader.identity };
}

/** The first executable file named `program` in a directory of `path`, as a shell would find it. */
function onPath(program: string, path: string, directory: string): string | undefined {
  for (const entry of path.split(":")) {
    const candidate = resolve(directory, entry, program);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here, so the next directory is looked in.
    }
  }
  return undefined;
}

/** Close a pane a start opened and could not finish, and say why the start failed. */
function abandon(pane: string, reason: string, options: HerdrOptions): PaneStart {
  const closed = closeHerdrPane(pane, options);
  if (closed.outcome === "closed") return { outcome: "failed", reason };
  return { outcome: "failed", reason: `${reason}; and ${closed.reason}`, paneLeftOpen: pane };
}

/** Block this thread for `ms`. The start is synchronous throughout, so there is nothing to yield to. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

type PidRead = { readonly outcome: "read"; readonly pid: number } | { readonly outcome: "unknown"; readonly reason: string };

/** The pid the gate wrote, once it has. */
function gatedPid(gate: string, command: PaneCommand): PidRead {
  const until = Date.now() + command.startsWithinMs;
  for (;;) {
    if (existsSync(join(gate, "absent"))) {
      return { outcome: "unknown", reason: `the pane found no ${command.program} on its path` };
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

type InfoRead =
  | { readonly outcome: "read"; readonly group: number; readonly shell: number }
  | { readonly outcome: "unknown"; readonly reason: string };

function processInfo(pane: string, options: HerdrOptions): InfoRead {
  const answer = herdr("pane.process_info", { pane_id: pane }, options);
  if (answer.outcome !== "answered") {
    return { outcome: "unknown", reason: `pane.process_info: ${describe(answer)}` };
  }
  const info = field(answer.result, "process_info");
  const group = field(info, "foreground_process_group_id");
  const shell = field(info, "shell_pid");
  if (!isPid(group) || !isPid(shell)) {
    const said = JSON.stringify(answer.result);
    return { outcome: "unknown", reason: `pane.process_info named no group and process: ${said}` };
  }
  return { outcome: "read", group, shell };
}

type Answer =
  | { readonly outcome: "answered"; readonly result: unknown }
  | { readonly outcome: "refused"; readonly code: string; readonly message: string }
  | { readonly outcome: "absent"; readonly reason: string }
  | { readonly outcome: "unknown"; readonly reason: string };

/**
 * Send one request on the socket, and print the first line that comes back.
 *
 * Exits 3 where it could not connect, so nothing was sent. Any other failure
 * may have come after the request reached Herdr.
 */
const CLIENT = `
const [socket, request] = process.argv.slice(1);
const connection = require("node:net").createConnection(socket);
let connected = false;
let answer = "";
connection.on("connect", () => { connected = true; connection.write(request + "\\n"); });
connection.on("data", (chunk) => {
  answer += chunk;
  const end = answer.indexOf("\\n");
  if (end === -1) return;
  process.stdout.write(answer.slice(0, end));
  connection.destroy();
});
connection.on("error", (error) => { process.stderr.write(String(error.code ?? error.message)); process.exitCode = connected ? 2 : 3; });
connection.on("close", () => { if (process.exitCode === undefined && answer.indexOf("\\n") === -1) process.exitCode = 2; });
`;

/**
 * Call `method` with `params` on the Herdr server, and read its answer.
 *
 * - **Answered**: a `result` and no `error`.
 * - **Refused**: an `error` carrying a `code`, and no `result`.
 * - **Absent**: there is no server to call, so it did nothing.
 * - **Unknown**: anything else, which may have done anything.
 */
function herdr(method: string, params: unknown, options: HerdrOptions): Answer {
  const socket = options.environment["HERDR_SOCKET_PATH"] ?? "";
  if (socket === "") return { outcome: "absent", reason: "HERDR_SOCKET_PATH is not set" };
  const request = JSON.stringify({ id: `squiz:${method}`, method, params });
  const run = spawnSync(process.execPath, ["-e", CLIENT, socket, request], {
    encoding: "utf8",
    env: {},
    // Never zero, which `spawnSync` reads as no bound at all.
    timeout: Math.max(1, options.boundMs),
  });
  if (run.error !== undefined) {
    const code = "code" in run.error ? run.error.code : undefined;
    if (code === "ETIMEDOUT") return { outcome: "unknown", reason: `Herdr did not answer within ${options.boundMs}ms` };
    return { outcome: "unknown", reason: `the call to Herdr could not be run: ${run.error.message}` };
  }
  if (run.status === 3) {
    return { outcome: "absent", reason: `no Herdr server answers at ${socket}: ${run.stderr.trim()}` };
  }
  if (run.status !== 0) {
    const said = run.status === null ? `was killed by ${run.signal ?? "a signal"}` : `failed: ${run.stderr.trim()}`;
    return { outcome: "unknown", reason: `the call to Herdr ${said}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    return { outcome: "unknown", reason: `Herdr answered with no JSON: ${JSON.stringify(run.stdout)}` };
  }
  const result = field(parsed, "result");
  const error = field(parsed, "error");
  if (result !== undefined && error === undefined) return { outcome: "answered", result };
  const code = field(error, "code");
  if (result === undefined && typeof code === "string") {
    const message = field(error, "message");
    return { outcome: "refused", code, message: typeof message === "string" ? message : "" };
  }
  return { outcome: "unknown", reason: `Herdr gave an answer it cannot be read by: ${run.stdout}` };
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
