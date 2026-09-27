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
 * **Where another episode was in the worktree, no comparison is taken.** A
 * reading taken around one reviewer, in a tree a second episode is also writing,
 * names that episode's work as this reviewer's. The round still runs: what is
 * disabled is the comparison and nothing else.
 *
 * **Who else is here is asked twice, and an episode that appeared between the two
 * readings counts.** Marking this round before reading makes a round that starts
 * later find this one, and does nothing for this one, which asked before that
 * round existed. So the tree is asked about again before the comparison is used,
 * and an episode whose directory appeared meanwhile is counted even where it is
 * live at neither asking.
 *
 * **Every reading is bounded.** Nothing about the round's window reaches a git
 * that has already started, so the reading is given a deadline of its own and
 * carries a failure where it reaches it. What a round would lose to an unbounded
 * one is the recorded cost of a review that finished and the posting after it.
 *
 * Nothing here reports. What the readings establish is carried to the round's
 * close, and the summary comment is what names it.
 *
 * Nothing here throws, and nothing here changes what the round does. A mutated
 * tree is reported rather than blocked on.
 */

import { readdirSync } from "node:fs";
import { dirname } from "node:path";

import { deadlineIn, type Deadline } from "../reviewers/deadline.ts";
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
 * The longest a reading may run, and the least of the round's window that must be
 * left for one to be started.
 *
 * One number for both, so that a reading is never cut short by the window: it is
 * started only where the whole of its own bound is left, and it is bounded, so it
 * cannot spend more of the round than this.
 */
const READING_BOUND_MS = 5_000;

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
  /**
   * The other episodes found live in the worktree, at either asking.
   *
   * Either one finding an episode makes the tree shared. The comparison covers
   * the whole interval between the readings, and an episode live at either end of
   * it was in the tree for part of that.
   */
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

/** The episodes of a worktree, as the directories holding their state name them. */
type EpisodesPresent =
  | { readonly listed: true; readonly ids: readonly string[] }
  | { readonly listed: false; readonly reason: string };

/** What the round holds between the two readings. */
export type BeforeTheReviewer = {
  readonly episode: Episode;
  readonly marked: MarkWrite;
  /** The live episodes at the first asking, which is one half of the answer. */
  readonly otherEpisodes: OtherEpisodes;
  /** Every episode of the worktree at the first asking, live or over. */
  readonly present: EpisodesPresent;
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

  if (!roomForAReading(until)) {
    const reason = "the round had too little of its window left to read the worktree";
    return {
      episode,
      marked,
      otherEpisodes: { outcome: "unknown", reason },
      present: { listed: false, reason },
      reading: { outcome: "not-taken", reason },
    };
  }

  const otherEpisodes = otherLiveEpisodes(episode.worktree, episode.id);
  const present = episodesIn(episode);
  const shared = whyNotCompared(otherEpisodes);
  if (shared !== null) {
    return {
      episode,
      marked,
      otherEpisodes,
      present,
      reading: { outcome: "not-taken", reason: shared },
    };
  }
  return {
    episode,
    marked,
    otherEpisodes,
    present,
    reading: readTrackedFiles(episode.worktree, boundFor(until)),
  };
}

/**
 * Take the reading after the reviewer, ask who else was here again, and say what
 * the two readings establish.
 *
 * Reached on every path the reviewer can end on, the time bound included.
 * `until` is the round's own window: a second reading is not started where too
 * little of it is left, because what a reading spends here comes off the posting
 * that follows.
 *
 * Never throws.
 */
export function readAfterReviewer(before: BeforeTheReviewer, until: Deadline): RoundConfinement {
  const { episode, marked } = before;
  const asked = roomForAReading(until)
    ? otherLiveEpisodes(episode.worktree, episode.id)
    : untold("the round had too little of its window left to ask who else was here");
  const otherEpisodes = eitherAsking(before.otherEpisodes, asked);
  return { marked, otherEpisodes, trackedFiles: compared(before, otherEpisodes, until) };
}

function compared(
  before: BeforeTheReviewer,
  otherEpisodes: OtherEpisodes,
  until: Deadline,
): TrackedFilesAnswer {
  const { episode, reading } = before;
  if (reading.outcome === "not-taken") return reading;

  // The tree turned out to have been shared after the first reading was taken, so
  // what the two readings disagree about is not this reviewer's alone.
  const shared = whyNotCompared(otherEpisodes) ?? whoAppeared(episode, before.present);
  if (shared !== null) return { outcome: "not-taken", reason: shared };

  if (!roomForAReading(until)) {
    return {
      outcome: "not-taken",
      reason: "the round had too little of its window left to read the worktree a second time",
    };
  }
  // A first reading that failed leaves nothing for a second one to be compared
  // against, and the comparison says which of the two could not be taken.
  const after =
    reading.outcome === "failed"
      ? reading
      : readTrackedFiles(episode.worktree, boundFor(until));
  return compareTrackedFiles(reading, after);
}

/** Whether the round can start a reading and see the end of it inside `until`. */
function roomForAReading(until: Deadline): boolean {
  return until.remaining() >= READING_BOUND_MS;
}

function boundFor(until: Deadline): Deadline {
  return deadlineIn(Math.min(READING_BOUND_MS, until.remaining()));
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

/**
 * Why no comparison is taken over an episode that appeared while the reviewer
 * ran, or `null` where none did.
 *
 * An episode that started and closed inside one review is live at neither asking,
 * and the tree was shared for part of the interval the comparison covers all the
 * same. The directory holding its state is what is left of it.
 */
function whoAppeared(episode: Episode, before: EpisodesPresent): string | null {
  if (!before.listed) return unlisted(before.reason);
  const now = episodesIn(episode);
  if (!now.listed) return unlisted(now.reason);

  const had = new Set(before.ids);
  const appeared = now.ids.filter((id) => !had.has(id)).sort();
  if (appeared.length === 0) return null;
  const which = appeared.join(", ");
  const plural = appeared.length === 1 ? "episode" : "episodes";
  return `the ${plural} ${which} appeared in the worktree while the reviewer ran`;
}

function unlisted(reason: string): string {
  return `the episodes of the worktree could not be listed: ${reason}`;
}

/**
 * Every episode of the worktree other than this one, live or over.
 *
 * The episode owns where its own directory sits, so the directory holding all of
 * them is taken from it rather than spelled again here.
 */
function episodesIn(episode: Episode): EpisodesPresent {
  const directory = dirname(episode.directory);
  try {
    const ids = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== episode.id)
      .map((entry) => entry.name);
    return { listed: true, ids };
  } catch (cause) {
    // Nothing has ever been written here, so no other episode has been here
    // either.
    if (isMissing(cause)) return { listed: true, ids: [] };
    return { listed: false, reason: `${directory} could not be read: ${reasonFor(cause)}` };
  }
}

/**
 * What the two askings together say about the worktree.
 *
 * An episode either of them found is named. Where neither found one and either
 * could not tell, the answer is that nothing was established, because a round
 * that read that as a tree it had to itself would claim a comparison is valid
 * without having found out.
 */
function eitherAsking(before: OtherEpisodes, after: OtherEpisodes): OtherEpisodes {
  const found = [...foundIn(before), ...foundIn(after)];
  if (found.length > 0) return { outcome: "shared", episodes: once(found) };

  const untold = [before, after]
    .filter((asking) => asking.outcome === "unknown")
    .map((asking) => (asking.outcome === "unknown" ? asking.reason : ""));
  if (untold.length > 0) return { outcome: "unknown", reason: untold.join("; ") };
  return { outcome: "alone" };
}

function foundIn(asking: OtherEpisodes): readonly LiveEpisode[] {
  return asking.outcome === "shared" ? asking.episodes : [];
}

/** One entry per episode, however many askings found it, in order of id. */
function once(episodes: readonly LiveEpisode[]): readonly LiveEpisode[] {
  const byId = new Map(episodes.map((episode) => [episode.id, episode]));
  return [...byId.values()].sort((one, other) => (one.id < other.id ? -1 : 1));
}

function untold(reason: string): OtherEpisodes {
  return { outcome: "unknown", reason };
}

function named(episodes: readonly LiveEpisode[]): string {
  const ids = episodes.map((episode) => episode.id).join(", ");
  return episodes.length === 1 ? `live episode ${ids}` : `live episodes ${ids}`;
}

function isMissing(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return error.code === "ENOENT";
}

function reasonFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
