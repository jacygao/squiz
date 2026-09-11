/**
 * The pull request whose head is a branch: the question the gate asks before a
 * round can start.
 *
 * Nothing outside `src/github/` invokes `gh`.
 *
 * A `gh` that could not answer stays distinguishable from an answer of none all
 * the way out to the caller. An install that failed and read as a branch with no
 * pull request would look exactly like the harness working normally, every round
 * and forever.
 */

import { spawnSync } from "node:child_process";

/** What asking `gh` established. `failed` carries the line the caller reports. */
export type PullRequestLookup =
  | { readonly outcome: "found"; readonly number: number }
  | { readonly outcome: "none" }
  | { readonly outcome: "failed"; readonly reason: string };

// One branch has one pull request, so one row is the whole answer.
const query = ["pr", "list", "--state", "open", "--json", "number", "--limit", "1"] as const;

// The failure pointer is a pointer rather than a report, so `gh`'s own words
// reach it as one bounded line.
const REASON_LIMIT = 200;

/**
 * Ask `gh` for the open pull request whose head is `branch`, from `directory`.
 *
 * `directory` decides which repository is asked: `gh` reads the remotes of the
 * working directory it runs in.
 *
 * Never throws. A `gh` that is missing, unauthenticated, rate-limited or
 * unreadable comes back as `failed`, carrying the reason as a single line.
 */
export function findPullRequestForBranch(branch: string, directory: string): PullRequestLookup {
  // The arguments go as an array, so no shell parses them. A branch name is
  // attacker-influenced, and git admits `$( )`, backticks and `;` into one.
  const result = spawnSync("gh", [...query, "--head", branch], {
    cwd: directory,
    encoding: "utf8",
  });

  if (result.error !== undefined) {
    return failed(`gh could not be run: ${result.error.message}`);
  }

  // The exit status is read before the output, because a `gh` that failed
  // writes nothing to stdout and an empty stdout parses as no pull request.
  if (result.status !== 0) {
    return failed(`${describeExit(result.status, result.signal)}: ${saidBy(result.stderr)}`);
  }

  return read(result.stdout);
}

function read(stdout: string): PullRequestLookup {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return failed(`gh answered with what is not JSON: ${saidBy(stdout)}`);
  }

  if (!Array.isArray(parsed)) {
    return failed(`gh answered with what is not a list: ${saidBy(stdout)}`);
  }

  const rows: readonly unknown[] = parsed;
  if (rows.length === 0) return { outcome: "none" };

  const number = numberOf(rows[0]);
  if (number === null) {
    return failed(`gh answered with a pull request that has no number: ${saidBy(stdout)}`);
  }
  return { outcome: "found", number };
}

/** The `number` field, or `null` where the row does not carry a usable one. */
function numberOf(row: unknown): number | null {
  if (typeof row !== "object" || row === null || !("number" in row)) return null;
  const value: unknown = row.number;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

function failed(reason: string): PullRequestLookup {
  return { outcome: "failed", reason };
}

function describeExit(status: number | null, signal: NodeJS.Signals | null): string {
  return status === null ? `gh was killed by ${signal ?? "a signal"}` : `gh exited ${status}`;
}

/** The first thing a stream said, bounded to what a pointer can carry. */
function saidBy(output: string): string {
  const line = output.split("\n").find((candidate) => candidate.trim() !== "")?.trim();
  if (line === undefined || line === "") return "it said nothing";
  return line.length > REASON_LIMIT ? `${line.slice(0, REASON_LIMIT - 3)}...` : line;
}
