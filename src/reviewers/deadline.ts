/**
 * A moment on the clock, and being told once it has passed.
 *
 * The bound is read from the clock every time rather than slept through. A
 * timer here is only a prompt to look at the clock: one that fires early, late
 * or not at all cannot move the moment, because what decides is the clock
 * against the moment and never the timer's own arithmetic. The wait between
 * looks is capped, so a bound of minutes is never one long sleep, and a look
 * that arrives late is corrected at the next one instead of at the end.
 *
 * This is what stands between a reviewer that has hung and a round that never
 * ends with nothing posted, so it is built to fire late rather than not at all.
 *
 * One thing it cannot do. A timer runs on the event loop's timer phase, and a
 * caller that saturates the loop with microtasks never reaches it: the timer
 * does not fire late there, it does not fire. Work like that is bounded by
 * reading `passed` in the work's own path, and `whenPassed` bounds the silence
 * where there is no work to read it from.
 */

/**
 * The longest a single wait may run before the clock is read again.
 *
 * It bounds how late the passing of the deadline can be noticed, and it is the
 * whole of the cost of a timer that misbehaves.
 */
const LOOK_INTERVAL_MS = 250;

export type Deadline = {
  /** Whether the clock has reached the moment. */
  readonly passed: () => boolean;
  /** Milliseconds left, never below zero. */
  readonly remaining: () => number;
  /**
   * Call `act` once the clock has passed the moment, or at once where it
   * already has. Returns the cancel, which is safe to call more than once and
   * after `act` has run.
   */
  readonly whenPassed: (act: () => void) => () => void;
};

/**
 * A deadline `milliseconds` from now.
 *
 * `now` is the clock, and a caller passes its own only to test what this does
 * when time moves in a way a timer cannot see.
 */
export function deadlineIn(milliseconds: number, now: () => number = Date.now): Deadline {
  return deadlineAt(now() + milliseconds, now);
}

/**
 * A deadline at `at`, a moment on `now`'s clock in milliseconds.
 *
 * It is how a deadline crosses into another process: the moment travels as a
 * number, and both sides read the same wall clock.
 */
export function deadlineAt(at: number, now: () => number = Date.now): Deadline {
  return watched(() => at, now, () => {});
}

/**
 * The longest gap between two looks that is still time the process was running.
 *
 * Looks are at most `LOOK_INTERVAL_MS` apart, so a longer gap is a machine that
 * stopped running anything. Node has no clock that stops while the machine
 * sleeps: on macOS `Date.now()`, `process.hrtime` and the timers all count it.
 */
const SLEPT_GAP_MS = 5_000;

/** A deadline that is not spent while the machine sleeps. */
export type AwakeDeadline = Deadline & {
  /** Milliseconds the machine was seen asleep while the deadline was watched. */
  readonly slept: () => number;
  /** Milliseconds added to the moment for that sleep, at most the deadline's own length. */
  readonly added: () => number;
};

/**
 * A deadline `milliseconds` from now, moved on by the time the machine sleeps.
 *
 * A sleep is seen only as a gap between two of `whenPassed`'s looks, so time
 * asleep while nothing watches the deadline is spent. What is added back is at
 * most `milliseconds`, so the deadline never runs past twice its length.
 */
export function awakeDeadlineIn(milliseconds: number, now: () => number = Date.now): AwakeDeadline {
  const start = now() + milliseconds;
  let slept = 0;
  const added = (): number => Math.min(slept, milliseconds);
  const deadline = watched(() => start + added(), now, (gap) => {
    if (gap > SLEPT_GAP_MS) slept += gap;
  });
  return { ...deadline, slept: () => slept, added };
}

/**
 * A deadline at the moment `at` returns, which `gapped` may move on.
 *
 * `gapped` is told the time since the watch's previous look, before each look
 * after the first decides whether the moment has passed.
 */
function watched(at: () => number, now: () => number, gapped: (gap: number) => void): Deadline {
  const passed = (): boolean => now() >= at();
  const remaining = (): number => Math.max(0, at() - now());

  const whenPassed = (act: () => void): (() => void) => {
    let timer: NodeJS.Timeout | undefined;
    let done = false;
    let lookedAt: number | undefined;
    const look = (): void => {
      if (done) return;
      const looking = now();
      if (lookedAt !== undefined) gapped(looking - lookedAt);
      lookedAt = looking;
      if (passed()) {
        done = true;
        act();
        return;
      }
      timer = setTimeout(look, Math.min(remaining(), LOOK_INTERVAL_MS));
      // An unreferenced timer cannot hold the process open. A cancel that was
      // missed then costs a stray timer rather than a process that never exits.
      timer.unref();
    };
    look();
    return (): void => {
      done = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  };

  return { passed, remaining, whenPassed };
}
