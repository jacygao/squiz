/**
 * One git command, bounded by a deadline, whose failure comes back as a reason
 * rather than a throw.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

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
  /** The environment git runs with, in place of this process's own. */
  readonly env?: NodeJS.ProcessEnv;
};

/**
 * Run git with `args` in `directory`.
 *
 * Never throws. A git that could not be run, that ran out of time, or that
 * exited with a status that is not an answer comes back as `ran: false`, with
 * the reason as a single line.
 */
export function runGit(directory: string, args: readonly string[], options: GitOptions = {}): GitOutput {
  const { until, answers = [0], ranOut = RAN_OUT, env = process.env } = options;
  if (until?.passed() === true) return { ran: false, reason: ranOut };

  const result = spawnSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    // Node's default stops at a mebibyte and hands back what it got, so a list
    // of paths arrives as one that reads whole with files missing from the end.
    maxBuffer: Infinity,
    // A credential prompt would wait on a terminal nobody is watching until the
    // deadline killed it, and then read as a call that ran out of time.
    env: { ...env, GIT_TERMINAL_PROMPT: "0" },
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

/**
 * Whether git refused the command line as a usage error, exit 129, as a git too
 * old for one of its options does. The setup check's own runner words a failure
 * as runGit does, so this reads either.
 */
export function refusedAsUsage(output: GitOutput): boolean {
  return !output.ran && /^git exited 129\b/u.test(output.reason);
}

/**
 * Fetch `commits` from `origin` into the repository of `directory`, writing no
 * ref, and leaving `FETCH_HEAD` as it was, since the coding agent shares it.
 *
 * Git before 2.29 has no `--no-write-fetch-head`, and refuses it as a usage
 * error, exit 129. It is then asked to fetch without it, and `FETCH_HEAD` is put
 * back as it was, or removed where there was none, and a `FETCH_HEAD` that
 * cannot be is the call's failure. A fetch of the coding agent's that ends in
 * that window loses its `FETCH_HEAD`.
 */
export function fetchCommits(directory: string, commits: readonly string[], until: Deadline): GitOutput {
  const unwritten = runGit(directory, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin", ...commits], { until });
  if (!refusedAsUsage(unwritten)) return unwritten;

  const located = runGit(directory, ["rev-parse", "--git-path", "FETCH_HEAD"], { until });
  if (!located.ran) return located;
  const fetchHead = resolve(directory, located.stdout.trim());
  const before = contentOf(fetchHead);
  if (!before.read) return { ran: false, reason: `${fetchHead} could not be read: ${before.reason}` };
  const fetched = runGit(directory, ["fetch", "--quiet", "--no-tags", "origin", ...commits], { until });
  try {
    if (before.content === undefined) rmSync(fetchHead, { force: true });
    else writeFileSync(fetchHead, before.content);
  } catch (cause) {
    const unrestored = `FETCH_HEAD at ${fetchHead} could not be put back after the fetch: ${cause instanceof Error ? cause.message : String(cause)}`;
    return { ran: false, reason: fetched.ran ? unrestored : `${fetched.reason}, and ${unrestored}` };
  }
  return fetched;
}

type Content =
  | { readonly read: true; readonly content: Buffer | undefined }
  | { readonly read: false; readonly reason: string };

/** What the file at `path` holds, with `undefined` where there is none. */
function contentOf(path: string): Content {
  try {
    return { read: true, content: readFileSync(path) };
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return { read: true, content: undefined };
    return { read: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
}

const RAN_OUT = "git ran out of the time it was given";

function timedOut(error: Error): boolean {
  return "code" in error && error.code === "ETIMEDOUT";
}

function describeExit(status: number | null, signal: NodeJS.Signals | null): string {
  return status === null ? `git was killed by ${signal ?? "a signal"}` : `git exited ${status}`;
}

/**
 * `environment` less every `GIT_` variable, any of which could name another
 * repository, index or object directory than the worktree's own.
 */
export function withoutGitVariables(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    if (!key.startsWith("GIT_")) kept[key] = value;
  }
  return kept;
}
