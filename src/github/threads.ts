/**
 * The review threads on a pull request, read back with their comments and
 * whether each one is resolved. GraphQL is the only transport that carries the
 * resolved state and the thread's own identifier, so this reader does not go
 * through REST.
 *
 * A thread missed here is a thread the round believes is not there, and it
 * would post a second finding on a line that already has one. Both connections
 * are paged to the end for that reason, and an answer that cannot be read fails
 * the whole call rather than standing in for the threads it could not carry.
 */

import { callGraphql, saidBy, type GhCall, type GhFailure } from "./gh.ts";

/** One comment of a thread. The first is what opened it and the rest are replies. */
export type ThreadComment = {
  /** The REST id of this comment, which is not the thread's and resolves nothing. */
  readonly databaseId: number | null;
  // Null where the account that wrote it is gone.
  readonly author: string | null;
  readonly body: string;
};

export type ReviewThread = {
  /**
   * The `PRRT_` thread node id, which is the identifier every later operation
   * takes: reply, resolve and re-open. A comment's own node id and its REST id
   * are both refused by the resolve mutations, and refused inside an HTTP 200.
   */
  readonly id: string;
  readonly isResolved: boolean;
  readonly isOutdated: boolean;
  readonly path: string;
  /**
   * The line to report the thread on, which is the live one or, once the file
   * has changed under it, the line it was anchored to.
   *
   * Null is a thread anchored to no line at all, and never a thread whose line
   * moved.
   */
  readonly line: number | null;
  /** Every comment, in the order GitHub returns them, replies included. */
  readonly comments: readonly ThreadComment[];
};

/**
 * Every thread on the pull request, or why there is no answer.
 *
 * `unreadable` is an answer whose shape is not the one asked for. It is
 * separate from the boundary's `unparsable`, which is an answer that is not
 * JSON at all.
 */
export type ThreadListing =
  | { readonly outcome: "listed"; readonly threads: readonly ReviewThread[] }
  | { readonly outcome: "unreadable"; readonly reason: string }
  | GhFailure;

/** What GitHub serves in one page of either connection. */
const PAGE_SIZE = 100;

const commentFields = `nodes { databaseId author { login } body }`;

const pageFields = `pageInfo { hasNextPage endCursor }`;

const threadsQuery = `query($pullRequest:ID!, $cursor:String) {
  node(id:$pullRequest) {
    ... on PullRequest {
      reviewThreads(first:${PAGE_SIZE}, after:$cursor) {
        ${pageFields}
        nodes {
          id isResolved isOutdated path line originalLine
          comments(first:${PAGE_SIZE}) { ${pageFields} ${commentFields} }
        }
      }
    }
  }
}`;

/** The rest of one thread's comments, reached by the thread's own node id. */
const commentsQuery = `query($thread:ID!, $cursor:String) {
  node(id:$thread) {
    ... on PullRequestReviewThread {
      comments(first:${PAGE_SIZE}, after:$cursor) { ${pageFields} ${commentFields} }
    }
  }
}`;

/**
 * List every review thread on the pull request `pullRequestId` names, each with
 * its comments in order.
 *
 * `pullRequestId` is the pull request's `PR_` node id. The repository is not
 * named anywhere: the id carries it, so this reader cannot end up reading one
 * repository while the rest of the harness posts to another.
 *
 * Resolved threads are listed alongside open ones; deciding which to act on is
 * the caller's. Never throws: a `gh` that could not answer comes back as the
 * boundary's own failure, and an answer that is not a list of threads comes
 * back as `unreadable`.
 */
export function listReviewThreads(pullRequestId: string, call: GhCall): ThreadListing {
  const threads: ReviewThread[] = [];
  let cursor: string | null = null;

  for (;;) {
    const answer = callGraphql(
      { query: threadsQuery, variables: { pullRequest: pullRequestId, cursor } },
      call,
    );
    if (answer.outcome !== "answered") return answer;

    const page = readThreadsPage(answer.body, pullRequestId);
    if (page.outcome !== "read") return page;

    for (const partial of page.threads) {
      if (partial.commentsNext === null) {
        threads.push(partial.thread);
        continue;
      }
      const rest = readRemainingComments(partial.thread.id, partial.commentsNext, call);
      if (rest.outcome !== "read") return rest;
      threads.push({ ...partial.thread, comments: [...partial.thread.comments, ...rest.comments] });
    }

    if (page.next === null) return { outcome: "listed", threads };
    // A cursor that comes back unchanged would be followed forever, and a hook
    // that never returns is the one failure the harness cannot recover from.
    if (page.next === cursor) {
      return unreadable("GitHub answered with a review thread cursor that does not advance");
    }
    cursor = page.next;
  }
}

type Unreadable = { readonly outcome: "unreadable"; readonly reason: string };

/** A thread carrying the comments of its first page, and where the rest are. */
type PartialThread = {
  readonly thread: ReviewThread;
  readonly commentsNext: string | null;
};

type ThreadsPage =
  | {
      readonly outcome: "read";
      readonly threads: readonly PartialThread[];
      readonly next: string | null;
    }
  | Unreadable;

type CommentsPage =
  | {
      readonly outcome: "read";
      readonly comments: readonly ThreadComment[];
      readonly next: string | null;
    }
  | Unreadable;

type CommentsRead =
  | { readonly outcome: "read"; readonly comments: readonly ThreadComment[] }
  | Unreadable
  | GhFailure;

/** Follow one thread's comments from `from` to the end of the connection. */
function readRemainingComments(threadId: string, from: string, call: GhCall): CommentsRead {
  const comments: ThreadComment[] = [];
  let cursor = from;

  for (;;) {
    const answer = callGraphql(
      { query: commentsQuery, variables: { thread: threadId, cursor } },
      call,
    );
    if (answer.outcome !== "answered") return answer;

    const page = readCommentsPage(answer.body, threadId);
    if (page.outcome !== "read") return page;
    comments.push(...page.comments);

    if (page.next === null) return { outcome: "read", comments };
    if (page.next === cursor) {
      return unreadable(
        `GitHub answered with a comment cursor that does not advance on thread ${threadId}`,
      );
    }
    cursor = page.next;
  }
}

function readThreadsPage(body: unknown, pullRequestId: string): ThreadsPage {
  const node = fieldOf(fieldOf(body, "data"), "node");
  const connection = fieldOf(node, "reviewThreads");
  // An id naming something that is not a pull request answers with an empty
  // node and no error, which must not read as a pull request with no threads.
  if (connection === null || connection === undefined) {
    return unreadable(
      `GitHub answered with no pull request for ${pullRequestId}: ${describe(body)}`,
    );
  }

  const nodes = fieldOf(connection, "nodes");
  if (!Array.isArray(nodes)) {
    return unreadable(
      `GitHub answered with what is not a list of review threads: ${describe(body)}`,
    );
  }
  const page = nextCursorOf(fieldOf(connection, "pageInfo"));
  if (page === null) {
    return unreadable(
      `GitHub answered with review threads that do not say whether more follow: ${describe(body)}`,
    );
  }

  const threads: PartialThread[] = [];
  for (const node of nodes) {
    const thread = readThread(node);
    if (thread === null) {
      return unreadable(`GitHub answered with what is not a review thread: ${describe(node)}`);
    }
    threads.push(thread);
  }
  return { outcome: "read", threads, next: page.next };
}

function readCommentsPage(body: unknown, threadId: string): CommentsPage {
  const node = fieldOf(fieldOf(body, "data"), "node");
  if (node === null || node === undefined) {
    return unreadable(`GitHub answered with no thread ${threadId}: ${describe(body)}`);
  }

  const connection = fieldOf(node, "comments");
  const nodes = fieldOf(connection, "nodes");
  if (!Array.isArray(nodes)) {
    return unreadable(
      `GitHub answered with what is not a list of comments on ${threadId}: ${describe(body)}`,
    );
  }
  const page = nextCursorOf(fieldOf(connection, "pageInfo"));
  if (page === null) {
    return unreadable(
      `GitHub answered with comments on ${threadId} that do not say whether more follow: ` +
        describe(body),
    );
  }
  const comments = readComments(nodes);
  if (comments === null) {
    return unreadable(
      `GitHub answered with what is not a comment on thread ${threadId}: ${describe(body)}`,
    );
  }
  return { outcome: "read", comments, next: page.next };
}

/** One thread, or `null` where the node is missing something the harness acts on. */
function readThread(node: unknown): PartialThread | null {
  const id = stringOf(fieldOf(node, "id"));
  const isResolved = fieldOf(node, "isResolved");
  const isOutdated = fieldOf(node, "isOutdated");
  const path = stringOf(fieldOf(node, "path"));
  if (id === null || path === null) return null;
  if (typeof isResolved !== "boolean" || typeof isOutdated !== "boolean") return null;

  const connection = fieldOf(node, "comments");
  const nodes = fieldOf(connection, "nodes");
  if (!Array.isArray(nodes)) return null;
  const comments = readComments(nodes);
  if (comments === null) return null;
  const page = nextCursorOf(fieldOf(connection, "pageInfo"));
  if (page === null) return null;

  return {
    thread: { id, isResolved, isOutdated, path, line: lineOf(node), comments },
    commentsNext: page.next,
  };
}

function readComments(nodes: readonly unknown[]): readonly ThreadComment[] | null {
  const comments: ThreadComment[] = [];
  for (const node of nodes) {
    const body = fieldOf(node, "body");
    if (typeof body !== "string") return null;
    comments.push({
      databaseId: integerOf(fieldOf(node, "databaseId")),
      author: stringOf(fieldOf(fieldOf(node, "author"), "login")),
      body,
    });
  }
  return comments;
}

/**
 * The line a thread is reported on.
 *
 * `line` goes null the moment the anchored line is edited, and those are the
 * threads a person most wants to look at, so the line it was anchored to stands
 * in for it.
 */
function lineOf(node: unknown): number | null {
  return integerOf(fieldOf(node, "line")) ?? integerOf(fieldOf(node, "originalLine"));
}

/**
 * Where the next page starts, `next: null` on the last page.
 *
 * Null is a connection that did not say, which includes one claiming another
 * page without a cursor to reach it by.
 */
function nextCursorOf(pageInfo: unknown): { readonly next: string | null } | null {
  const hasNextPage = fieldOf(pageInfo, "hasNextPage");
  if (typeof hasNextPage !== "boolean") return null;
  if (!hasNextPage) return { next: null };
  const endCursor = stringOf(fieldOf(pageInfo, "endCursor"));
  return endCursor === null ? null : { next: endCursor };
}

/** The field `name` holds, `undefined` for anything that is not an object. */
function fieldOf(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Readonly<Record<string, unknown>>)[name];
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function integerOf(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/** One bounded line of what arrived, for a failure that has to name it. */
function describe(value: unknown): string {
  return saidBy(JSON.stringify(value) ?? String(value));
}

function unreadable(reason: string): Unreadable {
  return { outcome: "unreadable", reason };
}
