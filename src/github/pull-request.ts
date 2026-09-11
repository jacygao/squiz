/**
 * The pull request whose head is a branch, and what a round needs to know about
 * it: its number, its refs, its head sha, its description and its diff.
 *
 * A `gh` that could not answer stays distinguishable from an answer of none all
 * the way out to the caller. An install that failed and read as a branch with no
 * pull request would look exactly like the harness working normally, every round
 * and forever.
 */

import { runGh, saidBy } from "./gh.ts";

/** The pull request a round reviews. */
export type PullRequest = {
  readonly number: number;
  /**
   * The id a GraphQL query names this pull request by, so that no query needs an
   * owner and a repository. `gh` fills `{owner}` and `{repo}` in inside a REST
   * path and nowhere else, and a second resolver for the pair is one that can
   * disagree with `gh` on a fork.
   *
   * It is the pull request's own, and begins `PR_`. A review thread's id is a
   * different space, beginning `PRRT_`, and neither of them is the number.
   */
  readonly nodeId: string;
  readonly baseRef: string;
  readonly headRef: string;
  /**
   * The commit an anchored comment is posted against.
   *
   * The head, never the base: GitHub refuses the base sha as a *path* error,
   * whose message says a file could not be resolved and never names the commit.
   * A caller that reached for the wrong sha would be told the anchor was wrong.
   */
  readonly headSha: string;
  readonly description: string;
};

/** Why there is no answer. One line, which is what the caller reports. */
type Failure = { readonly outcome: "failed"; readonly reason: string };

/** What asking `gh` established. */
export type PullRequestLookup =
  | ({ readonly outcome: "found" } & PullRequest)
  | { readonly outcome: "none" }
  | Failure;

/** The diff GitHub served for a pull request. */
export type DiffFetch = { readonly outcome: "fetched"; readonly diff: string } | Failure;

// One branch has one pull request, so one row is the whole answer.
const query = [
  "pr",
  "list",
  "--state",
  "open",
  "--json",
  "number,id,baseRefName,headRefName,headRefOid,body",
  "--limit",
  "1",
] as const;

/** What turns the answer from JSON describing a pull request into the diff itself. */
const diffHeader = "Accept: application/vnd.github.v3.diff";

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
 * Fetch the diff GitHub serves for pull request `number`, from `directory`.
 *
 * What arrives is byte for byte what `git diff` writes for the same range: a
 * path holding a space carries a trailing tab, and a path outside ASCII is
 * quoted one octal escape per byte. The anchor validator reads it as it stands.
 *
 * Never throws, and an empty answer is a failure rather than an empty diff: a
 * `gh` that succeeded and printed nothing establishes nothing.
 *
 * `api` rather than `pr diff`, which spends a GraphQL call to find a number the
 * caller is holding.
 */
export function fetchDiff(number: number, directory: string): DiffFetch {
  // `gh` fills `{owner}` and `{repo}` in from the remotes of the directory it
  // runs in, which is the same repository the lookup asked.
  const path = `repos/{owner}/{repo}/pulls/${number}`;
  const run = runGh(["api", path, "--header", diffHeader], { directory });
  if (run.outcome !== "ran") return failed(run.reason);
  if (run.stdout === "") return failed("gh answered with an empty diff");
  return { outcome: "fetched", diff: run.stdout };
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

  const row = rowOf(rows[0]);
  if (row === null) {
    return failed(`gh answered with a pull request that is not an object: ${saidBy(stdout)}`);
  }

  const number = numberOf(row["number"]);
  if (number === null) return incomplete("number", stdout);

  const nodeId = textOf(row["id"]);
  if (nodeId === null) return incomplete("node id", stdout);

  const baseRef = textOf(row["baseRefName"]);
  if (baseRef === null) return incomplete("base ref", stdout);

  const headRef = textOf(row["headRefName"]);
  if (headRef === null) return incomplete("head ref", stdout);

  const headSha = textOf(row["headRefOid"]);
  if (headSha === null) return incomplete("head sha", stdout);

  // An empty body is a pull request nobody described, which is an answer. Only
  // a body that is not a string is a row this cannot read.
  const description: unknown = row["body"];
  if (typeof description !== "string") return incomplete("description", stdout);

  return { outcome: "found", number, nodeId, baseRef, headRef, headSha, description };
}

/** A row read as its fields, or `null` where it is not an object at all. */
function rowOf(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Readonly<Record<string, unknown>>;
}

/** A field read as a positive whole number, or `null` where it is anything else. */
function numberOf(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

/** A field read as a non-empty string, or `null` where it is anything else. */
function textOf(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  return value;
}

function incomplete(what: string, stdout: string): Failure {
  return failed(`gh answered with a pull request that has no ${what}: ${saidBy(stdout)}`);
}

function failed(reason: string): Failure {
  return { outcome: "failed", reason };
}
