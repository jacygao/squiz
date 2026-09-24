import assert from "node:assert/strict";
import { test } from "node:test";

import { deadlineIn } from "./deadline.ts";

/**
 * How long a test waits for a bound of 150 ms before calling it unfired.
 *
 * Generous, because what is being proved is that the bound fires at all. A
 * mechanism that fires late is a late round; one that does not fire is the hook
 * killed by the runtime with nothing posted.
 */
const PATIENCE_MS = 10_000;

test("a deadline already in the past fires at once", () => {
  let fired = false;
  deadlineIn(0).whenPassed(() => {
    fired = true;
  });
  assert.ok(fired, "a bound of no time at all has already passed when it is armed");
});

test("cancelling before the moment stops it firing", async () => {
  let fired = false;
  const cancel = deadlineIn(20).whenPassed(() => {
    fired = true;
  });
  cancel();
  await forMilliseconds(200);
  assert.ok(!fired, "a cancelled bound must not fire");
});

test("cancelling after it has fired changes nothing", async () => {
  let fired = 0;
  const bound = deadlineIn(10);
  const cancel = bound.whenPassed(() => {
    fired += 1;
  });
  await forMilliseconds(200);
  cancel();
  cancel();
  await forMilliseconds(50);
  assert.equal(fired, 1);
});

test("the time left never runs below zero", async () => {
  const bound = deadlineIn(10);
  await forMilliseconds(100);
  assert.equal(bound.remaining(), 0);
  assert.ok(bound.passed());
});

/**
 * The bound with the loop busy with the work a round actually does.
 *
 * A reviewer that is running is tens of megabytes arriving in chunks, which is
 * the loop's turn taken hundreds of thousands of times. The bound has to fire
 * in the middle of that rather than after it.
 */
test("the bound fires with the event loop saturated", async () => {
  const anchor = keepTheLoopOpen();
  try {
    const startedAt = Date.now();
    let firedAt = 0;
    deadlineIn(150).whenPassed(() => {
      firedAt = Date.now();
    });

    while (Date.now() - startedAt < 1_500) await aTurnOfWork();

    assert.notEqual(firedAt, 0, "the bound did not fire while the loop was busy");
    assert.ok(
      firedAt - startedAt >= 150,
      `the bound fired ${firedAt - startedAt}ms in, which is before the moment it was set for`,
    );
    assert.ok(
      firedAt - startedAt < 1_000,
      `the bound fired ${firedAt - startedAt}ms in, which is long after the 150ms it was set for`,
    );
  } finally {
    clearInterval(anchor);
  }
});

/**
 * The bound with the loop blocked outright, which no timer can run through.
 *
 * It fires as soon as the loop is free again rather than being pushed out by
 * the time it spent blocked.
 */
test("the bound fires once a blocked loop is free again", async () => {
  const anchor = keepTheLoopOpen();
  try {
    const startedAt = Date.now();
    const fired = new Promise<number>((settle) => {
      deadlineIn(100).whenPassed(() => settle(Date.now()));
    });

    while (Date.now() - startedAt < 500) {
      // Nothing is awaited: the loop cannot run a timer until this returns.
    }

    const firedAt = await Promise.race([fired, after(PATIENCE_MS, 0)]);
    assert.notEqual(firedAt, 0, "the bound did not fire after the loop was released");
    assert.ok(
      firedAt - startedAt < 1_000,
      `the bound fired ${firedAt - startedAt}ms in, rather than as soon as the loop was free`,
    );
  } finally {
    clearInterval(anchor);
  }
});

/**
 * A wait that ran far past what it was set for, which is this machine's
 * `sleep 480` returning after 2,269 seconds.
 *
 * The clock is what decides, so the bound is passed the moment the wait next
 * looks at it. A bound that slept through its own length would still be asleep
 * here, and this test would time out rather than fail.
 */
test("a wait that ran long fires at the next look rather than at the end of it", async () => {
  const anchor = keepTheLoopOpen();
  try {
    let clock = 1_000_000;
    const bound = deadlineIn(420_000, () => clock);
    const fired = new Promise<boolean>((settle) => {
      bound.whenPassed(() => settle(true));
    });

    clock += 500_000;

    const startedAt = Date.now();
    assert.ok(await Promise.race([fired, after(PATIENCE_MS, false)]), "the bound never fired");
    assert.ok(
      Date.now() - startedAt < 5_000,
      "the bound waited out its own length rather than reading the clock again",
    );
  } finally {
    clearInterval(anchor);
  }
});

/**
 * What a timer cannot do, which is why the round reads `passed` as well.
 *
 * A loop that yields only to microtasks never reaches the phase timers run on.
 * The timer does not fire late there; it does not fire, and a bound resting on
 * it alone would be no bound at all over work of that shape.
 */
test("a loop that yields to nothing is not bounded by a timer", async () => {
  const anchor = keepTheLoopOpen();
  try {
    const startedAt = Date.now();
    const bound = deadlineIn(100);
    let fired = false;
    bound.whenPassed(() => {
      fired = true;
    });

    while (Date.now() - startedAt < 600) await Promise.resolve();

    assert.ok(!fired, "a timer that fires under microtask starvation would be news");
    assert.ok(bound.passed(), "reading the clock in the work's own path is what does bound it");
  } finally {
    clearInterval(anchor);
  }
});

/**
 * A handle that holds the process open.
 *
 * The bound's own timer is unreferenced, so that a cancel that was missed
 * cannot keep the harness alive. That leaves a test whose only pending work is
 * the bound with nothing to stop the process exiting under it.
 */
function keepTheLoopOpen(): NodeJS.Timeout {
  return setInterval(() => {}, 1_000);
}

function forMilliseconds(milliseconds: number): Promise<void> {
  return new Promise((settle) => {
    setTimeout(settle, milliseconds);
  });
}

function after<T>(milliseconds: number, value: T): Promise<T> {
  return new Promise((settle) => {
    setTimeout(() => settle(value), milliseconds).unref();
  });
}

/**
 * Work of the size one chunk of the reviewer's output costs to read, and the
 * turn of the loop that delivering the next one takes.
 */
async function aTurnOfWork(): Promise<void> {
  let held = "";
  for (let at = 0; at < 200; at += 1) {
    held = JSON.stringify({ type: "message_update", delta: `step ${at}`, held: held.length });
  }
  assert.ok(held.length > 0);
  await new Promise((settle) => setImmediate(settle));
}
