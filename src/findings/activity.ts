/**
 * The latest activity on the reviewer's threads: the second half of a pull
 * request's state, beside its head commit.
 *
 * A new reply has to come out as a new answer, or the review on record is read
 * as covering a reply it never saw. So the newest is decided by when each reply
 * was posted, and never by where it is listed or by how its identifier sorts.
 */

import type { ReviewThread, ThreadComment } from "../venues/github/threads.ts";
import { readComment } from "./comment.ts";
import { readThread } from "./thread.ts";

/**
 * The node id of the newest reply anyone but the reviewer posted on a thread the
 * reviewer opened, or `null` where there is none.
 *
 * A reply is a comment after a thread's first. The coding agent's replies count
 * and so do a person's. A thread anyone else opened counts for nothing.
 *
 * Ties are broken in two steps:
 *
 * - GitHub gives the time only to the second, so replies posted in the same
 *   second go to the larger REST id. This assumes REST ids grow as replies are
 *   posted. Where one did not, a reply posted in the same second as the newest
 *   would leave the answer unchanged.
 * - Where neither decides, the larger node id wins. That says nothing about which
 *   came later, but gives the same answer however the threads are listed.
 *
 * A general thread's comments take their REST ids from another sequence than
 * the other threads', so the two are never compared by REST id. Where the newest
 * of each was posted in the same second, either may be the later, and the answer
 * is both node ids, the other thread's first: a reply added in that second to
 * either kind of thread changes it.
 */
export function latestActivity(threads: readonly ReviewThread[]): string | null {
  const onFiles = newestReply(threads.filter((thread) => thread.anchor.at !== "change"));
  const onTheChange = newestReply(threads.filter((thread) => thread.anchor.at === "change"));
  if (onFiles === null || onTheChange === null) return (onFiles ?? onTheChange)?.id ?? null;
  const byTime = Date.parse(onFiles.createdAt) - Date.parse(onTheChange.createdAt);
  if (byTime !== 0) return (byTime > 0 ? onFiles : onTheChange).id;
  return `${onFiles.id} ${onTheChange.id}`;
}

function newestReply(threads: readonly ReviewThread[]): ThreadComment | null {
  let newest: ThreadComment | null = null;
  for (const thread of threads) {
    if (readThread(thread).raised !== "finding") continue;
    for (const reply of thread.comments.slice(1)) {
      if (readComment(reply.body).by === "reviewer") continue;
      if (newest === null || postedAfter(reply, newest)) newest = reply;
    }
  }
  return newest;
}

function postedAfter(reply: ThreadComment, than: ThreadComment): boolean {
  const byTime = Date.parse(reply.createdAt) - Date.parse(than.createdAt);
  if (byTime !== 0) return byTime > 0;
  const byRestId = (reply.databaseId ?? -1) - (than.databaseId ?? -1);
  if (byRestId !== 0) return byRestId > 0;
  return reply.id > than.id;
}
