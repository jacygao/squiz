/**
 * The pull request whose head is a branch, and what a round needs to know about
 * it: its number, its refs, its head and base shas, and its description. The
 * lookup also says whether it is a draft, which a trigger reads and a round
 * does not.
 *
 * A `gh` that could not answer stays distinguishable from an answer of none all
 * the way out to the caller, the time left for GitHub running out included. An
 * install that failed and read as a branch with no pull request would look
 * exactly like the harness working normally, every round and forever.
 */

import { callRest, runGh, saidBy, type GhCall } from "./gh.ts";

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
  /** The commit the base ref names, which the change is diffed against. */
  readonly baseSha: string;
  readonly description: string;
};

/** Why there is no answer. One line, which is what the caller reports. */
type Failure = { readonly outcome: "failed"; readonly reason: string };

/** What asking `gh` established. */
export type PullRequestLookup =
  | ({ readonly outcome: "found"; readonly draft: boolean } & PullRequest)
  | { readonly outcome: "none" }
  | Failure;

/** The `PR_` node id GitHub gave for a pull request's number. */
export type NodeIdLookup = { readonly outcome: "found"; readonly nodeId: string } | Failure;

// One branch has one pull request, so one row is the whole answer.
const query = [
  "pr",
  "list",
  "--state",
  "open",
  "--json",
  "number,id,baseRefName,headRefName,headRefOid,baseRefOid,body,isDraft",
  "--limit",
  "1",
] as const;

/**
 * Ask `gh` for the open pull request whose head is `branch`.
 *
 * `call.directory` decides which repository is asked: `gh` reads the remotes of
 * the working directory it runs in. `call` also carries the bound, so a caller
 * that has a phase to finish inside can give this its share of one.
 *
 * Never throws. A `gh` that is missing, unauthenticated, rate-limited or
 * unreadable comes back as `failed`, carrying the reason as a single line. So
 * does a call the deadline left no time for: `none` is GitHub saying there is no
 * pull request and nothing else, because a round reads `none` as nothing to
 * review and posts nothing at all.
 *
 * `pr list` rather than `api`: one question about the current repository's
 * remotes, which `gh` resolves and the harness would otherwise have to.
 */
export function findPullRequestForBranch(branch: string, call: GhCall): PullRequestLookup {
  const run = runGh([...query, "--head", branch], call);
  if (run.outcome !== "ran") return failed(run.reason);
  return read(run.stdout);
}

/**
 * Ask GitHub for the node id of pull request `number`, for a caller that holds
 * only the number. Never throws.
 */
export function findPullRequestNodeId(number: number, call: GhCall): NodeIdLookup {
  const answer = callRest({ path: `repos/{owner}/{repo}/pulls/${number}` }, call);
  if (answer.outcome !== "answered") return failed(answer.reason);
  const nodeId = textOf(rowOf(answer.body)?.["node_id"]);
  if (nodeId === null) return failed(`GitHub answered for PR #${number} with no node id`);
  return { outcome: "found", nodeId };
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

  const baseSha = textOf(row["baseRefOid"]);
  if (baseSha === null) return incomplete("base sha", stdout);

  // An empty body is a pull request nobody described, which is an answer. Only
  // a body that is not a string is a row this cannot read.
  const description: unknown = row["body"];
  if (typeof description !== "string") return incomplete("description", stdout);

  const draft: unknown = row["isDraft"];
  if (typeof draft !== "boolean") return incomplete("draft flag", stdout);

  return { outcome: "found", number, nodeId, baseRef, headRef, headSha, baseSha, description, draft };
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
