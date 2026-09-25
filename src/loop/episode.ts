/**
 * An episode's identity, and the paths it owns inside its worktree.
 *
 * The key is the subagent's id, which the harness reads from a hook payload
 * rather than generating, so nothing about it is trusted. This is the module
 * where that string becomes a path component, so the strip that makes it safe
 * sits here rather than at each caller: `episodeAt` is the only way to obtain a
 * path under the episode's directory, and no code path can reach the filesystem
 * with an id as it arrived.
 *
 * The reviewer's session directory and its scratch space hang off the episode's
 * own directory and are derived here too. A second place that computed them
 * would be a second place for them to drift from the state file's.
 *
 * Nothing here touches the filesystem. These are paths, not directories.
 */

import { join } from "node:path";

// Everything one worktree's episodes write goes here. It is gitignored, and it
// goes with the worktree, so nothing in it outlives the episode.
const episodesDirectory = ".squiz";

const stateFileName = "state.json";

/**
 * What an episode's directory name may be made of: lowercase hexadecimal, which
 * is every character any id the runtime has been seen to emit is made of. Every
 * other character is dropped, so a separator, a dot, a null byte or a control
 * character cannot reach the filesystem.
 *
 * Two ids differing only outside this set would share one directory. No id seen
 * from the runtime holds a character outside it.
 */
const unsafeCharacters = /[^0-9a-f]/gu;

/**
 * Characters of the id kept. A name longer than 255 bytes is rejected by the
 * filesystem rather than here, and an id anywhere near this bound is nothing
 * like the seventeen characters the runtime emits.
 */
const nameLimit = 64;

/** One pull request's rounds, and where everything they write lives. */
export type Episode = {
  /** The git work tree the rounds review, and the root the paths below sit in. */
  readonly worktree: string;
  /** The subagent's id, stripped to what a directory name may hold. */
  readonly id: string;
  /** `<worktree>/.squiz/<id>`, which holds the whole episode. */
  readonly directory: string;
  /** The pull request, what each round spent, and what was spent outside them. */
  readonly stateFile: string;
  /** What the reviewer's CLI is told to write its own session into. */
  readonly sessionDirectory: string;
  /**
   * What `TMPDIR` points at while the reviewer runs, so that a probe script or
   * a temporary file cannot land in the tree under review.
   */
  readonly scratchDirectory: string;
};

/**
 * A subagent id that no directory name can be made of.
 *
 * Reaching this means the payload's id is nothing like the ones the runtime has
 * emitted, so the round has no key to hold its state under and cannot run.
 */
export class EpisodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EpisodeError";
  }
}

/**
 * The episode `agentId` keys, and every path it owns, inside `worktree`.
 *
 * Throws an `EpisodeError` where the id holds no character a directory name may
 * be made of. Every other id, whatever it arrived as, yields paths under
 * `<worktree>/.squiz/`.
 */
export function episodeAt(worktree: string, agentId: string): Episode {
  const id = safeName(agentId);
  const directory = join(worktree, episodesDirectory, id);
  return {
    worktree,
    id,
    directory,
    stateFile: join(directory, stateFileName),
    sessionDirectory: join(directory, "session"),
    scratchDirectory: join(directory, "scratch"),
  };
}

function safeName(agentId: string): string {
  const stripped = agentId.replace(unsafeCharacters, "").slice(0, nameLimit);
  if (stripped === "") {
    throw new EpisodeError(
      `the subagent's id ${JSON.stringify(agentId)} holds no character a directory name may be made of`,
    );
  }
  return stripped;
}
