/**
 * One thread on the pull request read as the finding on it: what the reviewer
 * named it, and whether the coding agent answered.
 *
 * Every comment is posted under one GitHub account, so the marker each one opens
 * with is the only thing that says who wrote it. That makes the thread's own
 * first comment the record of the finding, and reading it back is how the
 * summary knows what to call a thread that still needs a person.
 */

import type { ReviewThread, ThreadComment } from "../github/threads.ts";
import { namedFinding, readComment } from "./comment.ts";
import type { Severity } from "./finding.ts";

/** The finding a thread carries, as the comment that opened it named it. */
type RaisedFinding = {
  readonly raised: "finding";
  // Null where the first line named nothing, or named none of the three severities.
  readonly severity: Severity | null;
  // Null where the reviewer left the headline blank, which drops it from the comment.
  readonly headline: string | null;
  readonly codingAgentReplied: boolean;
};

/**
 * A thread the reviewer did not open, which is no finding at all.
 *
 * It carries no severity and no headline rather than empty ones. A thread a
 * person opened is not a finding, and the summary counts findings: answered with
 * the fields blank, it would be listed as one nobody raised.
 */
type NoFinding = { readonly raised: "nothing" };

export type ThreadReading = RaisedFinding | NoFinding;

/**
 * What `thread` says: the finding the reviewer raised on it, or that the
 * reviewer raised none.
 *
 * Nothing is refused and nothing here throws. A thread carrying no comments
 * raised nothing, the same as one a person opened.
 */
export function readThread(thread: ReviewThread): ThreadReading {
  const opening = thread.comments[0];
  if (opening === undefined) return { raised: "nothing" };
  const opened = readComment(opening.body);
  if (opened.by !== "reviewer") return { raised: "nothing" };
  return {
    raised: "finding",
    severity: opened.severity,
    headline: opened.headline,
    codingAgentReplied: thread.comments.some(wroteByCodingAgent),
  };
}

/**
 * What to call the finding on `thread`: its severity and its headline, as one
 * line.
 *
 * Empty for a thread the reviewer did not open, and for one whose first line
 * named neither field. A caller adds it to a line it has composed itself, and
 * the empty string leaves that line as it stood: a thread a person opened is not
 * a finding, and an empty severity or a printed `null` after it would say it was.
 */
export function namedFindingOn(thread: ReviewThread): string {
  const reading = readThread(thread);
  if (reading.raised !== "finding") return "";
  return namedFinding(reading.severity, reading.headline);
}

// Only the coding agent's own marker counts. The reviewer may comment on a
// thread again, however it ruled, and none of those is an answer to it.
function wroteByCodingAgent(comment: ThreadComment): boolean {
  return readComment(comment.body).by === "coding agent";
}
