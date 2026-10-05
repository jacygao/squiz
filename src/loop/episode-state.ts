/**
 * The episode's state file: what each round spent, whether the close has been
 * reported, what the rounds established about the worktree they ran in, and the
 * record of each state of the pull request.
 *
 * Absent and unreadable are different answers, and keeping them apart is most of
 * what this module is for. A file that is not there is a first round. A file
 * that is there and does not read back is not, because a round that took the
 * two the same way would start the count again every time the hook fired, and
 * the round count is what bounds the loop.
 *
 * Nothing here throws. A write that fails comes back carrying the error the
 * filesystem gave, because the subagent has to finish its turn whatever the
 * state file does, and a round that stops reviewing has to say why.
 *
 * Nothing here decides anything from the state either. This reads it and writes
 * it.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

import { unspent, type RoundCost } from "../reviewers/adapter.ts";
import type { ConfinementEvidence } from "./confinement.ts";
import type { Episode } from "./episode.ts";
import { type StateRecord, recordFrom, recordFor } from "./state-record.ts";

/**
 * One round as the state file keeps it: what it spent, how long its reviewer ran,
 * and the time bound that ended the reviewer where one did.
 *
 * A file written before the last two were recorded carries neither, so a reader
 * takes neither as given.
 */
export type RoundRecord = RoundCost & {
  /** Wall-clock seconds from starting the reviewer to having it stopped, to a tenth. */
  readonly elapsedSeconds?: number;
  /**
   * The time bound, in whole seconds, where the bound ended a review the reviewer
   * had not finished. Absent on a review that finished on its own, including one
   * that declared itself finished just before the bound.
   */
  readonly cutShortAtSeconds?: number;
};

/** What the rounds of one episode have established so far. */
export type EpisodeState = {
  /**
   * Each round, in the order the rounds ran. Rounds are appended and never
   * edited, so the number of entries is the number of rounds that have run.
   */
  readonly rounds: readonly RoundRecord[];
  /**
   * What the episode spent on attempts that were not rounds.
   *
   * This and the rounds are two ledgers, and they are kept apart because the
   * bounds count different things. The entry count above is what the round cap
   * spends, and a setup problem must not spend one: it fails the same way every
   * firing, so a cap charged for it would leave a project no rounds once it had
   * fixed the thing. Spend is not like that — tokens spent are spent whatever
   * the attempt came to — so it goes here, and the token bound is measured
   * against this as well as against each round. An episode that dropped it could
   * run past a bound it had reached.
   */
  readonly spentOutsideRounds: RoundCost;
  /**
   * Whether a firing of this episode has reported its close: the summary comment
   * posted, or the failure to post it announced.
   *
   * Absent is no, which is what a file written before this field existed says.
   * The rounds alone cannot stand in for it. A firing that finds the bound spent
   * cannot tell an episode whose last round closed it from one whose last round
   * blocked under a cap that has since been lowered, and those two want opposite
   * answers: silence, and a line saying the episode closed with no summary.
   */
  readonly closeReported?: boolean;
  /**
   * What the episode's rounds have established about the worktree they ran in.
   *
   * Here because a round that blocks posts no comment. The summary is composed
   * when the episode closes, and a composer reading the closing round's own
   * readings alone would report the worktree of one round as the worktree of the
   * whole episode.
   *
   * Absent is nothing established, which is what a file written before this field
   * existed says and what an episode every reviewer left alone writes.
   */
  readonly confinement?: ConfinementEvidence;
  /**
   * One record for each state of the pull request a trigger has queued, oldest
   * first. No two are for the same state.
   *
   * Absent is none, which is what a file written before records were kept holds.
   */
  readonly records?: readonly StateRecord[];
};

/**
 * What asking for an episode's state established.
 *
 * `absent` is the first round: nothing has been written under this key.
 * `unreadable` is a failure, and a caller that treats it as a first round
 * restarts the round count on every firing.
 */
export type StateRead =
  | { readonly outcome: "absent" }
  | { readonly outcome: "read"; readonly state: EpisodeState }
  | { readonly outcome: "unreadable"; readonly reason: string };

/** `failed` carries the error the filesystem gave, as one line. */
export type StateWrite =
  | { readonly outcome: "written" }
  | { readonly outcome: "failed"; readonly reason: string };

/**
 * Read the episode's state.
 *
 * Never throws. A missing file is `absent`; a file that will not read, that is
 * not JSON, or that does not hold the fields a state file holds is
 * `unreadable`, carrying the path and what was wrong with it.
 */
export function readState(episode: Episode): StateRead {
  const path = episode.stateFile;

  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (cause) {
    // Only a missing file means no state. A file that is there and will not be
    // read is a failure, and must never read as a first round.
    if (isMissing(cause)) return { outcome: "absent" };
    return unreadable(`${path} could not be read: ${reasonFor(cause)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    // Where a write was killed part way through, this is what it left.
    return unreadable(`${path} is not valid JSON: ${reasonFor(cause)}`);
  }

  return stateFrom(parsed, path);
}

/**
 * Write the episode's state, creating the episode's directory where it is not
 * there yet.
 *
 * Never throws, whatever the filesystem does.
 *
 * A change goes through `updateState`, which calls this under the state lock. A
 * write from anywhere else can drop a record another process wrote since it read.
 */
export function writeState(episode: Episode, state: EpisodeState): StateWrite {
  const path = episode.stateFile;
  // A half-written file reads as unreadable, which stops the episode, so the new
  // state is renamed over the old rather than written in place. A write killed
  // part way through leaves the previous round's file standing.
  const partial = `${path}.${process.pid}.writing`;
  try {
    mkdirSync(episode.directory, { recursive: true });
    writeFileSync(partial, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(partial, path);
    return { outcome: "written" };
  } catch (cause) {
    discard(partial);
    return { outcome: "failed", reason: `${path} could not be written: ${reasonFor(cause)}` };
  }
}

/**
 * The state with one more round on the end.
 *
 * The count of rounds is the count of entries, so a round that spent nothing
 * still appends one.
 */
export function recordRound(state: EpisodeState, round: RoundRecord): EpisodeState {
  return { ...state, rounds: [...state.rounds, round] };
}

/**
 * The state with `cost` added to what the episode spent outside its rounds.
 *
 * The round count does not move. This is where an attempt that was not a round
 * puts what it spent, so that the token bound sees it and the cap does not. A
 * floor added to anything is a floor.
 */
export function recordSpendOutsideRounds(
  state: EpisodeState,
  cost: RoundCost,
): EpisodeState {
  const spent = state.spentOutsideRounds;
  const sum = {
    dollars: spent.dollars + cost.dollars,
    tokens: spent.tokens + cost.tokens,
    messages: spent.messages + cost.messages,
  };
  return {
    ...state,
    spentOutsideRounds: spent.floor === true || cost.floor === true ? { ...sum, floor: true } : sum,
  };
}

function discard(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // The write has already failed and is already being reported. A file left
    // behind is not worth a second failure over.
  }
}

function stateFrom(parsed: unknown, path: string): StateRead {
  if (!isRecord(parsed)) {
    return unreadable(`${path} holds ${render(parsed)} rather than a JSON object`);
  }

  const recorded = parsed["rounds"];
  if (!Array.isArray(recorded)) {
    return unreadable(`${path}: "rounds" is ${render(recorded)} rather than an array`);
  }

  const rounds: RoundRecord[] = [];
  for (const [index, entry] of recorded.entries()) {
    const round = roundFrom(entry);
    if ("problem" in round) {
      return unreadable(`${path}: round ${index + 1} ${round.problem}`);
    }
    rounds.push(round.round);
  }

  const outside = spentOutsideRoundsIn(parsed, path);
  if ("problem" in outside) return unreadable(`${path}: ${outside.problem}`);

  const reported = parsed["closeReported"];
  // Read as no, it would say an episode carrying its comment closed without one.
  // Read as yes, it would leave the next close silent. Neither is a reading.
  if (reported !== undefined && typeof reported !== "boolean") {
    return unreadable(`${path}: "closeReported" is ${render(reported)} rather than true or false`);
  }

  const found = confinementIn(parsed);
  if ("problem" in found) return unreadable(`${path}: ${found.problem}`);

  const kept = recordsIn(parsed);
  if ("problem" in kept) return unreadable(`${path}: ${kept.problem}`);

  return {
    outcome: "read",
    state: {
      rounds,
      spentOutsideRounds: outside.cost,
      ...(reported === undefined ? {} : { closeReported: reported }),
      ...(found.evidence === undefined ? {} : { confinement: found.evidence }),
      ...(kept.records === undefined ? {} : { records: kept.records }),
    },
  };
}

type ReadRecords =
  | { readonly records: readonly StateRecord[] | undefined }
  | { readonly problem: string };

/**
 * The record of each state the file holds.
 *
 * Every record has to read, and no two may be for one state. Either failure makes
 * the whole file unreadable, because the record a reader would be left with
 * could be the wrong one, and a trigger decides from it whether to queue a review.
 */
function recordsIn(parsed: Record<string, unknown>): ReadRecords {
  const found = parsed["records"];
  if (found === undefined) return { records: undefined };
  if (!Array.isArray(found)) return { problem: `"records" is ${render(found)} rather than an array` };

  const records: StateRecord[] = [];
  for (const [index, entry] of found.entries()) {
    const read = recordFrom(entry);
    if ("problem" in read) return { problem: `record ${index + 1} ${read.problem}` };
    if (recordFor(records, read.record) !== undefined) {
      return { problem: `record ${index + 1} is a second record for the state of ${read.record.head}` };
    }
    records.push(read.record);
  }
  return { records };
}

type ReadEvidence =
  | { readonly evidence: ConfinementEvidence | undefined }
  | { readonly problem: string };

/**
 * What the file says the episode's rounds established about the worktree.
 *
 * Absent is nothing established, which is what a file written before this field
 * existed holds. A field that is there and cannot be read is a failure like any
 * other: standing it in for nothing established would say a worktree nothing
 * looked at is one nothing touched, and that is the reading this field exists to
 * stop.
 *
 * A key this reader has no name for is ignored, so a file a later version wrote is
 * still the episode's own.
 */
function confinementIn(parsed: Record<string, unknown>): ReadEvidence {
  const found = parsed["confinement"];
  if (found === undefined) return { evidence: undefined };
  if (!isRecord(found)) {
    return { problem: `"confinement" is ${render(found)} rather than a JSON object` };
  }

  const changed = linesIn(found, "changed");
  if ("problem" in changed) return changed;
  const moved = linesIn(found, "moved");
  if ("problem" in moved) return moved;
  const uncompared = linesIn(found, "uncompared");
  if ("problem" in uncompared) return uncompared;
  const shared = linesIn(found, "shared");
  if ("problem" in shared) return shared;
  const unestablished = linesIn(found, "unestablished");
  if ("problem" in unestablished) return unestablished;

  return {
    evidence: {
      changed: changed.lines,
      moved: moved.lines,
      uncompared: uncompared.lines,
      shared: shared.lines,
      unestablished: unestablished.lines,
    },
  };
}

type ReadLines = { readonly lines: readonly string[] } | { readonly problem: string };

/** One of the lists the field holds, a list that is not there being the empty one. */
function linesIn(found: Record<string, unknown>, name: string): ReadLines {
  const list = found[name];
  if (list === undefined) return { lines: [] };
  if (!isLines(list)) {
    return { problem: `"confinement.${name}" is ${render(list)} rather than an array of strings` };
  }
  return { lines: list };
}

function isLines(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * What the file says was spent outside its rounds.
 *
 * Absent is nothing, which is what a file written before this figure existed
 * means. A figure that is there and cannot be read is a failure like any other:
 * standing it in for zero would understate what the episode has spent, and the
 * token bound would then let it spend past a bound it had reached.
 */
function spentOutsideRoundsIn(parsed: Record<string, unknown>, path: string): ReadCost {
  const spent = parsed["spentOutsideRounds"];
  if (spent === undefined) return { cost: unspent };
  const read = costFrom(spent);
  if ("problem" in read) return { problem: `"spentOutsideRounds" ${read.problem}` };
  return read;
}

type ReadCost = { readonly cost: RoundCost } | { readonly problem: string };

type ReadRound = { readonly round: RoundRecord } | { readonly problem: string };

/**
 * One round's entry: its cost, and whatever timing the file carries for it.
 *
 * Timing that is absent is a file written before it was recorded. Timing that is
 * there and cannot be read is a failure, because the cut it records is what the
 * summary reports, and dropping it would report a review cut short as one that
 * finished.
 */
function roundFrom(entry: unknown): ReadRound {
  const read = costFrom(entry);
  if ("problem" in read) return read;
  if (!isRecord(entry)) return { problem: `is ${render(entry)} rather than a JSON object` };

  const elapsed = entry["elapsedSeconds"];
  if (elapsed !== undefined && !isAmount(elapsed)) {
    return { problem: `has "elapsedSeconds" as ${render(elapsed)}` };
  }
  const cut = entry["cutShortAtSeconds"];
  if (cut !== undefined && !isCount(cut)) {
    return { problem: `has "cutShortAtSeconds" as ${render(cut)}` };
  }

  return {
    round: {
      ...read.cost,
      ...(elapsed === undefined ? {} : { elapsedSeconds: elapsed }),
      ...(cut === undefined ? {} : { cutShortAtSeconds: cut }),
    },
  };
}

function costFrom(entry: unknown): ReadCost {
  if (!isRecord(entry)) return { problem: `is ${render(entry)} rather than a JSON object` };

  const dollars = entry["dollars"];
  if (!isAmount(dollars)) return { problem: `has "dollars" as ${render(dollars)}` };

  const tokens = entry["tokens"];
  if (!isTally(tokens)) return { problem: `has "tokens" as ${render(tokens)}` };

  // The three figures travel together: zero dollars against real tokens is a
  // price the reviewer could not quote, and no messages at all is a round that
  // was killed before one completed.
  const messages = entry["messages"];
  if (!isTally(messages)) return { problem: `has "messages" as ${render(messages)}` };

  const floor = entry["floor"];
  if (floor === undefined) return { cost: { dollars, tokens, messages } };
  if (floor !== true) return { problem: `has "floor" as ${render(floor)}` };
  return { cost: { dollars, tokens, messages, floor } };
}

function unreadable(reason: string): StateRead {
  return { outcome: "unreadable", reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A time bound is whole seconds and at least one, so 0 is a bound nothing has. */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isTally(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function reasonFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Shows the value as it was written, so a string is quoted and a number is not. */
function render(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}
