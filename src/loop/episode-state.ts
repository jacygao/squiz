/**
 * The episode's state file: the pull request its rounds review, and what each
 * round spent.
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
import type { Episode } from "./episode.ts";

/** What the rounds of one episode have established so far. */
export type EpisodeState = {
  /** The pull request every round of this episode reviews. */
  readonly pullRequest: number;
  /**
   * What each round spent, in the order the rounds ran. Rounds are appended and
   * never edited, so the number of entries is the number of rounds that have
   * run.
   */
  readonly rounds: readonly RoundCost[];
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
 * The state with one more round's spend on the end.
 *
 * The count of rounds is the count of entries, so a round that spent nothing
 * still appends one.
 */
export function recordRound(state: EpisodeState, cost: RoundCost): EpisodeState {
  return { ...state, rounds: [...state.rounds, cost] };
}

/**
 * The state with `cost` added to what the episode spent outside its rounds.
 *
 * The round count does not move. This is where an attempt that was not a round
 * puts what it spent, so that the token bound sees it and the cap does not.
 */
export function recordSpendOutsideRounds(
  state: EpisodeState,
  cost: RoundCost,
): EpisodeState {
  const spent = state.spentOutsideRounds;
  return {
    ...state,
    spentOutsideRounds: {
      dollars: spent.dollars + cost.dollars,
      tokens: spent.tokens + cost.tokens,
      messages: spent.messages + cost.messages,
    },
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

  const pullRequest = parsed["pullRequest"];
  if (!isCount(pullRequest)) {
    return unreadable(
      `${path}: "pullRequest" is ${render(pullRequest)} rather than a pull request number`,
    );
  }

  const recorded = parsed["rounds"];
  if (!Array.isArray(recorded)) {
    return unreadable(`${path}: "rounds" is ${render(recorded)} rather than an array`);
  }

  const rounds: RoundCost[] = [];
  for (const [index, entry] of recorded.entries()) {
    const round = costFrom(entry);
    if ("problem" in round) {
      return unreadable(`${path}: round ${index + 1} ${round.problem}`);
    }
    rounds.push(round.cost);
  }

  const outside = spentOutsideRoundsIn(parsed, path);
  if ("problem" in outside) return unreadable(`${path}: ${outside.problem}`);

  return { outcome: "read", state: { pullRequest, rounds, spentOutsideRounds: outside.cost } };
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

  return { cost: { dollars, tokens, messages } };
}

function unreadable(reason: string): StateRead {
  return { outcome: "unreadable", reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A pull request is numbered from 1, so 0 is a number nothing has. */
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
