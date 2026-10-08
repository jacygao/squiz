/**
 * An episode's identity, and the paths it owns inside its worktree.
 *
 * The key is the number of the pull request the episode reviews. This is the
 * module where that number becomes a path component, so the check that makes it
 * safe sits here rather than at each caller: `episodeAt` is the only way to
 * obtain a path under the episode's directory, and nothing but a positive whole
 * number reaches the filesystem as a key.
 *
 * Each round's directory hangs off the episode's own directory and is derived
 * here too. A second place that computed it would be a second place for it to
 * drift from the state file's.
 *
 * Nothing here touches the filesystem. These are paths, not directories.
 */

import { join } from "node:path";

// Everything one worktree's episodes write goes here. It ignores itself in git, and it
// goes with the worktree, so nothing in it outlives the episode.
const episodesDirectory = ".squiz";

const stateFileName = "state.json";

/** How a key is spelled as a directory name, and the only spelling read back as one. */
const keySpelling = /^[1-9][0-9]*$/u;

/** One pull request's rounds, and where everything they write lives. */
export type Episode = {
  /** The git work tree the rounds review, and the root the paths below sit in. */
  readonly worktree: string;
  /** The pull request's number, as the episode's directory spells it. */
  readonly id: string;
  /** `<worktree>/.squiz/<number>`, which holds the whole episode. */
  readonly directory: string;
  /** The pull request, what each round spent, and what was spent outside them. */
  readonly stateFile: string;
};

/**
 * A key that is no pull request's number.
 *
 * The number arrives from GitHub, so reaching this means something handed over a
 * value no pull request has, and the round has no key to hold its state under.
 */
export class EpisodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EpisodeError";
  }
}

/**
 * The episode of pull request `pullRequest`, and every path it owns, inside
 * `worktree`.
 *
 * Throws an `EpisodeError` for anything but a positive whole number a JavaScript
 * number holds exactly. A larger one would be spelled as some other number, or in
 * exponent notation.
 */
export function episodeAt(worktree: string, pullRequest: number): Episode {
  if (typeof pullRequest !== "number" || !Number.isSafeInteger(pullRequest) || pullRequest < 1) {
    throw new EpisodeError(
      `${describe(pullRequest)} is no pull request's number, so no episode is keyed by it`,
    );
  }
  const id = String(pullRequest);
  const directory = join(worktree, episodesDirectory, id);
  return {
    worktree,
    id,
    directory,
    stateFile: join(directory, stateFileName),
  };
}

/**
 * `<worktree>/.squiz/<number>/rounds/<round>`, which holds what one round
 * wrote: its report file, the reviewer's session under `session/` and its
 * `resume.txt`.
 */
export function roundDirectory(episode: Episode, round: number): string {
  return join(episode.directory, "rounds", String(round));
}

/**
 * The episode whose state the directory named `name` holds, or nothing where no
 * key is spelled that way.
 *
 * A name that is not how a key is spelled is nobody's episode, and reading under
 * it would read at paths no episode owns.
 */
export function episodeNamed(worktree: string, name: string): Episode | undefined {
  if (!keySpelling.test(name)) return undefined;
  try {
    return episodeAt(worktree, Number(name));
  } catch {
    return undefined;
  }
}

function describe(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}
