/**
 * The retry schedule a failed send waits out before it is tried again.
 *
 * Backoff doubles each attempt and is capped, so a queue that cannot reach the
 * server stops hammering it without giving up on the message.
 */

export type Attempt = {
  readonly attempt: number;
  readonly waitMs: number;
};

const FIRST_WAIT_MS = 250;
const MAX_WAIT_MS = 30_000;

/** The wait before attempt `n`, counting from 1. Capped at `MAX_WAIT_MS`. */
export function waitFor(attempt: number): number {
  return Math.min(FIRST_WAIT_MS * 2 ** (attempt - 1), MAX_WAIT_MS);
}

/**
 * The schedule for a message, up to and including its last attempt.
 *
 * The last entry is the wait before the final attempt, so a caller can sum the
 * schedule to learn how long a message may take before it is abandoned.
 */
export function scheduleFor(attempts: number): Attempt[] {
  const schedule: Attempt[] = [];
  for (let attempt = 1; attempt < attempts; attempt++) {
    schedule.push({ attempt, waitMs: waitFor(attempt) });
  }
  return schedule;
}
