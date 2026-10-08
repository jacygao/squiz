/**
 * The lock that keeps an episode to one round host: `host.lock` in the episode's
 * directory, naming the pid and start time of the host that holds it.
 *
 * A host holds it for as long as it runs rounds, and a host that finds it held
 * by a live process exits.
 */

import type { Episode } from "../loop/episode.ts";
import { makeEpisodeDirectory } from "../loop/state-directory.ts";
import { takeLock, type HeldLock, type LockOptions, type Release, type Taking } from "../sessions/lock-file.ts";

export type { Release, Taking };
export type HostLockOptions = LockOptions;
export type HostLock = HeldLock;

/**
 * Take the host lock in `directory`, creating the directory where it is missing.
 *
 * A lock taken is released when the process exits, and before then by `release`.
 * A host killed outright leaves it, naming a holder that has gone, and the next
 * host takes it over.
 */
export function takeHostLock(directory: string, options: HostLockOptions): Taking {
  return takeLock(directory, "host.lock", options);
}

/** Take the host lock in `episode`'s directory, made as every episode's directory is. */
export function takeEpisodeHostLock(episode: Episode, options: HostLockOptions): Taking {
  try {
    makeEpisodeDirectory(episode);
  } catch (error) {
    return { outcome: "unknown", reason: `${episode.directory} could not be made: ${error instanceof Error ? error.message : String(error)}` };
  }
  return takeHostLock(episode.directory, options);
}
