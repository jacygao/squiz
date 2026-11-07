/**
 * An episode's identity, and the paths it owns.
 *
 * The key is the change's, and the venue names the directory it keys. This is
 * the only place that asks the venue for it, so the hook, the round host and
 * the commands all reach the one directory, and no caller builds the path from
 * the key itself.
 *
 * Each round's directory hangs off the episode's own directory and is derived
 * here too. A second place that computed it would be a second place for it to
 * drift from the state file's.
 *
 * Nothing here touches the filesystem. These are paths, not directories.
 */

import { join } from "node:path";

import type { Failed, Venue } from "../venues/venue.ts";

const stateFileName = "state.json";

/** One change's rounds, and where everything they write lives. */
export type Episode = {
  /** The git work tree the rounds review. */
  readonly worktree: string;
  /** The change's key, which names the episode across processes. */
  readonly key: string;
  /** The directory the venue names for the key, which holds the whole episode. */
  readonly directory: string;
  /** The change, what each round spent, and what was spent outside them. */
  readonly stateFile: string;
};

/**
 * The episode `key` names in `worktree`, in the directory `venue` gives it, or
 * the venue's reason for giving it none.
 */
export function episodeAt(
  venue: Pick<Venue, "episodeDirectory">,
  worktree: string,
  key: string,
): { readonly outcome: "found"; readonly episode: Episode } | Failed {
  const named = venue.episodeDirectory(worktree, key);
  if (named.outcome !== "found") return named;
  const { directory } = named;
  return { outcome: "found", episode: { worktree, key, directory, stateFile: join(directory, stateFileName) } };
}

/**
 * `<episode>/rounds/<round>`, which holds what one round wrote: its report
 * file, the reviewer's session under `session/` and its `resume.txt`.
 */
export function roundDirectory(episode: Episode, round: number): string {
  return join(episode.directory, "rounds", String(round));
}
