/**
 * The two readings taken around the reviewer, and the other episodes that were in
 * the worktree while it ran.
 *
 * A shell is itself a write primitive, and two readings of the worktree are the
 * only thing that names a file the reviewer changed through one. One is taken
 * before the reviewer starts and one when it exits, whichever way it ended. A
 * reviewer killed at its time bound is the one most likely to have left a write
 * behind, so a second reading taken only where the review finished would be
 * missing from the case it exists for.
 *
 * **Where another episode is live in the worktree, no comparison is taken.** A
 * reading taken around one reviewer, in a tree a second episode is also writing,
 * names that episode's work as this reviewer's. The round still runs: what is
 * disabled is the comparison and nothing else.
 *
 * **This round is marked as running before anything is read.** A round that read
 * first and marked second could miss a round that started in between, and the two
 * would each take a comparison covering the other's reviewer.
 *
 * Nothing here reports. What the readings establish is carried to the round's
 * close, and the summary comment is what names it.
 *
 * Nothing here throws, and nothing here changes what the round does. A mutated
 * tree is reported rather than blocked on.
 */

import type { Deadline } from "../reviewers/deadline.ts";
import {
  markRoundRunning,
  otherLiveEpisodes,
  type LiveEpisode,
  type MarkWrite,
  type OtherEpisodes,
} from "../worktree/shared-tree.ts";
import {
  compareTrackedFiles,
  readTrackedFiles,
  type TrackedFilesComparison,
  type TrackedFilesReading,
} from "../worktree/tracked-files.ts";
import type { Episode } from "./episode.ts";

/**
 * The least of the round's window that must be left for a reading to be taken.
 *
 * Nothing interrupts a reading once it has started: git runs to its own end, and
 * the hashing walks every path a commit could carry. So this is a floor on what
 * must be left rather than a bound on the reading itself, and a round with less
 * than this left reads nothing and says so.
 */
const READING_FLOOR_MS = 5_000;

/** A reading, or a comparison, the round decided not to take. */
type NotTaken = { readonly outcome: "not-taken"; readonly reason: string };

/**
 * What the comparison came to.
 *
 * Four answers, and `unchanged` is only one of them. `unknown` is a comparison
 * that was taken and could not be had, `not-taken` one the round never took, and
 * a round that read either as a tree nobody touched would report a reviewer that
 * touched nothing.
 */
export type TrackedFilesAnswer = TrackedFilesComparison | NotTaken;

/** What the round established about the worktree its reviewer ran in. */
export type RoundConfinement = {
  /** What the reviewer did to the paths a commit could carry. */
  readonly trackedFiles: TrackedFilesAnswer;
  /** The other live episodes of the worktree, which is what disables a comparison. */
  readonly otherEpisodes: OtherEpisodes;
  /**
   * Whether this round could be named to the other episodes.
   *
   * A marker that was not written costs another round rather than this one: a
   * round starting now cannot find this one, and takes a comparison that reads
   * this reviewer's writes as its own. Carried out so that the round says so.
   */
  readonly marked: MarkWrite;
};

/** What the round holds between the two readings. */
export type BeforeTheReviewer = {
  readonly episode: Episode;
  readonly marked: MarkWrite;
  readonly otherEpisodes: OtherEpisodes;
  /** The first reading, or why the round took none. */
  readonly reading: TrackedFilesReading | NotTaken;
};

/**
 * Mark this round as running, ask which other episodes are live in the worktree,
 * and take the reading the reviewer will be compared against.
 *
 * `until` is the moment the reading has to be inside. What it spends comes off
 * the reviewer's own bound, so a slow reading shortens the review rather than
 * pushing the round past its window.
 *
 * Never throws. A marker that was not written, a tree that is shared and a
 * reading that failed are each carried rather than raised, and none of them stops
 * the round.
 */
export function readBeforeReviewer(episode: Episode, until: Deadline): BeforeTheReviewer {
  const marked = markRoundRunning(episode);

  if (until.remaining() < READING_FLOOR_MS) {
    const reason = "the round had too little of its window left to read the worktree";
    return {
      episode,
      marked,
      otherEpisodes: { outcome: "unknown", reason },
      reading: { outcome: "not-taken", reason },
    };
  }

  const otherEpisodes = otherLiveEpisodes(episode.worktree, episode.id);
  const shared = whyNotCompared(otherEpisodes);
  if (shared !== null) {
    return { episode, marked, otherEpisodes, reading: { outcome: "not-taken", reason: shared } };
  }
  return { episode, marked, otherEpisodes, reading: readTrackedFiles(episode.worktree) };
}

/**
 * Take the reading after the reviewer, and say what the two of them establish.
 *
 * Reached on every path the reviewer can end on, the time bound included.
 * `until` is the round's own window: a second reading is not started where too
 * little of it is left, because what a reading spends here comes off the posting
 * that follows.
 *
 * Never throws.
 */
export function readAfterReviewer(before: BeforeTheReviewer, until: Deadline): RoundConfinement {
  const { episode, marked, otherEpisodes, reading } = before;
  return { marked, otherEpisodes, trackedFiles: compared(episode, reading, until) };
}

function compared(
  episode: Episode,
  reading: TrackedFilesReading | NotTaken,
  until: Deadline,
): TrackedFilesAnswer {
  if (reading.outcome === "not-taken") return reading;
  if (until.remaining() < READING_FLOOR_MS) {
    return {
      outcome: "not-taken",
      reason: "the round had too little of its window left to read the worktree a second time",
    };
  }
  // A first reading that failed leaves nothing for a second one to be compared
  // against, and the comparison says which of the two could not be taken.
  const after = reading.outcome === "failed" ? reading : readTrackedFiles(episode.worktree);
  return compareTrackedFiles(reading, after);
}

/**
 * Why no comparison is taken around this reviewer, or `null` where one is.
 *
 * A tree nothing could be established about is treated as a shared one. The
 * answer a comparison would give there is one nothing has shown to be about this
 * reviewer.
 */
function whyNotCompared(episodes: OtherEpisodes): string | null {
  switch (episodes.outcome) {
    case "alone":
      return null;
    case "unknown":
      return `the live episodes of the worktree could not be established: ${episodes.reason}`;
    case "shared":
      return `the worktree is shared with ${named(episodes.episodes)}`;
  }
}

function named(episodes: readonly LiveEpisode[]): string {
  const ids = episodes.map((episode) => episode.id).join(", ");
  return episodes.length === 1 ? `live episode ${ids}` : `live episodes ${ids}`;
}
