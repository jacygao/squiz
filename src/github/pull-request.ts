/**
 * The pull request whose head is a branch: the question the gate asks before a
 * round can start.
 *
 * A `gh` that could not answer stays distinguishable from an answer of none all
 * the way out to the caller. An install that failed and read as a branch with no
 * pull request would look exactly like the harness working normally, every round
 * and forever.
 */

import { runGh, saidBy } from "./gh.ts";

/** What asking `gh` established. `failed` carries the line the caller reports. */
export type PullRequestLookup =
  | { readonly outcome: "found"; readonly number: number }
  | { readonly outcome: "none" }
  | { readonly outcome: "failed"; readonly reason: string };

// One branch has one pull request, so one row is the whole answer.
const query = ["pr", "list", "--state", "open", "--json", "number", "--limit", "1"] as const;

/**
 * Ask `gh` for the open pull request whose head is `branch`, from `directory`.
 *
 * `directory` decides which repository is asked: `gh` reads the remotes of the
 * working directory it runs in.
 *
 * Never throws. A `gh` that is missing, unauthenticated, rate-limited or
 * unreadable comes back as `failed`, carrying the reason as a single line.
 *
 * `pr list` rather than `api`: one question about the current repository's
 * remotes, which `gh` resolves and the harness would otherwise have to.
 */
export function findPullRequestForBranch(branch: string, directory: string): PullRequestLookup {
  const run = runGh([...query, "--head", branch], { directory });
  if (run.outcome !== "ran") return failed(run.reason);
  return read(run.stdout);
}

/**
 * The rows `gh` printed, read as the answer.
 *
 * An empty stdout is a failure rather than an answer of none. A `gh` that
 * succeeded and said nothing establishes nothing.
 */
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

