/**
 * Start a command in a Herdr pane a person can watch, and close the pane.
 *
 * Every start ends in one of three outcomes:
 *
 * - **Started**: the command runs in the pane, and its process group's leader
 *   is known.
 * - **Refused**: Herdr opened no pane, for certain, so the caller can start the
 *   command somewhere else without running it twice.
 * - **Failed**: anything else. A pane may have opened and the command may have
 *   run. A pane this module opened is closed before it says so, and named where
 *   the close could not be confirmed.
 *
 * **The leader is the pane's foreground group, read while the command runs.**
 * `shell_pid` is the pane's shell, whose group does not hold the command. Once
 * the command exits, the foreground group is the shell's again, so a group equal
 * to the shell's is never returned.
 *
 * Herdr is before 1.0. Each answer is read field by field, and one that cannot
 * be read is a failure, never a pane. Nothing here throws.
 */

import { spawnSync } from "node:child_process";

import { identityOf, type ProcessIdentity } from "./process.ts";

export type HerdrEnvironment = Readonly<Record<string, string | undefined>>;

export type HerdrOptions = {
  /** What every `herdr` runs with. Its `HERDR_SOCKET_PATH` names the server. */
  readonly environment: HerdrEnvironment;
  /** Bounds each `herdr` and `ps` this runs. One cut short could not tell what it did. */
  readonly boundMs: number;
};

export type PaneCommand = {
  readonly directory: string;
  /** The tab's label and the agent's name. Herdr refuses a name not matching `[a-z][a-z0-9_-]{0,31}`. */
  readonly name: string;
  /** The agent kind Herdr starts, which also names the executable it runs. */
  readonly kind: string;
  readonly arguments: readonly string[];
  /** How long Herdr waits for the command to be ready, on top of the bound. */
  readonly readyWithinMs: number;
  /** The workspace the tab opens in. Absent, it opens in the focused one. */
  readonly workspace?: string;
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
  const tab = ["tab", "create", "--cwd", command.directory, "--label", command.name, "--no-focus"];
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

  const agent = herdr(
    [
      "agent",
      "start",
      command.name,
      "--kind",
      command.kind,
      "--pane",
      pane,
      "--timeout",
      String(command.readyWithinMs),
      "--",
      ...command.arguments,
    ],
    options.environment,
    command.readyWithinMs + options.boundMs,
  );
  if (agent.outcome !== "answered") return abandon(pane, `herdr agent start: ${describe(agent)}`, options);
  if (field(agent.result, "type") !== "agent_started") {
    return abandon(pane, `herdr agent start did not say it started: ${JSON.stringify(agent.result)}`, options);
  }

  const group = foregroundGroup(pane, options);
  if (group.outcome !== "read") return abandon(pane, group.reason, options);
  const leader = identityOf(group.group, options.boundMs);
  if (leader.outcome === "gone") {
    return abandon(pane, `the foreground group's leader ${group.group} had gone when it was read`, options);
  }
  if (leader.outcome === "unknown") return abandon(pane, leader.reason, options);
  // A group id is not reused while the group has a member, so the same group
  // afterwards means the identity read in between is its leader's, not a stranger's.
  const again = foregroundGroup(pane, options);
  if (again.outcome !== "read") return abandon(pane, again.reason, options);
  if (again.group !== group.group) {
    const changed = `the pane's foreground group changed from ${group.group} to ${again.group} while it was read`;
    return abandon(pane, changed, options);
  }
  return { outcome: "started", pane, leader: leader.identity };
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

/** Close a pane a start opened and could not finish, and say why the start failed. */
function abandon(pane: string, reason: string, options: HerdrOptions): PaneStart {
  const closed = closeHerdrPane(pane, options);
  if (closed.outcome === "closed") return { outcome: "failed", reason };
  return { outcome: "failed", reason: `${reason}; and ${closed.reason}`, paneLeftOpen: pane };
}

type GroupRead =
  | { readonly outcome: "read"; readonly group: number }
  | { readonly outcome: "unknown"; readonly reason: string };

/** The pane's foreground process group, where it is not the shell's. */
function foregroundGroup(pane: string, options: HerdrOptions): GroupRead {
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
  if (group === shell) {
    const reason = `the pane's foreground group ${group} is its shell's, so the command was not running`;
    return { outcome: "unknown", reason };
  }
  return { outcome: "read", group };
}

type Answer =
  | { readonly outcome: "answered"; readonly result: unknown }
  | { readonly outcome: "refused"; readonly code: string; readonly message: string }
  | { readonly outcome: "absent"; readonly reason: string }
  | { readonly outcome: "unknown"; readonly reason: string };

/**
 * Run `herdr` with `args`, and read its answer.
 *
 * - **Answered**: it exited 0 with a `result` and no `error`.
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
