/**
 * Removing the directories of episodes whose change has ended, from the round
 * host once it has released its own.
 *
 * The dangerous direction is removing a live episode, so a directory goes only
 * where both of these were established, and any doubt leaves it:
 *
 * - the venue said its change ended, and did not merely fail to answer;
 * - this process took its host lock, so no round host is running in it.
 *
 * The venue is asked before the lock is taken. A lock held while GitHub is
 * asked would read to a trigger for a pull request still open as a running
 * host, and that trigger would start none for the state it queued.
 *
 * Nothing here throws, and the whole sweep runs under one deadline.
 */

import { lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { episodeAt } from "../loop/episode.ts";
import { deadlineIn, type Deadline } from "../reviewers/deadline.ts";
import type { Venue } from "../venues/venue.ts";
import { identityOf, stillRunning, type Presence, type ProcessIdentity } from "../sessions/process.ts";
import { takeHostLock } from "./lock.ts";

// Each `ps` run that tells whether a lock's holder is still running.
const LOCK_BOUND_MS = 5_000;

// One pull request that GitHub never answers for leaves time to ask about the others.
const ASK_BOUND_MS = 5_000;

export type SweepSetup = {
  readonly worktree: string;
  /** The host's own key, whose episode is never swept. */
  readonly own: string;
  readonly venue: Pick<Venue, "episodeDirectory" | "changeEnded">;
  readonly until: Deadline;
  readonly log: (line: string) => void;
};

/** Remove each other episode's directory in the worktree whose change has ended and whose host is not running. */
export function sweepEnded(setup: SweepSetup): void {
  const { worktree, venue, until, log } = setup;
  let names: string[];
  try {
    names = readdirSync(join(worktree, ".squiz"));
  } catch {
    return;
  }
  const lockBound = (): number => Math.max(1, Math.min(LOCK_BOUND_MS, until.remaining()));
  // Read once, so that no `ps` runs between finding a directory and taking its lock.
  const own = identityOf(process.pid, lockBound());
  if (own.outcome !== "read") return;
  const self = own.identity;
  const presence = (identity: ProcessIdentity): Presence =>
    until.passed() ? { outcome: "unknown", reason: "the sweep's deadline had passed" } : stillRunning(identity, lockBound());
  // Each sweep starts at a random entry, so entries that keep eating the
  // deadline at the front of the listing cannot keep the rest from ever being asked.
  const start = Math.floor(Math.random() * names.length);
  for (const name of [...names.slice(start), ...names.slice(0, start)]) {
    if (until.passed()) return;
    if (name === setup.own || !isDirectory(join(worktree, ".squiz", name))) continue;
    // A directory the venue names no episode for, such as the local venue's under the GitHub venue, is not one to remove.
    const named = episodeAt(venue, worktree, name);
    if (named.outcome === "failed") continue;
    const { directory } = named.episode;

    const ended = venue.changeEnded(worktree, name, deadlineIn(Math.min(ASK_BOUND_MS, until.remaining())));
    if (ended.outcome === "failed") {
      log(`kept ${directory}: whether its change has ended could not be told: ${ended.reason}`);
      continue;
    }
    if (ended.outcome === "open") continue;
    // A worktree removed while GitHub was asked is not made again by taking its lock.
    const taking = takeHostLock(directory, { boundMs: lockBound(), self, presence, existing: true });
    if (taking.outcome === "held") continue;
    if (taking.outcome === "unknown") {
      log(`kept ${directory}: whether its round host is running could not be told: ${taking.reason}`);
      continue;
    }
    try {
      rmSync(directory, { recursive: true, force: true });
      log(`removed ${directory}: PR #${name} is ${ended.how}`);
    } catch (error) {
      log(`${directory} could not be removed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      taking.lock.release();
    }
  }
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}
