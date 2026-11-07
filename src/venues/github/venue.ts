/**
 * The GitHub venue: the change is an open pull request at its head commit, and
 * the record is the review threads and comments on it.
 *
 * It is the only venue that runs `gh`. A change it reads carries the worktree
 * it was read in and the pull request's node id beside the contract's fields.
 * A change it did not read is taken to be the pull request its key numbers, in
 * the worktree this process runs in.
 */

import { join } from "node:path";

import { currentBranch } from "../../hook/branch.ts";
import type { Deadline } from "../../reviewers/deadline.ts";
import { runGit } from "../../worktree/git.ts";
import type { Change, ChangeLookup, Failed, ThreadPosting, Venue } from "../venue.ts";
import { postFileThread, postThread, type ThreadPosting as GitHubThreadPosting } from "./post-thread.ts";
import { findPullRequestForBranch, findPullRequestNodeId, type PullRequest } from "./pull-request.ts";
import { postIssueComment, postSummary } from "./summary.ts";
import { reopenThread, replyInThread, resolveThread } from "./thread-actions.ts";
import { listReviewThreads } from "./threads.ts";

/** A change this venue read, with what it read it from. */
type PullRequestChange = Change & {
  readonly worktree: string;
  /** The `PR_` node id the threads are listed by. */
  readonly nodeId: string;
};

// How a pull request number is spelled as a key, and the only spelling read as one.
const NUMBER_KEY = /^[1-9][0-9]*$/u;

// Every process that names an episode keeps it here, so all of them find it.
const EPISODES = ".squiz";

// A full object name, SHA-1 or SHA-256. Anything else may name a branch that
// moves, or reach git as an option.
const FULL_COMMIT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/** The paragraph after the open threads, for pull request `number`. */
export function followUpFor(number: number): string {
  return [
    "Fix what applies, and reply on each thread with `squiz reply <id> <text>` to say",
    "what you changed or why you disagree. Commit and push what you changed, then run",
    `\`squiz review ${number}\` again.`,
  ].join("\n");
}

/** The one line `squiz review` prints for a draft. */
export function draftLine(number: number): string {
  return `PR #${number} is a draft. Squiz reviews it once it is marked ready for review, so there is nothing to wait for.`;
}

export const githubVenue: Venue = {
  // The pull request names its own base.
  recordStart: () => ({ outcome: "done" }),
  readChange,
  episodeDirectory(worktree, key) {
    const number = numberIn(key);
    if (typeof number !== "number") return number;
    return { outcome: "found", directory: join(worktree, EPISODES, key) };
  },
  provideCommits,
  listThreads(change, until) {
    const number = numberIn(change.key);
    if (typeof number !== "number") return number;
    const call = { directory: worktreeOf(change), until };
    let nodeId = "nodeId" in change && typeof change.nodeId === "string" ? change.nodeId : null;
    if (nodeId === null) {
      const found = findPullRequestNodeId(number, call);
      if (found.outcome !== "found") return found;
      nodeId = found.nodeId;
    }
    const listed = listReviewThreads(nodeId, call);
    if (listed.outcome !== "listed") return failed(listed.reason);
    return listed;
  },
  openThread(change, anchor, body, until) {
    const number = numberIn(change.key);
    if (typeof number !== "number") return number;
    return posting(
      postThread({ pullRequest: number, headSha: change.head, body, anchor }, { directory: worktreeOf(change), until }),
    );
  },
  openFileThread(change, path, body, until) {
    const number = numberIn(change.key);
    if (typeof number !== "number") return number;
    return posting(
      postFileThread({ pullRequest: number, headSha: change.head, body, path }, { directory: worktreeOf(change), until }),
    );
  },
  // A thread's node id names its repository, so these run wherever squiz does.
  reply: (threadId, body, until) => replyInThread(threadId, body, { directory: process.cwd(), until }),
  resolve: (threadId, until) => resolveThread(threadId, { directory: process.cwd(), until }),
  reopen: (threadId, until) => reopenThread(threadId, { directory: process.cwd(), until }),
  postSummary(change, body, until) {
    const number = numberIn(change.key);
    if (typeof number !== "number") return number;
    return postSummary(number, body, { directory: worktreeOf(change), until });
  },
  postFailure(change, body, until) {
    const number = numberIn(change.key);
    if (typeof number !== "number") return number;
    return postIssueComment(number, body, { directory: worktreeOf(change), until }, "the failure");
  },
};

/**
 * The open pull request whose head is the branch `worktree` has checked out,
 * and the one `asked` names where a key was given.
 */
function readChange(worktree: string, asked: string | null, until: Deadline): ChangeLookup {
  if (asked !== null) {
    const number = numberIn(asked);
    if (typeof number !== "number") return none(number.reason);
  }
  const where = JSON.stringify(worktree);
  const branch = currentBranch(worktree, until);
  if (branch.outcome === "failed") return failed(`the current branch could not be resolved: ${branch.reason}`);
  if (branch.outcome === "detached") {
    return none(`HEAD is detached in ${where}, so no pull request has it as its head`);
  }

  const named = JSON.stringify(branch.name);
  const found = findPullRequestForBranch(branch.name, { directory: worktree, until });
  if (found.outcome === "failed") return failed(`the pull request for ${named} could not be looked up: ${found.reason}`);
  if (found.outcome === "none") return none(`no open pull request has ${named} as its head, in ${where}`);
  if (asked !== null && String(found.number) !== asked) {
    return none(
      `PR #${asked} is not the open pull request whose head is ${named}, which ${where} has checked out: that is PR #${found.number}`,
    );
  }
  if (found.draft) return { outcome: "held", line: draftLine(found.number) };
  return { outcome: "found", change: changeOf(found, worktree) };
}

function changeOf(pullRequest: PullRequest, worktree: string): PullRequestChange {
  const { number } = pullRequest;
  return {
    key: String(number),
    name: `PR #${number}`,
    rerun: `squiz review ${number}`,
    summaryAt: "on the pull request",
    followUp: followUpFor(number),
    base: pullRequest.baseSha,
    head: pullRequest.headSha,
    description: pullRequest.description,
    worktree,
    nodeId: pullRequest.nodeId,
  };
}

/**
 * Fetch from `origin` whichever of the base and the head the repository lacks,
 * in one fetch that writes no ref and no `FETCH_HEAD`, and check that each
 * arrived.
 */
function provideCommits(
  change: Change,
  until: Deadline,
): { readonly outcome: "ready"; readonly alternates: readonly string[] } | Failed {
  for (const name of [change.head, change.base]) {
    if (!FULL_COMMIT_NAME.test(name)) return failed(`${JSON.stringify(name)} is not a full commit name`);
  }
  const worktree = worktreeOf(change);
  const missing: string[] = [];
  for (const name of new Set([change.head, change.base])) {
    const present = hasCommit(worktree, name, until);
    if (!present.known) return failed(`whether ${name} is here could not be told: ${present.reason}`);
    if (!present.has) missing.push(name);
  }
  if (missing.length === 0) return { outcome: "ready", alternates: [] };

  const fetched = runGit(
    worktree,
    // FETCH_HEAD is shared with the coding agent, so it is left as it was.
    ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin", ...missing],
    { until },
  );
  if (!fetched.ran) return failed(`${missing.join(" and ")} could not be fetched: ${fetched.reason}`);
  for (const name of missing) {
    const arrived = hasCommit(worktree, name, until);
    if (!arrived.known) return failed(`whether ${name} arrived could not be told: ${arrived.reason}`);
    if (!arrived.has) return failed(`the fetch finished without bringing ${name}`);
  }
  return { outcome: "ready", alternates: [] };
}

type Presence = { readonly known: true; readonly has: boolean } | { readonly known: false; readonly reason: string };

function hasCommit(worktree: string, commit: string, until: Deadline): Presence {
  // Exit 1 with nothing said is a commit the repository does not have. A
  // `cat-file -e` of the same name exits 128 for that, as it does for a
  // repository it cannot read.
  const checked = runGit(worktree, ["rev-parse", "--quiet", "--verify", `${commit}^{commit}`], {
    until,
    answers: [0, 1],
  });
  if (!checked.ran) return { known: false, reason: checked.reason };
  return { known: true, has: checked.status === 0 };
}

/** GitHub's posting outcome, with its REST comment id spelled as the venue's opaque string. */
function posting(posted: GitHubThreadPosting): ThreadPosting {
  if (posted.outcome === "posted" || posted.outcome === "posted-without-thread-id") {
    return { ...posted, commentId: String(posted.commentId) };
  }
  return posted;
}

function worktreeOf(change: Change): string {
  return "worktree" in change && typeof change.worktree === "string" ? change.worktree : process.cwd();
}

/**
 * The pull request number `key` spells, or the failure of a key that spells
 * none. A number too large for a JavaScript number to hold exactly would be
 * read back as another, so it spells none.
 */
function numberIn(key: string): number | Failed {
  const number = Number(key);
  if (!NUMBER_KEY.test(key) || !Number.isSafeInteger(number)) return failed(`${JSON.stringify(key)} is not a pull request number`);
  return number;
}

function none(reason: string): ChangeLookup {
  return { outcome: "none", reason };
}

function failed(reason: string): Failed {
  return { outcome: "failed", reason };
}

