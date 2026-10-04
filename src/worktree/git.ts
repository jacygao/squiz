/**
 * One git command, bounded by a deadline, whose failure comes back as a reason
 * rather than a throw.
 */

import { spawnSync } from "node:child_process";

import type { Deadline } from "../reviewers/deadline.ts";

export type GitOutput =
  | { readonly ran: true; readonly stdout: string; readonly status: number }
  | { readonly ran: false; readonly reason: string };

export type GitOptions = {
  /** Git is not started once it has passed, and is killed when it passes. */
  readonly until?: Deadline | undefined;
  /**
   * The exit statuses that are answers rather than failures. One other than 0
   * is an answer only where git said nothing on stderr.
   */
  readonly answers?: readonly number[];
  /** The reason a call cut short by `until` gives. */
  readonly ranOut?: string;
};

/**
 * Run git with `args` in `directory`.
 *
 * Never throws. A git that could not be run, that ran out of time, or that
 * exited with a status that is not an answer comes back as `ran: false`, with
 * the reason as a single line.
 */
export function runGit(directory: string, args: readonly string[], options: GitOptions = {}): GitOutput {
  const { until, answers = [0], ranOut = RAN_OUT } = options;
  if (until?.passed() === true) return { ran: false, reason: ranOut };

  const result = spawnSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    // Node's default stops at a mebibyte and hands back what it got, so a list
    // of paths arrives as one that reads whole with files missing from the end.
    maxBuffer: Infinity,
    // A credential prompt would wait on a terminal nobody is watching until the
    // deadline killed it, and then read as a call that ran out of time.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    // A timeout of zero is no timeout at all, so a deadline with nothing left
    // still bounds the call.
    ...(until === undefined ? {} : { timeout: Math.max(1, until.remaining()) }),
  });

  if (result.error !== undefined) {
    if (timedOut(result.error)) return { ran: false, reason: ranOut };
    return { ran: false, reason: `git could not be run: ${result.error.message}` };
  }
  const answered =
    result.status === 0 ||
    (result.status !== null && answers.includes(result.status) && result.stderr.trim() === "");
  if (!answered || result.status === null) {
    const said = result.stderr.split("\n", 1)[0]?.trim() ?? "";
    const exit = describeExit(result.status, result.signal);
    return { ran: false, reason: said === "" ? `${exit} and said nothing` : `${exit}: ${said}` };
  }
  return { ran: true, stdout: result.stdout, status: result.status };
}

const RAN_OUT = "git ran out of the time it was given";

function timedOut(error: Error): boolean {
  return "code" in error && error.code === "ETIMEDOUT";
}

function describeExit(status: number | null, signal: NodeJS.Signals | null): string {
  return status === null ? `git was killed by ${signal ?? "a signal"}` : `git exited ${status}`;
}
