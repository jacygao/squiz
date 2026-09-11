/**
 * Acting on a review thread that already exists: replying inside it, resolving
 * it, and re-opening it.
 *
 * All three take the GraphQL `PRRT_` thread node id and nothing else that
 * identifies the thread. The REST comment id and a comment's own `PRRC_` node
 * id are both refused by the resolve mutations, and refused inside an HTTP 200
 * whose failure is in the GraphQL `errors` array.
 *
 * Nothing here consults `viewerCanResolve`. It reads false on a thread that is
 * already resolved and the mutation succeeds anyway, so gating on it would
 * refuse work that would have worked.
 */

import { callGraphql, saidBy, type GhCall } from "./gh.ts";

/** What the call did to the thread, or why it did nothing. */
export type ThreadAction =
  | { readonly outcome: "acted" }
  | { readonly outcome: "failed"; readonly reason: string };

const replyMutation = `mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(
    input: { pullRequestReviewThreadId: $threadId, body: $body }
  ) { comment { databaseId } }
}`;

/** A mutation that sets a thread's resolution, and the state it sets it to. */
type Resolution = {
  readonly query: string;
  readonly field: string;
  readonly leaves: "resolved" | "open";
};

const resolving: Resolution = {
  query: `mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } }
}`,
  field: "resolveReviewThread",
  leaves: "resolved",
};

const reopening: Resolution = {
  query: `mutation($threadId: ID!) {
  unresolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } }
}`,
  field: "unresolveReviewThread",
  leaves: "open",
};

/**
 * Reply inside the thread `threadId` names, from `call.directory`.
 *
 * The reply publishes immediately, needs no review submitted after it, and
 * leaves the pull request's thread count unchanged.
 *
 * Never throws. A `gh` that is missing, unauthenticated or refused comes back
 * as `failed`, carrying the reason as a single line.
 */
export function replyInThread(threadId: string, body: string, call: GhCall): ThreadAction {
  const answer = callGraphql({ query: replyMutation, variables: { threadId, body } }, call);
  if (answer.outcome !== "answered") return { outcome: "failed", reason: answer.reason };
  // The mutation answered, so the reply is published, and nothing in the
  // response is read. A reply reported as failed is retried, and a retried
  // reply is a second comment saying the same thing.
  return { outcome: "acted" };
}

/**
 * Mark the thread `threadId` names resolved, from `call.directory`.
 *
 * Resolving a thread that is already resolved succeeds, and that is relied on:
 * a verdict is applied to a thread that may already be in the state it asks
 * for, so the state is never read first.
 *
 * Never throws. Anything short of GitHub reporting the thread resolved comes
 * back as `failed`, carrying the reason as a single line.
 */
export function resolveThread(threadId: string, call: GhCall): ThreadAction {
  return setResolution(resolving, threadId, call);
}

/**
 * Re-open the thread `threadId` names, from `call.directory`.
 *
 * Re-opening a thread that is already open succeeds, and is relied on the same
 * way resolving one is.
 *
 * Never throws. Anything short of GitHub reporting the thread open comes back
 * as `failed`, carrying the reason as a single line.
 */
export function reopenThread(threadId: string, call: GhCall): ThreadAction {
  return setResolution(reopening, threadId, call);
}

/**
 * Run one resolution mutation and read back the state it reports.
 *
 * The reported state is the only evidence the work happened, so a mutation
 * that answered without it failed. A resolve read as a success would have the
 * round report a thread closed that is still open.
 */
function setResolution(mutation: Resolution, threadId: string, call: GhCall): ThreadAction {
  const answer = callGraphql({ query: mutation.query, variables: { threadId } }, call);
  if (answer.outcome !== "answered") return { outcome: "failed", reason: answer.reason };

  const reported = resolvedStateIn(answer.body, mutation.field);
  if (reported !== (mutation.leaves === "resolved")) {
    const said = saidBy(printed(answer.body));
    return {
      outcome: "failed",
      reason: `GitHub did not report the thread ${mutation.leaves}: ${said}`,
    };
  }
  return { outcome: "acted" };
}

/** The `isResolved` the mutation reported, or `null` where it reported none. */
function resolvedStateIn(body: unknown, field: string): boolean | null {
  const thread = fieldOf(fieldOf(fieldOf(body, "data"), field), "thread");
  const state = fieldOf(thread, "isResolved");
  return typeof state === "boolean" ? state : null;
}

/** The value at `name`, or `undefined` where there is no object carrying one. */
function fieldOf(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  const fields = value as Readonly<Record<string, unknown>>;
  return fields[name];
}

function printed(body: unknown): string {
  return JSON.stringify(body) ?? "it said nothing";
}
