/**
 * Start a command in a tmux window a person can watch, and close that window.
 *
 * **Only the server `TMUX` names is ever asked.** Without it nothing runs tmux
 * at all, since tmux would fall back to the owner's default server.
 *
 * **tmux execs the command itself, from separate arguments after `--`.** No
 * shell parses or starts it, so every argument arrives as given and the pane's
 * pid is the command's own.
 *
 * Nothing here throws. Every answer is a value the caller reads.
 */

import { spawnSync } from "node:child_process";

import { identityOf, type ProcessIdentity } from "./process.ts";

/** A window, by the id tmux gave it. The name is the caller's, and need not be unique. */
export type TmuxWindow = { readonly id: string; readonly name: string };

export type WindowRequest = {
  readonly name: string;
  readonly directory: string;
  /** The program and its arguments, each of which reaches it exactly as given. */
  readonly argv: readonly string[];
  /**
   * Set in the command's environment, over the tmux server's own, which is all
   * the command otherwise has.
   */
  readonly variables?: Readonly<Record<string, string>>;
};

/**
 * - `opened`: the command started. It may already have exited, as one that
 *   fails at once does before its pid can be read.
 * - `refused`: no window opened, so the caller may run the command another way.
 * - `failed`: a window may be running the command, so running it again would
 *   run it twice. Where the window is known it is given, for the caller to close.
 */
export type WindowOpening =
  | { readonly outcome: "opened"; readonly window: TmuxWindow; readonly identity: ProcessIdentity }
  | { readonly outcome: "refused"; readonly reason: string }
  | { readonly outcome: "failed"; readonly reason: string; readonly window?: TmuxWindow };

export type WindowClosing =
  | { readonly outcome: "closed" }
  | { readonly outcome: "open" }
  | { readonly outcome: "unknown"; readonly reason: string };

export type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Start `request.argv` in a new window, in the background, of the session
 * `environment`'s `TMUX` names.
 *
 * `boundMs` bounds each program this runs.
 */
export function openWindow(request: WindowRequest, environment: Environment, boundMs: number): WindowOpening {
  if (!insideTmux(environment)) return { outcome: "refused", reason: "TMUX is not set" };
  if (request.argv.length === 0) return { outcome: "refused", reason: "there is no command to run" };

  const variables = Object.entries(request.variables ?? {}).flatMap(([name, value]) => ["-e", `${name}=${value}`]);
  // tmux hands a command of one word to its default shell. This `sh` reads no
  // startup file, and becomes the command with the same pid.
  const argv = request.argv.length === 1 ? ["/bin/sh", "-c", 'exec "$0"', ...request.argv] : request.argv;
  const ran = tmux(
    [
      "new-window",
      ...variables,
      "-d",
      "-P",
      "-F",
      "#{window_id}\t#{pane_pid}",
      "-n",
      request.name,
      "-c",
      request.directory,
      "--",
      ...argv.map(literally),
    ],
    environment,
    boundMs,
  );
  if (ran.outcome === "unrun") return { outcome: "refused", reason: ran.reason };
  // A tmux cut short may have opened the window before it stopped.
  if (ran.outcome === "unfinished") return { outcome: "failed", reason: ran.reason };
  if (ran.status !== 0) return { outcome: "refused", reason: `tmux exited ${ran.status}: ${ran.stderr}` };

  const printed = /^(@\d+)\t(\d+)$/u.exec(ran.stdout);
  if (printed === null) {
    return { outcome: "failed", reason: `tmux printed no window and pid: ${JSON.stringify(ran.stdout)}` };
  }
  const window: TmuxWindow = { id: printed[1] ?? "", name: request.name };
  const pid = Number(printed[2]);
  const read = identityOf(pid, boundMs);
  // A command that has exited ran, and what it left behind is the caller's to
  // read. Its window has closed with it, so the second it was found gone
  // stands in for its start, and names no process running now.
  if (read.outcome === "gone") {
    return { outcome: "opened", window, identity: { pid, startedAt: Math.floor(Date.now() / 1_000) } };
  }
  if (read.outcome === "unknown") return { outcome: "failed", reason: read.reason, window };
  return { outcome: "opened", window, identity: read.identity };
}

/**
 * Close `window`, and ask tmux afterwards whether it is still there.
 *
 * Closing sends the window's command one `SIGHUP` and nothing more, so a
 * command that ignores it runs on. A caller that needs it stopped signals it
 * before closing.
 *
 * `boundMs` bounds each program this runs.
 */
export function closeWindow(window: TmuxWindow, environment: Environment, boundMs: number): WindowClosing {
  if (!insideTmux(environment)) return { outcome: "unknown", reason: "TMUX is not set" };

  // Whatever this says, the listing below is what tells: a window whose command
  // has exited is already gone, and closing it is refused.
  const closing = tmux(["kill-window", "-t", window.id], environment, boundMs);
  if (closing.outcome !== "ran") return { outcome: "unknown", reason: closing.reason };

  const listing = tmux(["list-windows", "-a", "-F", "#{window_id}"], environment, boundMs);
  if (listing.outcome !== "ran") return { outcome: "unknown", reason: listing.reason };
  if (listing.status === 0) {
    return listing.stdout.split("\n").includes(window.id) ? { outcome: "open" } : { outcome: "closed" };
  }
  // The server exits with its last window, and every window went with it.
  if (/^no server running on /u.test(listing.stderr)) return { outcome: "closed" };
  return { outcome: "unknown", reason: `tmux exited ${listing.status}: ${listing.stderr}` };
}

/**
 * The pid of the command running in `window`, as tmux gives it now, or nothing
 * where tmux no longer has the window or could not say.
 *
 * Read while the window is open, the pid is the command's own, so it names no
 * process that took the pid over after the command exited.
 */
export function windowProcess(window: TmuxWindow, environment: Environment, boundMs: number): number | undefined {
  if (!insideTmux(environment)) return undefined;
  const ran = tmux(["display", "-p", "-t", window.id, "#{pane_pid}"], environment, boundMs);
  if (ran.outcome !== "ran" || ran.status !== 0 || !/^\d+$/u.test(ran.stdout)) return undefined;
  return Number(ran.stdout);
}

function insideTmux(environment: Environment): boolean {
  return (environment["TMUX"] ?? "") !== "";
}

/**
 * `argument` as tmux hands it on.
 *
 * tmux reads an argument ending in `;` as the end of a command, and takes one
 * backslash before that `;` away, whatever comes before it.
 */
function literally(argument: string): string {
  return argument.endsWith(";") ? `${argument.slice(0, -1)}\\;` : argument;
}

type Run =
  | { readonly outcome: "ran"; readonly status: number; readonly stdout: string; readonly stderr: string }
  /** tmux never started. */
  | { readonly outcome: "unrun"; readonly reason: string }
  /** tmux started and did not finish. */
  | { readonly outcome: "unfinished"; readonly reason: string };

function tmux(args: readonly string[], environment: Environment, boundMs: number): Run {
  const result = spawnSync("tmux", args, {
    encoding: "utf8",
    env: environment,
    // Never zero, which `spawnSync` reads as no bound at all.
    timeout: Math.max(1, boundMs),
  });
  if (result.error !== undefined) {
    if ("code" in result.error && result.error.code === "ETIMEDOUT") {
      return { outcome: "unfinished", reason: `tmux did not answer within ${boundMs}ms` };
    }
    return { outcome: "unrun", reason: `tmux could not be run: ${result.error.message}` };
  }
  if (result.status === null) {
    return { outcome: "unfinished", reason: `tmux was killed by ${result.signal ?? "a signal"} before it answered` };
  }
  return { outcome: "ran", status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}
