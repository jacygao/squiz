/**
 * Findings about the change as a whole, held as threads made of the pull
 * request's conversation comments.
 *
 * A conversation comment has no thread and no resolve of its own, so squiz makes
 * both. The finding's comment ends with a trailer naming its id, `G1`, `G2`, …,
 * counted per pull request. Each reply ends with a trailer naming the id it
 * answers. Hiding the finding's comment as resolved is what resolves the thread,
 * as resolving a review thread is for one.
 *
 * A trailer is written by this module and read only by it: the listing hands
 * each body back with its trailer taken off, as it was handed over. A comment
 * whose last line is not a trailer belongs to no thread, which is every summary,
 * failure comment and comment a person wrote.
 *
 * A listing the deadline cut short, or one a page of which could not be read,
 * fails whole. A finding left out reads exactly as a finding that was fixed.
 */

import { callGraphql, callRest, saidBy, type GhCall, type GhFailure } from "./gh.ts";
import type { ReviewThread, ThreadComment } from "./threads.ts";
import type { ThreadAction } from "./thread-actions.ts";

/** How a general thread's id is spelled, and the only spelling read as one. */
const GENERAL_ID = /^G[1-9][0-9]*$/u;

/**
 * The separator and the trailer that end a comment squiz posted, and what the
 * trailer says about it. The separator is the blank line squiz wrote, or one a
 * person's edit saved with CRLF endings.
 */
const TRAILER = /\r?\n\r?\n[^\n]*<!-- squiz:(thread|reply) (G[1-9][0-9]*) -->\s*$/u;

const PAGE_SIZE = 100;

const commentsQuery = `query($node:ID!, $cursor:String) {
  node(id:$node) {
    ... on PullRequest {
      comments(first:${PAGE_SIZE}, after:$cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id databaseId author { login } body createdAt isMinimized }
      }
    }
  }
}`;

const hiding = {
  query: `mutation($comment: ID!) {
  minimizeComment(input: { subjectId: $comment, classifier: RESOLVED }) { minimizedComment { isMinimized } }
}`,
  field: "minimizeComment",
  result: "minimizedComment",
  leaves: true,
} as const;

const showing = {
  query: `mutation($comment: ID!) {
  unminimizeComment(input: { subjectId: $comment }) { unminimizedComment { isMinimized } }
}`,
  field: "unminimizeComment",
  result: "unminimizedComment",
  leaves: false,
} as const;

/** Whether `id` names a general thread rather than a review thread. */
export function isGeneralId(id: string): boolean {
  return GENERAL_ID.test(id);
}

export type GeneralListing =
  | { readonly outcome: "listed"; readonly threads: readonly ReviewThread[] }
  | { readonly outcome: "unreadable"; readonly reason: string }
  | GhFailure;

/**
 * Every general thread on the pull request `pullRequestId` names, in the order
 * their findings were posted, each with its replies in order.
 *
 * A reply whose id no finding holds is left out, as a comment on no thread.
 * Where two findings name one id, the first holds it.
 */
export function listGeneralThreads(pullRequestId: string, call: GhCall): GeneralListing {
  const comments: ListedComment[] = [];
  let cursor: string | null = null;
  for (;;) {
    const answer = callGraphql({ query: commentsQuery, variables: { node: pullRequestId, cursor } }, call);
    if (answer.outcome !== "answered") return answer;
    const page = readPage(answer.body, pullRequestId);
    if (page.outcome !== "read") return page;
    comments.push(...page.comments);
    if (page.next === null) break;
    // A cursor that comes back unchanged would be followed forever.
    if (page.next === cursor) return unreadable("GitHub answered with a comment cursor that does not advance");
    cursor = page.next;
  }

  const threads = new Map<string, { isResolved: boolean; comments: ThreadComment[] }>();
  for (const listed of comments) {
    const trailer = trailerOf(listed.comment.body);
    if (trailer === null) continue;
    const comment = { ...listed.comment, body: trailer.body };
    const thread = threads.get(trailer.id);
    if (trailer.kind === "thread") {
      if (thread === undefined) threads.set(trailer.id, { isResolved: listed.isMinimized, comments: [comment] });
      continue;
    }
    thread?.comments.push(comment);
  }
  return {
    outcome: "listed",
    threads: [...threads].map(([id, thread]) => ({
      id,
      isResolved: thread.isResolved,
      isOutdated: false,
      path: "",
      anchor: { at: "change" },
      comments: thread.comments,
    })),
  };
}

export type GeneralPosting =
  | { readonly outcome: "posted"; readonly threadId: string; readonly commentId: string; readonly url: string }
  | { readonly outcome: "failed"; readonly reason: string };

/**
 * Post `body` as a conversation comment on pull request `number`, as the
 * general thread after every one already on it.
 *
 * The id is chosen before the comment is posted, from the listing, so it never
 * has to be read back.
 */
export function postGeneralThread(number: number, pullRequestId: string, body: string, call: GhCall): GeneralPosting {
  const listed = listGeneralThreads(pullRequestId, call);
  if (listed.outcome !== "listed") return failed(listed.reason);
  const highest = listed.threads.reduce((most, thread) => Math.max(most, Number(thread.id.slice(1))), 0);
  const id = `G${highest + 1}`;
  const posted = postComment(number, `${body}\n\n<sub>Squiz thread ${id}</sub> <!-- squiz:thread ${id} -->`, call, `the finding ${id}`);
  if (posted.outcome === "failed") return posted;
  const commentId = posted.body === undefined ? "" : String(fieldOf(posted.body, "id") ?? "");
  const url = fieldOf(posted.body, "html_url");
  return { outcome: "posted", threadId: id, commentId, url: typeof url === "string" ? url : "" };
}

/**
 * Reply on general thread `id` of pull request `number` with `body`, ending it
 * with a trailer that ties it to the thread and quotes the finding it answers.
 */
export function replyOnGeneralThread(number: number, pullRequestId: string, id: string, body: string, call: GhCall): ThreadAction {
  const thread = generalThread(number, pullRequestId, id, call);
  if ("reason" in thread) return thread;
  // The finding's first line is its marker and its headline, which is what a
  // person reading the reply needs to place it.
  const quoted = (thread.comments[0]?.body ?? "").split("\n", 1)[0]?.trim() ?? "";
  const trailer = `> In reply to ${id}${quoted === "" ? "" : `: ${quoted}`} <!-- squiz:reply ${id} -->`;
  const posted = postComment(number, `${body}\n\n${trailer}`, call, `the reply to ${id}`);
  return posted.outcome === "failed" ? posted : { outcome: "acted" };
}

/** Hide general thread `id`'s finding as resolved, or show it again. */
export function setGeneralResolved(number: number, pullRequestId: string, id: string, isResolved: boolean, call: GhCall): ThreadAction {
  const thread = generalThread(number, pullRequestId, id, call);
  if ("reason" in thread) return thread;
  const finding = thread.comments[0];
  if (finding === undefined) return failed(`thread ${id} carries no comment`);
  const mutation = isResolved ? hiding : showing;
  const answer = callGraphql({ query: mutation.query, variables: { comment: finding.id } }, call);
  if (answer.outcome !== "answered") return failed(answer.reason);
  // The state the mutation reports is the only evidence it did the work.
  const reported = fieldOf(fieldOf(fieldOf(fieldOf(answer.body, "data"), mutation.field), mutation.result), "isMinimized");
  if (reported !== mutation.leaves) {
    const what = isResolved ? "hidden as resolved" : "shown";
    return failed(`GitHub did not report ${id}'s comment ${what}: ${saidBy(JSON.stringify(answer.body) ?? "it said nothing")}`);
  }
  return { outcome: "acted" };
}

/** The general thread `id` names on the pull request, or why there is none. */
function generalThread(number: number, pullRequestId: string, id: string, call: GhCall): ReviewThread | { readonly outcome: "failed"; readonly reason: string } {
  const listed = listGeneralThreads(pullRequestId, call);
  if (listed.outcome !== "listed") return failed(listed.reason);
  return listed.threads.find((thread) => thread.id === id) ?? failed(`PR #${number} holds no thread ${JSON.stringify(id)}`);
}

type Posted = { readonly outcome: "posted"; readonly body: unknown } | { readonly outcome: "failed"; readonly reason: string };

function postComment(number: number, body: string, call: GhCall, named: string): Posted {
  const answer = callRest({ path: `repos/{owner}/{repo}/issues/${number}/comments`, method: "POST", body: { body } }, call);
  if (answer.outcome !== "answered") return failed(answer.reason);
  if (answer.httpStatus < 200 || answer.httpStatus >= 300) return failed(`gh answered HTTP ${answer.httpStatus} without posting ${named}`);
  return { outcome: "posted", body: answer.body };
}

/**
 * What a trailer says, and the body with the separator and the trailer taken
 * off: the body as it was handed over, its own whitespace kept.
 */
function trailerOf(body: string): { readonly kind: "thread" | "reply"; readonly id: string; readonly body: string } | null {
  const found = TRAILER.exec(body);
  if (found === null) return null;
  return { kind: found[1] === "thread" ? "thread" : "reply", id: found[2] ?? "", body: body.slice(0, found.index) };
}

type ListedComment = { readonly comment: ThreadComment; readonly isMinimized: boolean };

type Page =
  | { readonly outcome: "read"; readonly comments: readonly ListedComment[]; readonly next: string | null }
  | { readonly outcome: "unreadable"; readonly reason: string };

function readPage(body: unknown, pullRequestId: string): Page {
  const connection = fieldOf(fieldOf(fieldOf(body, "data"), "node"), "comments");
  const nodes = fieldOf(connection, "nodes");
  if (!Array.isArray(nodes)) return unreadable(`GitHub answered with no conversation comments for ${pullRequestId}: ${described(body)}`);
  const pageInfo = fieldOf(connection, "pageInfo");
  const hasNextPage = fieldOf(pageInfo, "hasNextPage");
  const endCursor = fieldOf(pageInfo, "endCursor");
  if (typeof hasNextPage !== "boolean" || (hasNextPage && (typeof endCursor !== "string" || endCursor === ""))) {
    return unreadable(`GitHub answered with conversation comments that do not say whether more follow: ${described(body)}`);
  }
  const comments: ListedComment[] = [];
  for (const node of nodes) {
    const id = fieldOf(node, "id");
    const text = fieldOf(node, "body");
    const createdAt = fieldOf(node, "createdAt");
    const isMinimized = fieldOf(node, "isMinimized");
    if (typeof id !== "string" || id === "" || typeof text !== "string" || typeof isMinimized !== "boolean") {
      return unreadable(`GitHub answered with what is not a conversation comment: ${described(node)}`);
    }
    if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) {
      return unreadable(`GitHub answered with a conversation comment that does not say when it was posted: ${described(node)}`);
    }
    const databaseId = fieldOf(node, "databaseId");
    const login = fieldOf(fieldOf(node, "author"), "login");
    comments.push({
      comment: {
        id,
        databaseId: typeof databaseId === "number" && Number.isInteger(databaseId) ? databaseId : null,
        author: typeof login === "string" && login !== "" ? login : null,
        body: text,
        createdAt,
      },
      isMinimized,
    });
  }
  return { outcome: "read", comments, next: hasNextPage ? (endCursor as string) : null };
}

function fieldOf(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Readonly<Record<string, unknown>>)[name];
}

function described(value: unknown): string {
  return saidBy(JSON.stringify(value) ?? String(value));
}

function unreadable(reason: string): { readonly outcome: "unreadable"; readonly reason: string } {
  return { outcome: "unreadable", reason };
}

function failed(reason: string): { readonly outcome: "failed"; readonly reason: string } {
  return { outcome: "failed", reason };
}
