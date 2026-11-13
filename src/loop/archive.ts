/**
 * The closed episodes of one episode's directory, each kept under
 * `episodes/<n>/` once a new episode starts in its place.
 *
 * An archive holds what belonged to the closed episode alone: its state file,
 * its rounds, its summary file and its `closed.json`. Everything else in the directory belongs to
 * the worktree, and stays where it is: the local venue's base and objects, which
 * the next head is built from, its threads, whose ids keep counting, its failure
 * files, the notes and `host.log`. Moving any of those would make the next
 * episode's diff, thread ids or wake wrong with nothing saying so.
 *
 * Nothing here takes `state.lock`. The caller archives inside the update that
 * starts the new episode, so the archive and the new state file are one change.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { unspent } from "../reviewers/adapter.ts";
import { closedRecords, type EpisodeState } from "./episode-state.ts";
import type { Episode } from "./episode.ts";

const ARCHIVES = "episodes";
const ROUNDS = "rounds";
const STATE_FILE = "state.json";
// The local venue's summary. A venue that posts its summary elsewhere has none.
const SUMMARY_FILE = "summary.md";
// The close a headless run waits on. An episode whose run was not headless has none.
export const CLOSE_FILE = "closed.json";

export type Archived =
  | { readonly outcome: "archived"; readonly directory: string }
  | { readonly outcome: "failed"; readonly reason: string };

/**
 * Write `closed` as the state file of the next archive under `episode`, and move
 * the episode's rounds, summary file and `closed.json` into it.
 *
 * The state file `episode` names is left for the caller to replace. Each
 * round's `resume.txt` is rewritten to name its session where it now is.
 * Never throws. A failure part way leaves what had moved in the archive.
 */
export function archiveEpisode(episode: Episode, closed: EpisodeState): Archived {
  try {
    const archives = join(episode.directory, ARCHIVES);
    mkdirSync(archives, { recursive: true });
    const directory = join(archives, String(highestIn(archives) + 1));
    // Not recursive: an archive already there is one this would overwrite.
    mkdirSync(directory);
    writeFileSync(join(directory, STATE_FILE), `${JSON.stringify(closed, null, 2)}\n`, "utf8");

    const rounds = join(episode.directory, ROUNDS);
    if (existsSync(rounds)) {
      const moved = join(directory, ROUNDS);
      renameSync(rounds, moved);
      respell(moved, `${relative(episode.worktree, rounds)}/`, `${relative(episode.worktree, moved)}/`);
    }
    for (const file of [SUMMARY_FILE, CLOSE_FILE]) {
      const path = join(episode.directory, file);
      if (existsSync(path)) renameSync(path, join(directory, file));
    }
    return { outcome: "archived", directory };
  } catch (cause) {
    return { outcome: "failed", reason: `the closed episode could not be archived: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
}

export type NextEpisode =
  | { readonly outcome: "started"; readonly state: EpisodeState; readonly directory: string }
  | { readonly outcome: "failed"; readonly reason: string };

/**
 * Archive the clean-closed episode `state` holds, and give the state file of the
 * episode that follows it.
 *
 * The archive holds the closed episode's own records, in their order. The next
 * episode holds every record queued after the close, in theirs, with no rounds
 * and nothing spent, so it has its own round cap and token bound. The rulings
 * carry over, because the threads they rule on stay on the change.
 */
export function startNextEpisode(episode: Episode, state: EpisodeState): NextEpisode {
  const closed = closedRecords(state);
  const archived = archiveEpisode(episode, { ...state, records: closed });
  if (archived.outcome === "failed") return archived;
  const records = (state.records ?? []).slice(closed.length);
  const next: EpisodeState = { rounds: [], spentOutsideRounds: unspent, ...(state.rulings === undefined ? {} : { rulings: state.rulings }), records };
  return { outcome: "started", state: next, directory: archived.directory };
}

/**
 * Each closed episode archived under `episode`, oldest first, as an episode of
 * its own whose state file and rounds are read as a live one's are.
 *
 * None where nothing was archived. Archives that are there and cannot be
 * listed are a failure, because reading them as none hides every closed episode.
 */
export function archivedEpisodes(episode: Episode): ArchivesListing {
  const archives = join(episode.directory, ARCHIVES);
  let numbers: number[];
  try {
    numbers = numbersIn(archives);
  } catch (cause) {
    return { outcome: "failed", reason: `${archives} could not be listed: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  const episodes = numbers
    .sort((one, other) => one - other)
    .map((number) => {
      const directory = join(archives, String(number));
      return { worktree: episode.worktree, key: episode.key, directory, stateFile: join(directory, STATE_FILE) };
    });
  return { outcome: "listed", episodes };
}

export type ArchivesListing =
  | { readonly outcome: "listed"; readonly episodes: readonly Episode[] }
  | { readonly outcome: "failed"; readonly reason: string };

function highestIn(archives: string): number {
  return Math.max(0, ...numbersIn(archives));
}

/** The archives' numbers, none where there is no archive directory. Throws what any other failure to list it throws. */
function numbersIn(archives: string): number[] {
  let names: string[];
  try {
    names = readdirSync(archives);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return [];
    throw cause;
  }
  return names.filter((name) => /^[1-9][0-9]*$/u.test(name)).map(Number);
}

/**
 * Rewrite each round's `resume.txt` under `rounds` to name `now` where it named
 * `was`. Both are relative to the worktree, as the round wrote them.
 */
function respell(rounds: string, was: string, now: string): void {
  for (const round of readdirSync(rounds)) {
    const file = join(rounds, round, "resume.txt");
    if (!existsSync(file)) continue;
    writeFileSync(file, readFileSync(file, "utf8").replaceAll(was, now), "utf8");
  }
}
