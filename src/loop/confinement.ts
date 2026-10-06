/**
 * The two readings taken around the reviewer, and what they establish.
 *
 * A shell is itself a write primitive, and two readings of the reviewer's snapshot
 * are the only thing that names a file the reviewer changed through one. Nothing
 * but the reviewer writes the snapshot, so a change the readings find is the
 * reviewer's. One is taken before the reviewer starts and one when it exits,
 * whichever way it ended. A reviewer killed at its time bound is the one most
 * likely to have left a write behind, so a second reading taken only where the
 * review finished would be missing from the case it exists for.
 *
 * **What the round has left decides that a reading starts, and never how long it
 * runs.** Nothing about the round's window reaches a git already running, so one
 * deadline covers the whole phase. What a round would lose to an unbounded phase
 * is the recorded cost of a review that finished and the posting after it.
 *
 * Nothing here reports. What the readings establish is carried to the round's
 * close, and the summary comment is what names it, or the failure comment where
 * the round failed.
 *
 * **What a round established outlives the round.** A round that leaves threads
 * open posts no summary, so each round's readings are added to what the episode
 * has established and the closing round's comment names all of it. A comment
 * composed from the closing round's readings alone would say a tree nobody
 * touched for an episode whose first round named a mutated file.
 *
 * **At `deep` the coding agent's git config and hooks are read as well.** The test
 * command can write them by the repository's path, and the snapshot's files do
 * not show it. Unlike the snapshot,
 * those files are not the reviewer's alone: the coding agent and every other
 * worktree of the repository write them, so a change found there is named as one
 * the reviewer's tests may have made. At `read` the reviewer runs nothing, and
 * they are not read.
 *
 * Nothing here throws, and nothing here changes what the round does. A mutated
 * tree is reported rather than acted on.
 */

import { deadlineIn, type Deadline } from "../reviewers/deadline.ts";
import {
  compareSharedConfig,
  readSharedConfig,
  type SharedConfigComparison,
  type SharedConfigReading,
} from "../worktree/shared-config.ts";
import {
  compareTrackedFiles,
  readTrackedFiles,
  type TrackedFilesComparison,
  type TrackedFilesReading,
} from "../worktree/tracked-files.ts";

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

/** What the comparison of the shared git files came to, in the same four answers. */
export type SharedConfigAnswer = SharedConfigComparison | NotTaken;

/** What the round established about the snapshot its reviewer ran in. */
export type RoundConfinement = {
  /** What the reviewer did to the paths a commit could carry, and to `HEAD`. */
  readonly trackedFiles: TrackedFilesAnswer;
  /**
   * What changed in the coding agent's git config and hooks. Absent at `read`, where
   * the reviewer runs nothing that could write them.
   */
  readonly sharedConfig?: SharedConfigAnswer;
};

/**
 * What every round of one episode established about the worktree, which is what
 * the summary comment's Notes are composed from.
 *
 * The episode's and never one round's. A round that leaves threads open posts no
 * summary, so what its readings found is reported by the round that closes the
 * episode or by nothing at all.
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
  /**
   * Every key or file a round found changed among the shared git files, once
   * each, in the order the rounds found them, as the comment writes it.
   */
  readonly sharedChanged: readonly string[];
  /** Why a round could not compare the shared git files, as `uncompared` holds it. */
  readonly sharedUncompared: readonly string[];
};

/** An episode whose rounds established nothing, which is no note at all. */
export const nothingEstablished: ConfinementEvidence = {
  changed: [],
  moved: [],
  uncompared: [],
  sharedChanged: [],
  sharedUncompared: [],
};

/**
 * The most entries one list keeps.
 *
 * Nothing bounds how many times an episode adds to one of these lists: an attempt
 * that was no round spends none of the round cap and can fail the same way on
 * every run. Identical evidence collapses, so a repeat adds nothing, and this
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
    moved: byRound(had.moved, listed(headMovedIn(round))),
    uncompared: byRound(had.uncompared, whyUncompared(round.trackedFiles)),
    sharedChanged: byRound(had.sharedChanged, sharedChanges(round.sharedConfig)),
    sharedUncompared: byRound(had.sharedUncompared, whyUncompared(round.sharedConfig)),
  };
  return anything(evidence) ? evidence : undefined;
}

function pathsChanged(answer: TrackedFilesAnswer): readonly string[] {
  return answer.outcome === "changed" ? answer.paths : [];
}

/**
 * The move of `HEAD` one round found, as one line naming both ends, or
 * `undefined` where it found none.
 */
export function headMovedIn(round: RoundConfinement): string | undefined {
  const answer = round.trackedFiles;
  if (answer.outcome !== "changed" || answer.head === undefined) return undefined;
  return `from ${answer.head.before} to ${answer.head.after}`;
}

function listed(entry: string | undefined): readonly string[] {
  return entry === undefined ? [] : [entry];
}

/** Each change as the comment names it: the key and its file, or the file alone. */
function sharedChanges(answer: SharedConfigAnswer | undefined): readonly string[] {
  if (answer?.outcome !== "changed") return [];
  return answer.changes.map((change) =>
    change.key === undefined ? `\`${change.file}\`` : `\`${change.key}\` in \`${change.file}\``,
  );
}

function whyUncompared(answer: TrackedFilesAnswer | SharedConfigAnswer | undefined): readonly string[] {
  if (answer === undefined) return [];
  switch (answer.outcome) {
    case "unchanged":
    case "changed":
      return [];
    case "unknown":
    case "not-taken":
      return [answer.reason];
  }
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
    evidence.sharedChanged,
    evidence.sharedUncompared,
  ];
  return lists.some((list) => list.length > 0);
}

/** What the round holds between the two readings. */
export type BeforeTheReviewer = {
  /** The snapshot the reviewer runs in, which both readings are taken in. */
  readonly tree: string;
  /** The first reading, or why the round took none. */
  readonly reading: TrackedFilesReading | NotTaken;
  /**
   * The first reading of the shared git files, and the coding agent's worktree
   * they were read for. Absent at `read`.
   */
  readonly shared?: SharedBefore;
};

type SharedBefore = {
  readonly worktree: string;
  readonly reading: SharedConfigReading | NotTaken;
};

/**
 * Take the reading of `tree`, the reviewer's snapshot, that the reviewer will be
 * compared against.
 *
 * `until` is the moment the reading has to be inside, which is the end of the
 * part of the round before the review. `worktree` is the coding agent's worktree,
 * given at `deep` alone, and the shared git files it reads are read too where it
 * is.
 *
 * Never throws. A reading that failed is carried rather than raised, and does
 * not stop the round.
 */
export function readBeforeReviewer(
  tree: string,
  until: Deadline,
  worktree?: string,
): BeforeTheReviewer {
  const phase = phaseInside(until);
  if (phase === null) {
    const reason = "the round had too little of its window left to read the worktree";
    const notTaken: NotTaken = { outcome: "not-taken", reason };
    if (worktree === undefined) return { tree, reading: notTaken };
    return { tree, reading: notTaken, shared: { worktree, reading: notTaken } };
  }
  const reading = readTrackedFiles(tree, phase);
  if (worktree === undefined) return { tree, reading };
  return { tree, reading, shared: { worktree, reading: readSharedConfig(worktree, phase) } };
}

/**
 * Take the reading after the reviewer, and say what the two readings establish.
 *
 * Reached on every path the reviewer can end on, the time bound included.
 * `until` is the round's posting reserve: nothing is started here where too
 * little of it is left, because what this phase spends comes off the posting
 * that follows.
 *
 * Never throws.
 */
export function readAfterReviewer(before: BeforeTheReviewer, until: Deadline): RoundConfinement {
  const phase = phaseInside(until);
  const trackedFiles = compared(before, phase);
  if (before.shared === undefined) return { trackedFiles };
  return { trackedFiles, sharedConfig: sharedCompared(before.shared, phase) };
}

function sharedCompared(shared: SharedBefore, phase: Deadline | null): SharedConfigAnswer {
  const { worktree, reading } = shared;
  if (reading.outcome === "not-taken") return reading;
  if (phase === null) {
    return {
      outcome: "not-taken",
      reason: "the round had too little of its window left to read the shared git files a second time",
    };
  }
  const after = reading.outcome === "failed" ? reading : readSharedConfig(worktree, phase);
  return compareSharedConfig(reading, after);
}

function compared(before: BeforeTheReviewer, phase: Deadline | null): TrackedFilesAnswer {
  const { tree, reading } = before;
  if (reading.outcome === "not-taken") return reading;

  if (phase === null) {
    return {
      outcome: "not-taken",
      reason: "the round had too little of its window left to read the worktree a second time",
    };
  }

  // A first reading that failed leaves nothing for a second one to be compared
  // against, and the comparison says which of the two could not be taken.
  const after =
    reading.outcome === "failed" ? reading : readTrackedFiles(tree, phase);
  return compareTrackedFiles(reading, after);
}

/**
 * One deadline over everything the round does on one side of the reviewer, or
 * `null` where too little of the window is left to start.
 */
function phaseInside(until: Deadline): Deadline | null {
  return until.remaining() >= PHASE_BOUND_MS ? deadlineIn(PHASE_BOUND_MS) : null;
}
