/**
 * Opening a review comment thread on the line a finding names.
 *
 * The thread is created over REST. The GraphQL create leaves the comment in a
 * pending review that nobody but the authenticating account can see, while
 * returning a well-formed thread id that every later call accepts.
 *
 * Nothing here throws. A refused anchor is not a failure but a routing signal:
 * the finding goes in the summary comment instead.
 */

import { callGraphql, callRest, saidBy, type GhCall } from "./gh.ts";

/** The one line a thread hangs on, and the file that line is counted in. */
export type Anchor = {
  readonly path: string;
  readonly line: number;
  /**
   * `RIGHT` counts lines in the head file and `LEFT` in the base file.
   *
   * Stated rather than defaulted: one line number on the two sides is two
   * different threads, so the side is part of what a thread is.
   */
  readonly side: "LEFT" | "RIGHT";
};

/** The comment to post, and the thread it opens. */
export type ThreadRequest = {
  readonly pullRequest: number;
  /**
   * The pull request's current head sha.
   *
   * The base sha is refused, and refused as an error against `path`, so a stale
   * value arrives as an anchor GitHub would not place rather than as a failure.
   */
  readonly headSha: string;
  readonly anchor: Anchor;
  readonly body: string;
};

/**
 * What became of the comment.
 *
 * `anchor-refused` is the one outcome that is neither a success nor a failure.
 * GitHub would not place a comment on that line, and the caller reports the
 * finding in the summary instead.
 */
export type ThreadPosting =
  | {
      readonly outcome: "posted";
      /** The `PRRT_` node id, which is what a reply and a resolve are addressed to. */
      readonly threadId: string;
      readonly commentId: number;
      readonly url: string;
    }
  | {
      /**
       * The comment is on the pull request and its thread id is not known, so
       * no later round can rule on it. Posting it again would put up a second
       * copy, which is why this is not a failure.
       */
      readonly outcome: "posted-without-thread-id";
      readonly reason: string;
      readonly commentId: number;
      readonly url: string;
    }
  | { readonly outcome: "anchor-refused"; readonly reason: string }
  | { readonly outcome: "failed"; readonly reason: string };

type Refused = Extract<ThreadPosting, { outcome: "anchor-refused" }>;
type Failure = Extract<ThreadPosting, { outcome: "failed" }>;

/** A comment GitHub created, read out of the REST response. */
type Created = {
  readonly outcome: "created";
  readonly commentId: number;
  readonly nodeId: string;
  readonly url: string;
  readonly opensThread: boolean;
};

/**
 * Open a review comment thread on `anchor`, and hand back the thread's node id.
 *
 * Two calls: the REST create, then a read-back for the node id, which no REST
 * response carries.
 *
 * Never throws. A GitHub that refused the anchor, a GitHub that could not be
 * reached and a `gh` that is not installed all come back as outcomes.
 */
export function postThread(request: ThreadRequest, call: GhCall): ThreadPosting {
  const created = create(request, call);
  if (created.outcome !== "created") return created;

  // A comment sitting inside somebody else's thread reads as a finding posted
  // against the line, and it is not one: the line and the file in the response
  // are the ones that were asked for either way.
  if (!created.opensThread) {
    return failed("the comment joined an existing thread instead of opening one");
  }

  const found = findThread(created.nodeId, created.commentId, call);
  if (!found.found) {
    return {
      outcome: "posted-without-thread-id",
      reason: found.reason,
      commentId: created.commentId,
      url: created.url,
    };
  }
  return {
    outcome: "posted",
    threadId: found.threadId,
    commentId: created.commentId,
    url: created.url,
  };
}

function create(request: ThreadRequest, call: GhCall): Created | Refused | Failure {
  const answer = callRest(
    {
      path: `repos/{owner}/{repo}/pulls/${request.pullRequest}/comments`,
      method: "POST",
      body: {
        body: request.body,
        commit_id: request.headSha,
        path: request.anchor.path,
        line: request.anchor.line,
        side: request.anchor.side,
      },
    },
    call,
  );

  if (answer.outcome === "exited") {
    const refusal = refusedAnchorIn(answer.httpStatus, answer.body, request.anchor);
    if (refusal !== null) return { outcome: "anchor-refused", reason: refusal };
    return failed(answer.reason);
  }
  if (answer.outcome !== "answered") return failed(answer.reason);
  if (answer.httpStatus !== 201) {
    return failed(`GitHub answered HTTP ${answer.httpStatus} where it would have created one`);
  }

  const created = readCreated(answer.body);
  if (created === null) {
    return failed(`the comment was created and its response was unreadable: ${said(answer.body)}`);
  }
  return created;
}

/** The prefix GitHub refuses a review comment's own fields under. */
const REFUSAL_PREFIX = "pull_request_review_thread.";

/**
 * The fields that make up the anchor.
 *
 * The prefix alone does not mean the anchor: an empty comment body is refused
 * as `pull_request_review_thread.body`, and that is a malformed comment rather
 * than a line GitHub would not take.
 */
const ANCHOR_FIELDS: ReadonlySet<string> = new Set(["path", "line", "side"]);

/**
 * Why GitHub would not place the comment, in one line, or `null` where the
 * response describes a real failure.
 */
function refusedAnchorIn(httpStatus: number | null, body: unknown, anchor: Anchor): string | null {
  if (httpStatus !== 422) return null;
  for (const error of errorsIn(body)) {
    const field = at(error, "field");
    if (typeof field !== "string" || !field.startsWith(REFUSAL_PREFIX)) continue;
    const part = field.slice(REFUSAL_PREFIX.length);
    if (!ANCHOR_FIELDS.has(part)) continue;
    const message = at(error, "message");
    const detail = typeof message === "string" ? message : "was refused";
    return `GitHub would not anchor a comment to ${anchor.path}:${anchor.line}: ${part} ${detail}`;
  }
  return null;
}

/** The `errors` array of a REST validation failure, empty where there is none. */
function errorsIn(body: unknown): readonly unknown[] {
  const errors = at(body, "errors");
  return Array.isArray(errors) ? errors : [];
}

/** The created comment, or `null` where the response is not one this can use. */
function readCreated(body: unknown): Created | null {
  const commentId = at(body, "id");
  const nodeId = at(body, "node_id");
  const url = at(body, "html_url");
  if (typeof commentId !== "number" || !Number.isInteger(commentId)) return null;
  if (typeof nodeId !== "string" || nodeId === "") return null;
  if (typeof url !== "string" || url === "") return null;

  // A comment that opened a thread carries no `in_reply_to_id` at all, and one
  // that joined a thread carries the comment it answered. Nothing else in the
  // two responses differs, so a reader that takes the field's value rather than
  // its presence reads every new thread as unreadable.
  const parent = at(body, "in_reply_to_id");
  const opensThread = parent === undefined || parent === null;
  return { outcome: "created", commentId, nodeId, url, opensThread };
}

/**
 * How many pages of threads the read-back walks.
 *
 * The walk ends when GitHub says there is no next page. This is what stops a
 * page that always claims one from spending the round's remaining time.
 */
const THREAD_PAGE_LIMIT = 20;

const THREAD_QUERY = `
query($comment: ID!, $cursor: String) {
  node(id: $comment) {
    ... on PullRequestReviewComment {
      pullRequest {
        reviewThreads(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { id comments(first: 1) { nodes { databaseId } } }
        }
      }
    }
  }
}`;

type ThreadLookup =
  | { readonly found: true; readonly threadId: string }
  | { readonly found: false; readonly reason: string };

/**
 * The node id of the thread `commentId` opened.
 *
 * Reached from the comment's own node id, so no owner, repository or pull
 * request number is needed. Nothing maps a comment to its thread directly, so
 * the pull request's threads are listed and matched on the database id of the
 * comment each one opens.
 */
function findThread(commentNodeId: string, commentId: number, call: GhCall): ThreadLookup {
  let cursor: string | null = null;
  for (let page = 0; page < THREAD_PAGE_LIMIT; page += 1) {
    const answer = callGraphql(
      { query: THREAD_QUERY, variables: { comment: commentNodeId, cursor } },
      call,
    );
    if (answer.outcome !== "answered") return { found: false, reason: answer.reason };

    const listed = readThreads(answer.body);
    if (listed === null) {
      const reason = `GitHub listed threads that could not be read: ${said(answer.body)}`;
      return { found: false, reason };
    }
    const threadId = listed.threads.get(commentId);
    if (threadId !== undefined) return { found: true, threadId };
    if (listed.cursor === null) {
      return { found: false, reason: "GitHub listed no thread that this comment opened" };
    }
    cursor = listed.cursor;
  }
  return {
    found: false,
    reason: `the thread is past the ${THREAD_PAGE_LIMIT} pages of threads this reads`,
  };
}

type Threads = {
  /** Each thread's node id, under the database id of the comment that opened it. */
  readonly threads: ReadonlyMap<number, string>;
  /** Where the next page starts, or `null` where this was the last one. */
  readonly cursor: string | null;
};

/** One page of threads, or `null` where the response carries no page at all. */
function readThreads(body: unknown): Threads | null {
  const connection = at(body, "data", "node", "pullRequest", "reviewThreads");
  const nodes = at(connection, "nodes");
  if (!Array.isArray(nodes)) return null;

  const threads = new Map<number, string>();
  const listed: readonly unknown[] = nodes;
  for (const node of listed) {
    const threadId = at(node, "id");
    const comments = at(node, "comments", "nodes");
    const openers: readonly unknown[] = Array.isArray(comments) ? comments : [];
    const databaseId = at(openers[0], "databaseId");
    if (typeof threadId === "string" && typeof databaseId === "number") {
      threads.set(databaseId, threadId);
    }
  }

  const hasNext = at(connection, "pageInfo", "hasNextPage");
  const cursor = at(connection, "pageInfo", "endCursor");
  return { threads, cursor: hasNext === true && typeof cursor === "string" ? cursor : null };
}

/** The property at `names`, or `undefined` where the value has no such path. */
function at(value: unknown, ...names: readonly string[]): unknown {
  let current = value;
  for (const name of names) {
    if (typeof current !== "object" || current === null) return undefined;
    const record: Readonly<Record<string, unknown>> = current as Readonly<Record<string, unknown>>;
    current = record[name];
  }
  return current;
}

/** A parsed body as one bounded line, for a reason that has to quote it. */
function said(body: unknown): string {
  return saidBy(JSON.stringify(body) ?? String(body));
}

function failed(reason: string): Failure {
  return { outcome: "failed", reason };
}
