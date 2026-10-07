/**
 * Every thread of this review on the pull request at the close of an episode,
 * read as the status it ended in and what the summary has to print for it.
 *
 * **Two sources, and a reader of either alone is quietly wrong.** The threads
 * handed to the reviewer were listed before the review ran, so a thread the
 * closing round itself opened is not among them: its finding is in what the
 * round posted instead. A classifier that walked only the hand-over would drop
 * every finding raised in the last round, which is the round most likely to have
 * raised one and the round whose findings most need a person.
 *
 * So a headline comes from one of two places. A thread that was handed over
 * carries the comment that opened it, and that comment is the record of the
 * finding. A thread this round opened carries no comment the harness has read
 * back, and the finding it was written from is in hand instead.
 *
 * Nothing is carried between rounds and nothing here reads GitHub. Every thread
 * the reviewer opened is handed over each round, resolved ones included, so the
 * closing round's own account covers the whole episode.
 *
 * The comment itself is composed elsewhere, and nothing here throws.
 */

import { statusOf, type ThreadStatus, type Verdict } from "../findings/status.ts";
import { readThread } from "../findings/thread.ts";
import type { ReviewThread } from "../github/threads.ts";
import type { PostedFindings, Threaded } from "./post-findings.ts";
import type { AppliedVerdicts } from "./verdicts.ts";

/** What the closing round holds of the episode, which is the whole of it. */
export type EpisodeAtClose = {
  /**
   * Every thread the round handed the reviewer, as it was listed before the
   * review: its comments, its anchor and its resolved state.
   */
  readonly handedOver: readonly ReviewThread[];
  /** What the reviewer ruled on each of those threads. */
  readonly verdicts: AppliedVerdicts;
  /**
   * What became of every finding this round raised, which is where the threads
   * it opened are. They are absent from the hand-over, which was read before
   * they existed.
   */
  readonly findings: PostedFindings;
};

/**
 * One thread of this review, as the summary names it.
 *
 * Only what the summary has of it: the counts read the status, and the
 * needs-a-person list prints the headline and the location. The thread's
 * identifier is not here, because nothing is addressed to a thread once the
 * episode is over.
 */
export type ClassifiedThread = {
  readonly status: ThreadStatus;
  // Null where the reviewer left the headline blank, which drops it from the comment.
  readonly headline: string | null;
  /**
   * Where the thread sits: `file:line` for one anchored to a line, and the file
   * alone for one anchored to a file.
   */
  readonly location: string;
  /**
   * True where the reviewer kept the thread open in the closing round and its
   * reply giving the reason could not be posted. The thread then shows no reason,
   * and Notes is the only place that says one was given.
   */
  readonly reasonUnposted?: true;
};

/**
 * Every thread of this review, each with the one status it ended the episode in.
 *
 * The hand-over's threads come first, in the order they were listed, then the
 * threads this round opened, in the order they were posted.
 *
 * A thread no marker claims is left out. A person can open a thread on the pull
 * request, and one counted here would have the summary report a finding nobody
 * raised.
 *
 * Nothing is refused and nothing here throws.
 */
export function classifyAtClose(closing: EpisodeAtClose): readonly ClassifiedThread[] {
  const ruled = rulings(closing.verdicts);
  const unposted = new Set(
    closing.verdicts.threads
      .filter((applied) => applied.reply?.outcome === "failed")
      .map((applied) => applied.thread),
  );
  const classified: ClassifiedThread[] = [];
  const counted = new Set<string>();

  for (const thread of closing.handedOver) {
    // Noted whether or not it carries a finding, so that nothing below can reach
    // one of them a second time.
    counted.add(thread.id);
    const reading = readThread(thread);
    if (reading.raised !== "finding") continue;
    classified.push({
      status: statusOf({
        verdict: ruled.get(thread.id) ?? null,
        codingAgentReplied: reading.codingAgentReplied,
      }),
      headline: reading.headline,
      location: locationOf(thread),
      ...(unposted.has(thread.id) ? { reasonUnposted: true } : {}),
    });
  }

  for (const opened of threadsOpened(closing.findings)) {
    // A thread the round just opened has an id GitHub has never issued before,
    // so it cannot be one the hand-over carried. Checked rather than assumed: a
    // thread counted twice is a finding the summary reports twice.
    if (opened.threadId !== null && counted.has(opened.threadId)) continue;
    const location = openedLocation(opened);
    // A threaded finding naming no file, which the router cannot produce: a
    // finding with no file is reported general and no thread is opened for it.
    // There is nothing to print where it sits.
    if (location === null) continue;
    classified.push({
      // The round opened this thread after the coding agent's turn ended and
      // after the reviewer was handed its work, so the reviewer returned no
      // verdict for it and nothing has replied to it.
      status: statusOf({ verdict: null, codingAgentReplied: false }),
      headline: opened.finding.headline,
      location,
    });
  }

  return classified;
}

/**
 * What the reviewer ruled, by thread.
 *
 * A thread finds its verdict by the identifier the verdict names. A ruling read
 * off its position in the list would take the verdict on whichever thread sat
 * there.
 *
 * A thread with no entry and one entered with no ruling are the same answer
 * here, which is that the reviewer ruled on neither. The default that makes a
 * status of that belongs to `statusOf` and is applied there once.
 */
function rulings(verdicts: AppliedVerdicts): ReadonlyMap<string, Verdict | null> {
  return new Map(verdicts.threads.map((applied) => [applied.thread, applied.ruled]));
}

/** The threads this round's own findings opened, in the order they were posted. */
function threadsOpened(posted: PostedFindings): readonly Threaded[] {
  return posted.outcomes.filter((outcome) => outcome.outcome === "threaded");
}

/**
 * Where the thread sits, as the summary writes it.
 *
 * A thread GitHub named no line for is given its file alone, which is the whole
 * of what there is to print for it, and it reads as a file-anchored thread does.
 */
function locationOf(thread: ReviewThread): string {
  const { anchor } = thread;
  switch (anchor.at) {
    case "line":
      return `${thread.path}:${anchor.line}`;
    case "file":
      return thread.path;
    case "unnamed-line":
      return thread.path;
    default: {
      // An anchor case none of the above names, which the summary has no
      // rendering for. `anchor` is `never` only while those three are all there
      // is, so a fourth stops this compiling.
      const unhandled: never = anchor;
      return unhandled;
    }
  }
}

/**
 * Where the thread this round opened sits, or `null` where its finding named no
 * file.
 *
 * Read off where the comment was placed rather than off the scope the reviewer
 * chose. A finding scoped to a line whose line the diff did not carry is a
 * thread on the file, and a later round is handed it with a file anchor: located
 * from the scope, the summary would move it between one episode and the next.
 */
function openedLocation(opened: Threaded): string | null {
  const { finding, placement } = opened;
  if (finding.file === undefined) return null;
  if (placement === "file" || finding.line === undefined) return finding.file;
  return `${finding.file}:${finding.line}`;
}
