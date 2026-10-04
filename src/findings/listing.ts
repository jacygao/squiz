/**
 * The open threads on a pull request as the lines the coding agent reads them
 * by. `squiz threads` prints them, and `squiz review` prints each open thread
 * under the same line, so the two commands name a thread alike.
 */

import { threadLocation, type ReviewThread } from "../github/threads.ts";
import { namedFindingOn } from "./thread.ts";

/**
 * What `squiz threads` prints for the threads on pull request `pullRequest`.
 *
 * Resolved threads are dropped. The listing is the coding agent's queue of what
 * is still open, and a thread the reviewer closed is not on it.
 */
export function threadListing(pullRequest: number, threads: readonly ReviewThread[]): string {
  const open = threads.filter((thread) => !thread.isResolved);
  // An honest zero says so in words. A command that failed prints nothing at
  // all, and the two must not read alike.
  if (open.length === 0) return `no open threads on #${pullRequest}\n`;

  const counted = `${open.length} open thread${open.length === 1 ? "" : "s"} on #${pullRequest}`;
  const lines = open.map(threadLine);
  return `${[counted, ...lines].join("\n")}\n`;
}

/**
 * One thread as its line: the identifier, the location, and the finding on it.
 *
 * The identifier leads, printed as it arrived and undecorated: it is what
 * `squiz reply` takes back, so the line splits into the identifier and the rest
 * at its first space, whatever the path or the headline holds.
 *
 * A thread carrying no finding ends at its location. A person can open a thread
 * on the pull request, and there is no severity and no headline to print for one.
 *
 * One thread is one line. A path may hold a newline, which would otherwise put a
 * line in the listing that no thread wrote and whose first field a reader would
 * take for an identifier, so the whitespace of the line is collapsed after it is
 * composed. An identifier holds none, and survives.
 */
export function threadLine(thread: ReviewThread): string {
  const located = `${thread.id} ${threadLocation(thread)}`;
  const said = namedFindingOn(thread);
  return (said === "" ? located : `${located} ${said}`).replace(/\s+/gu, " ").trim();
}
