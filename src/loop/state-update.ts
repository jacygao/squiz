/**
 * The one way the episode's state file is changed: take `state.lock` in the
 * episode's directory, read the file, change it, write it, release the lock.
 *
 * Writes are atomic, so a reader needs no lock and never sees half a file. What
 * the lock stops is a lost update. A trigger that read the file, then a round host
 * writing its reviewing record, then the trigger writing its queued record would
 * leave the reviewing record missing, and a dropped record is a review that never
 * runs with nothing saying so.
 *
 * `state.lock` is not `host.lock`. The host lock is held for as long as a host
 * runs rounds, across every review, and a trigger that had to take it to queue a
 * state would wait out the whole round. This lock is held for one update only.
 *
 * A wait for the lock is bounded by the caller's deadline, and one that runs out
 * is a write that failed. Nothing here writes the file without the lock.
 */

import { unspent } from "../reviewers/adapter.ts";
import type { Deadline } from "../reviewers/deadline.ts";
import { takeLock, type HeldLock, type Taking } from "../sessions/lock-file.ts";
import { identityOf, stillRunning, type IdentityRead, type Presence, type ProcessIdentity } from "../sessions/process.ts";
import { type EpisodeState, readState, writeState } from "./episode-state.ts";
import type { Episode } from "./episode.ts";

const LOCK_NAME = "state.lock";

// The pause between looks at a lock held by a live process. Another writer holds
// it for one read and one write, so the wait is short. The jitter keeps two
// waiters from looking in step.
const PAUSE_MS = 5;
const JITTER_MS = 15;

const PS_FLOOR_MS = 2_000;

export type UpdateOptions = {
  /** When to give up waiting for the lock. One already passed still gets one attempt. */
  readonly until: Deadline;
  /** The identity the lock names. Read from `ps` where not given. */
  readonly self?: ProcessIdentity;
  /**
   * Reads this process's identity within `boundMs` where `self` is not given.
   * `identityOf` this process, read once and kept, where not given.
   */
  readonly identify?: (boundMs: number) => IdentityRead;
  /**
   * Whether a holder is still running, asked within `boundMs`. `stillRunning`
   * where not given.
   */
  readonly presence?: (identity: ProcessIdentity, boundMs: number) => Presence;
};

/** `written` carries the state as written, which is `change` applied to the file as it stood under the lock. */
export type StateUpdate =
  | { readonly outcome: "written"; readonly state: EpisodeState }
  | { readonly outcome: "failed"; readonly reason: string };

/**
 * Apply `change` to the episode's state as it stands, under the state lock.
 *
 * A state file that is absent is handed to `change` as the empty state. One that
 * is unreadable is left as it is, and the update fails with the reason.
 *
 * A lock held by a live process, or by one `ps` cannot tell running or gone, is
 * waited on until `until` passes, and the update then fails naming the holder. A
 * lock naming a process that has gone is taken over.
 *
 * Never throws, unless `change` does, and the lock is released either way.
 */
export function updateState(
  episode: Episode,
  change: (state: EpisodeState) => EpisodeState,
  options: UpdateOptions,
): StateUpdate {
  const { until } = options;
  const notWritten = (why: string): StateUpdate => ({
    outcome: "failed",
    reason: `${episode.stateFile} could not be written: ${why}`,
  });

  // A deadline spent before the update began still gets its one attempt, and the
  // floor lets that attempt's `ps` finish: a round records its cost after its
  // window has run out, and a lock no one holds must not refuse it. Decided before
  // anything runs, so time this update spends cannot turn into that allowance.
  // Otherwise each `ps` is bounded by what is left when it runs, since one attempt
  // can ask about several holders.
  const lastAttemptOnly = until.passed();
  const boundMs = (): number => (lastAttemptOnly ? PS_FLOOR_MS : Math.max(1, until.remaining()));
  const expired = (): boolean => !lastAttemptOnly && until.passed();

  const self = options.self ?? ownIdentity(boundMs(), options.identify);
  if ("reason" in self) return notWritten(self.reason);
  const ask = options.presence ?? stillRunning;
  let cutShort = false;
  const presence = (identity: ProcessIdentity): Presence => {
    if (!expired()) return ask(identity, boundMs());
    cutShort = true;
    return { outcome: "unknown", reason: "the deadline passed before it could be asked" };
  };

  // The last answer a holder gave. An attempt the deadline cut short says only that
  // time ran out, so the failure names what the attempt before it found.
  let found: Exclude<Taking, { readonly outcome: "taken" }> | undefined;
  for (;;) {
    cutShort = false;
    const taking = takeLock(episode.directory, LOCK_NAME, { boundMs: boundMs(), self, presence });
    if (taking.outcome === "taken") {
      if (!expired()) return underLock(episode, change, taking.lock);
      // The caller's time for this write has gone, so the lock goes back unused.
      taking.lock.release();
      return notWritten("its lock was taken only after the deadline had passed");
    }
    if (!cutShort || found === undefined) found = taking;
    if (until.passed()) return notWritten(whyNotTaken(found));
    pause(Math.min(until.remaining(), PAUSE_MS + Math.random() * JITTER_MS));
  }
}

function whyNotTaken(taking: Exclude<Taking, { readonly outcome: "taken" }>): string {
  return taking.outcome === "held"
    ? `process ${taking.holder.pid}, started at ${taking.holder.startedAt}, still held its lock`
    : `its lock could not be taken: ${taking.reason}`;
}

function underLock(episode: Episode, change: (state: EpisodeState) => EpisodeState, lock: HeldLock): StateUpdate {
  try {
    const found = readState(episode);
    if (found.outcome === "unreadable") return { outcome: "failed", reason: found.reason };
    const state = change(found.outcome === "read" ? found.state : { rounds: [], spentOutsideRounds: unspent });
    const written = writeState(episode, state);
    return written.outcome === "written" ? { outcome: "written", state } : written;
  } finally {
    // A lock this fails to remove names this process, so the next writer waits
    // until it exits, when the exit handler removes it.
    lock.release();
  }
}

let own: ProcessIdentity | undefined;

/**
 * This process's identity. Read from `ps` once and kept, because it cannot
 * change. An `identify` the caller gives is asked every time.
 */
function ownIdentity(
  boundMs: number,
  identify?: (boundMs: number) => IdentityRead,
): ProcessIdentity | { readonly reason: string } {
  if (identify === undefined && own !== undefined) return own;
  const read = (identify ?? ((bound: number) => identityOf(process.pid, bound)))(boundMs);
  if (read.outcome === "read") {
    if (identify === undefined) own = read.identity;
    return read.identity;
  }
  return { reason: `this process's own start time could not be read: ${read.outcome === "unknown" ? read.reason : "ps says it is gone"}` };
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** Block for `milliseconds`. Every caller of the state file is synchronous. */
function pause(milliseconds: number): void {
  Atomics.wait(sleeper, 0, 0, milliseconds);
}
