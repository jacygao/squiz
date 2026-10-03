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
 * round existed. So the tree is asked about again before the comparison is used.
 *
 * **An episode that ran wholly between the two askings is found by what it
 * recorded.** Neither asking sees such an episode live, so what it left on disk is
 * the whole of the evidence, and the state file's content is what two askings are
 * compared by. Every write an episode makes goes through the one writer, so
 * content that did not move is a file nothing wrote. What the alternatives do
 * instead:
 *
 * - A directory name is the same however many rounds ran inside it, which is the
 *   case this answers.
 * - The running marker is written when a round starts and removed when it ends, so
 *   a round that began and ended in between leaves nothing at either asking.
 * - The file's mtime says when a write landed rather than what it recorded, and
 *   nothing here owns the clock it was stamped from.
 * - The round count inside the file moves for a round that recorded a spend and
 *   stands still for one that recorded only its close.
 *
 * An episode with nothing recorded, and one whose state will not read, are each
 * their own answer and never a tree this round had to itself. Neither shows that
 * the episode did nothing.
 *
 * **What the round has left decides that this starts, and never how long it
 * runs.** Nothing about the round's window reaches a git or a ps already running,
 * so one deadline covers the whole phase, the lookup and the reading together.
 * What a round would lose to an unbounded phase is the recorded cost of a review
 * that finished and the posting after it.
 *
 * Nothing here reports. What the readings establish is carried to the round's
 * close, and the summary comment is what names it.
 *
 * **What a round established outlives the round.** A round that blocks posts no
 * comment, so each round's readings are added to what the episode has established
 * and the closing round's comment names all of it. A comment composed from the
 * closing round's readings alone would say a tree nobody touched for an episode
 * whose first round named a mutated file.
 *
 * Nothing here throws, and nothing here changes what the round does. A mutated
 * tree is reported rather than blocked on.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
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
import { episodeNamed, type Episode } from "./episode.ts";

/**
 * The longest the round spends on one side of the reviewer, and the least of its
 * window that must be left for it to spend any.
 *
 * One number for both, so that nothing here is cut short by the window: the phase
 * starts only where the whole of its own bound is left.
 */
const PHASE_BOUND_MS = 5_000;

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
  /** What the reviewer did to the paths a commit could carry, and to `HEAD`. */
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

/**
 * What every round of one episode established about the worktree, which is what
 * the summary comment's Notes are composed from.
 *
 * The episode's and never one round's. A round that blocks posts no comment, so
 * what its readings found is reported by the round that closes the episode or by
 * nothing at all.
 *
 * Only what Notes prints is here, and a round's own reading carries more than
 * that. The marker is the part left out: a marker that was not written costs a
 * later round its comparison, and that lands on another pull request.
 */
export type ConfinementEvidence = {
  /** Every tracked path a round found changed, once each, in path order. */
  readonly changed: readonly string[];
  /**
   * Every move of `HEAD` a round found, as one line naming both ends, once each,
   * in the order the rounds found them.
   */
  readonly moved: readonly string[];
  /**
   * Why a round took no comparison, or could not have the one it took, in the
   * order the rounds established it.
   *
   * One entry per distinct reason. A round that failed the same way as an earlier
   * one adds nothing.
   */
  readonly uncompared: readonly string[];
  /** Every other episode a round found in the worktree, by id, in id order. */
  readonly shared: readonly string[];
  /** Why a round could not establish who else was in the worktree, once each. */
  readonly unestablished: readonly string[];
};

/** An episode whose rounds established nothing, which is no note at all. */
export const nothingEstablished: ConfinementEvidence = {
  changed: [],
  moved: [],
  uncompared: [],
  shared: [],
  unestablished: [],
};

/**
 * The most entries one list keeps.
 *
 * Nothing bounds how many times an episode adds to one of these lists: an attempt
 * that was no round spends none of the round cap and fails the same way every time
 * the hook fires. Identical evidence collapses, so a repeat adds nothing, and this
 * is what holds a reason that varies between firings. One round's own answer can
 * reach it too, where the reviewer changed more paths than this.
 *
 * The entries kept are the earliest, which are the ones a later round must not
 * push out.
 */
const MOST_KEPT = 64;

/**
 * What the episode has established, with what one round's readings found added to
 * it.
 *
 * `undefined` where the rounds so far have established nothing, which is a
 * worktree every reviewer left alone and had to itself. The episode's state file
 * carries no field for that, so a file written before this one existed reads the
 * same as one written for an episode with nothing to report.
 *
 * Never throws, and never drops what `before` holds.
 */
export function evidenceWith(
  before: ConfinementEvidence | undefined,
  round: RoundConfinement,
): ConfinementEvidence | undefined {
  const had = before ?? nothingEstablished;
  const evidence: ConfinementEvidence = {
    changed: byValue(had.changed, pathsChanged(round.trackedFiles)),
    moved: byRound(had.moved, headMoved(round.trackedFiles)),
    uncompared: byRound(had.uncompared, whyUncompared(round.trackedFiles)),
    shared: byValue(had.shared, whoSharedIt(round.otherEpisodes)),
    unestablished: byRound(had.unestablished, whyUnestablished(round.otherEpisodes)),
  };
  return anything(evidence) ? evidence : undefined;
}

function pathsChanged(answer: TrackedFilesAnswer): readonly string[] {
  return answer.outcome === "changed" ? answer.paths : [];
}

function headMoved(answer: TrackedFilesAnswer): readonly string[] {
  if (answer.outcome !== "changed" || answer.head === undefined) return [];
  return [`from ${answer.head.before} to ${answer.head.after}`];
}

function whyUncompared(answer: TrackedFilesAnswer): readonly string[] {
  switch (answer.outcome) {
    case "unchanged":
    case "changed":
      return [];
    case "unknown":
    case "not-taken":
      return [answer.reason];
  }
}

function whoSharedIt(episodes: OtherEpisodes): readonly string[] {
  return episodes.outcome === "shared" ? episodes.episodes.map((other) => other.id) : [];
}

function whyUnestablished(episodes: OtherEpisodes): readonly string[] {
  return episodes.outcome === "unknown" ? [episodes.reason] : [];
}

/**
 * `had` and `found` as one list, once each, ordered by the value itself.
 *
 * The cap chooses which entries survive, and the order here only arranges the ones
 * that did. Sorting before the cap would let a later round's entry that sorts early
 * push out an earlier round's, which is the loss these lists exist to carry.
 */
function byValue(had: readonly string[], found: readonly string[]): readonly string[] {
  return [...byRound(had, found)].sort();
}

/**
 * `had` and `found` as one list, once each, the earlier round's entries first.
 *
 * What the cap drops is what arrived last. An entry the episode had already kept
 * stays kept.
 */
function byRound(had: readonly string[], found: readonly string[]): readonly string[] {
  return [...new Set([...had, ...found])].slice(0, MOST_KEPT);
}

function anything(evidence: ConfinementEvidence): boolean {
  const lists = [
    evidence.changed,
    evidence.moved,
    evidence.uncompared,
    evidence.shared,
    evidence.unestablished,
  ];
  return lists.some((list) => list.length > 0);
}

/**
 * What one episode of the worktree has recorded, as a value two askings compare
 * by.
 *
 * `untold` covers an episode with nothing recorded and one whose state will not
 * read. Neither of those shows that the episode did nothing.
 */
type EpisodeRecord =
  | { readonly outcome: "recorded"; readonly digest: string }
  | { readonly outcome: "untold"; readonly reason: string };

/** What every episode of the worktree but this one has recorded. */
type EpisodesRecorded =
  | { readonly read: true; readonly byId: ReadonlyMap<string, EpisodeRecord> }
  | { readonly read: false; readonly reason: string };

/** What the round holds between the two readings. */
export type BeforeTheReviewer = {
  readonly episode: Episode;
  readonly marked: MarkWrite;
  /** The live episodes at the first asking, which is one half of the answer. */
  readonly otherEpisodes: OtherEpisodes;
  /** What every other episode of the worktree had recorded at the first asking. */
  readonly recorded: EpisodesRecorded;
  /** The first reading, or why the round took none. */
  readonly reading: TrackedFilesReading | NotTaken;
};

/**
 * Mark this round as running, ask which other episodes are in the worktree, and
 * take the reading the reviewer will be compared against.
 *
 * `until` is the moment all of that has to be inside. What it spends comes off
 * the reviewer's own bound, so a slow phase shortens the review rather than
 * pushing the round past its window.
 *
 * Never throws. A marker that was not written, a tree that is shared and a
 * reading that failed are each carried rather than raised, and none of them stops
 * the round.
 */
export function readBeforeReviewer(episode: Episode, until: Deadline): BeforeTheReviewer {
  const marked = markRoundRunning(episode);

  const phase = phaseInside(until);
  if (phase === null) {
    const reason = "the round had too little of its window left to read the worktree";
    return {
      episode,
      marked,
      otherEpisodes: { outcome: "unknown", reason },
      recorded: { read: false, reason },
      reading: { outcome: "not-taken", reason },
    };
  }

  const otherEpisodes = otherLiveEpisodes(episode.worktree, episode.id, phase);
  const recorded = whatEachEpisodeRecorded(episode, phase);
  const shared = whyNotCompared(otherEpisodes);
  if (shared !== null) {
    return {
      episode,
      marked,
      otherEpisodes,
      recorded,
      reading: { outcome: "not-taken", reason: shared },
    };
  }
  return {
    episode,
    marked,
    otherEpisodes,
    recorded,
    reading: readTrackedFiles(episode.worktree, phase),
  };
}

/**
 * Take the reading after the reviewer, ask who else was here again, and say what
 * the two readings establish.
 *
 * Reached on every path the reviewer can end on, the time bound included.
 * `until` is the round's own window: nothing is started here where too little of
 * it is left, because what this phase spends comes off the posting that follows.
 *
 * Never throws.
 */
export function readAfterReviewer(before: BeforeTheReviewer, until: Deadline): RoundConfinement {
  const { episode, marked } = before;
  const phase = phaseInside(until);
  const asked =
    phase === null
      ? untold("the round had too little of its window left to ask who else was here")
      : otherLiveEpisodes(episode.worktree, episode.id, phase);
  const otherEpisodes = eitherAsking(before.otherEpisodes, asked);
  return { marked, otherEpisodes, trackedFiles: compared(before, otherEpisodes, phase) };
}

function compared(
  before: BeforeTheReviewer,
  otherEpisodes: OtherEpisodes,
  phase: Deadline | null,
): TrackedFilesAnswer {
  const { episode, reading } = before;
  if (reading.outcome === "not-taken") return reading;

  // The tree turned out to have been shared after the first reading was taken, so
  // what the two readings disagree about is not this reviewer's alone.
  const shared = whyNotCompared(otherEpisodes);
  if (shared !== null) return { outcome: "not-taken", reason: shared };

  if (phase === null) {
    return {
      outcome: "not-taken",
      reason: "the round had too little of its window left to read the worktree a second time",
    };
  }

  const elsewhere = whoElseWorked(episode, before.recorded, phase);
  if (elsewhere !== null) return { outcome: "not-taken", reason: elsewhere };

  // A first reading that failed leaves nothing for a second one to be compared
  // against, and the comparison says which of the two could not be taken.
  const after =
    reading.outcome === "failed" ? reading : readTrackedFiles(episode.worktree, phase);
  return compareTrackedFiles(reading, after);
}

/**
 * One deadline over everything the round does on one side of the reviewer, or
 * `null` where too little of the window is left to start.
 */
function phaseInside(until: Deadline): Deadline | null {
  return until.remaining() >= PHASE_BOUND_MS ? deadlineIn(PHASE_BOUND_MS) : null;
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
 * Why no comparison is taken over another episode of the worktree, or `null`
 * where every one of them is as it was before the reviewer ran.
 *
 * An episode that ran and closed inside one review is live at neither asking, and
 * the tree was shared for part of the interval the comparison covers. What it
 * recorded is what is left of it, and an episode that recorded nothing either
 * side of the review cannot be shown to have done nothing.
 */
function whoElseWorked(
  episode: Episode,
  before: EpisodesRecorded,
  phase: Deadline,
): string | null {
  if (!before.read) return unestablished(before.reason);
  const now = whatEachEpisodeRecorded(episode, phase);
  if (!now.read) return unestablished(now.reason);

  const worked: string[] = [];
  const cannotTell: string[] = [];
  for (const id of [...new Set([...before.byId.keys(), ...now.byId.keys()])].sort()) {
    const was = before.byId.get(id);
    const is = now.byId.get(id);
    // An episode's directory arriving or going is the episode itself at work.
    if (was === undefined || is === undefined) worked.push(id);
    else if (was.outcome === "untold") cannotTell.push(`${id}: ${was.reason}`);
    else if (is.outcome === "untold") cannotTell.push(`${id}: ${is.reason}`);
    else if (was.digest !== is.digest) worked.push(id);
  }

  if (worked.length > 0) {
    const plural = worked.length === 1 ? "episode" : "episodes";
    return `the ${plural} ${worked.join(", ")} worked in the worktree while the reviewer ran`;
  }
  if (cannotTell.length > 0) {
    const which = cannotTell.join("; ");
    return `what another episode of the worktree recorded could not be established: ${which}`;
  }
  return null;
}

function unestablished(reason: string): string {
  return `the episodes of the worktree could not be listed: ${reason}`;
}

/**
 * What each episode of the worktree other than this one has recorded.
 *
 * The episode owns where the episodes sit and where its own state file goes, so
 * both are taken from it rather than spelled again here.
 */
function whatEachEpisodeRecorded(episode: Episode, phase: Deadline): EpisodesRecorded {
  const directory = dirname(episode.directory);

  let names: readonly string[];
  try {
    names = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== episode.id)
      .map((entry) => entry.name);
  } catch (cause) {
    // Nothing has ever been written here, so no other episode has been here
    // either.
    if (isMissing(cause)) return { read: true, byId: new Map() };
    return { read: false, reason: `${directory} could not be read: ${reasonFor(cause)}` };
  }

  const byId = new Map<string, EpisodeRecord>();
  for (const name of names) {
    // A directory no episode key could have produced holds nobody's episode.
    const other = episodeNamed(episode.worktree, name);
    if (other === undefined) continue;
    if (phase.passed()) return { read: false, reason: RAN_OUT };
    byId.set(other.id, recordOf(other));
  }
  return { read: true, byId };
}

/**
 * What one episode's state file holds, as one value.
 *
 * The bytes rather than what they parse to. A field the reader does not know
 * about is still a write the episode made, and a reading that normalised it away
 * would answer that the episode did nothing.
 */
function recordOf(episode: Episode): EpisodeRecord {
  try {
    const digest = createHash("sha256").update(readFileSync(episode.stateFile)).digest("hex");
    return { outcome: "recorded", digest };
  } catch (cause) {
    if (isMissing(cause)) {
      return { outcome: "untold", reason: `nothing is recorded at ${episode.stateFile}` };
    }
    return {
      outcome: "untold",
      reason: `${episode.stateFile} could not be read: ${reasonFor(cause)}`,
    };
  }
}

/** What a phase cut short at its bound says, which is never that nothing happened. */
const RAN_OUT = "the round ran out of the time it had to read the worktree";

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
