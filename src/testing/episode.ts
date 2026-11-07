/** The episode the GitHub venue names for a pull request, for a test that needs its paths. */

import { episodeAt, type Episode } from "../loop/episode.ts";
import { githubVenue } from "../venues/github/venue.ts";

/** Throws where the venue names no episode, which only a key that is no pull request's number does. */
export function githubEpisode(worktree: string, pullRequest: number | string): Episode {
  const found = episodeAt(githubVenue, worktree, String(pullRequest));
  if (found.outcome !== "found") throw new Error(found.reason);
  return found.episode;
}
