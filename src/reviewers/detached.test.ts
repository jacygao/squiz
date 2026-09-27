import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

import { LOOK_MS, type Process, read, type Table, watchDetached } from "./detached.ts";

/** The reviewer of these tables, which leads its own group as the round starts it. */
const REVIEWER = 4_100;

const started = "Sun Sep 27 13:20:19 2026";

/** The reviewer, a tool it detached, and a stranger that is nobody's business. */
const reviewer: Process = { pid: REVIEWER, parent: 900, group: REVIEWER, started };
const tool: Process = { pid: 4_200, parent: REVIEWER, group: 4_200, started };
const stranger: Process = { pid: 4_900, parent: 1, group: 4_900, started };

test("a tool the reviewer detached is a group of its own to signal", async () => {
  const found = watchDetached(REVIEWER, readings([reviewer, tool, stranger]));
  assert.deepEqual(await found.groups(), [tool.pid]);
  found.stopLooking();
});

/**
 * A tool that stayed in the reviewer's group is already reached by the signal
 * sent to that group, and signalling it a second time as its own would be
 * signalling an identifier no group of it answers to.
 */
test("a tool left in the reviewer's own group is not one of these", async () => {
  const inGroup: Process = { pid: 4_300, parent: REVIEWER, group: REVIEWER, started };
  const found = watchDetached(REVIEWER, readings([reviewer, inGroup]));
  assert.deepEqual(await found.groups(), []);
  found.stopLooking();
});

test("what a detached tool starts is the one group its leader names", async () => {
  const below: Process = { pid: 4_250, parent: tool.pid, group: tool.pid, started };
  const found = watchDetached(REVIEWER, readings([reviewer, tool, below]));
  assert.deepEqual(await found.groups(), [tool.pid]);
  found.stopLooking();
});

/**
 * The reviewer exiting on its own reparents its detached tools to the system, so
 * the second reading has no chain leading back to it. What was recorded while the
 * reviewer was there is what the round then stops.
 */
test("a tool recorded while the reviewer ran is still stopped once it has gone", async () => {
  const orphan: Process = { ...tool, parent: 1 };
  const found = watchDetached(REVIEWER, readings([reviewer, tool], [orphan, stranger]));
  assert.deepEqual(await found.groups(), [tool.pid]);
  assert.deepEqual(await found.groups(), [tool.pid]);
  found.stopLooking();
});

/**
 * Identifiers are reused. A stranger's process killed because a tool's identifier
 * came round again is worse than the tool this exists to stop, so a group is
 * signalled only where the process holding its identifier started when the
 * recorded one started.
 */
test("a reused identifier is not signalled", async () => {
  const reused: Process = { ...tool, parent: 1, started: "Sun Sep 27 14:02:05 2026" };
  const found = watchDetached(REVIEWER, readings([reviewer, tool], [reused]));
  assert.deepEqual(await found.groups(), [tool.pid]);
  assert.deepEqual(
    await found.groups(),
    [],
    "the identifier is another process's now, and this round has no claim on it",
  );
  found.stopLooking();
});

/**
 * A leader gone from the table is either a group that has emptied or one whose
 * members outlived their leader. Neither can be told from the other here, and a
 * signal sent on the second reading of it would be sent to whatever holds the
 * identifier next.
 */
test("a group whose leader has left the table is not signalled", async () => {
  const found = watchDetached(REVIEWER, readings([reviewer, tool], [reviewer]));
  assert.deepEqual(await found.groups(), [tool.pid]);
  assert.deepEqual(await found.groups(), []);
  found.stopLooking();
});

test("a process that is no descendant of the reviewer is never one of these", async () => {
  const found = watchDetached(REVIEWER, readings([reviewer, stranger]));
  assert.deepEqual(await found.groups(), []);
  assert.equal(found.left(), false, "nothing was recorded, so there is nothing to wait for");
  found.stopLooking();
});

test("a table that cannot be read leaves the round nothing to signal", async () => {
  const found = watchDetached(REVIEWER, () => Promise.resolve([]));
  assert.deepEqual(await found.groups(), []);
  found.stopLooking();
});

/**
 * The reading happens as the round runs because the chain of parents is only
 * there while the reviewer is, and it stops when the round stops waiting: a round
 * that has returned must leave nothing reading the process table behind it.
 */
test("the table is read while the reviewer runs, and not once the round has stopped", async () => {
  let readings = 0;
  const counted: Table = () => {
    readings += 1;
    return Promise.resolve([reviewer, tool]);
  };
  const found = watchDetached(REVIEWER, counted);
  await wait(LOOK_MS * 3);
  const whileRunning = readings;
  assert.ok(whileRunning > 0, "the table was never read while the reviewer was running");

  found.stopLooking();
  await wait(LOOK_MS * 3);
  assert.equal(readings, whileRunning, "the table is still being read after the round stopped");
});

test("a line of ps is three identifiers and the moment the process started", () => {
  const listed = ["    1     0     1 Fri Aug 28 00:21:23 2026", "  511     1   511 Fri Aug 28 00:22:22 2026", ""].join("\n");
  assert.deepEqual(read(listed), [
    { pid: 1, parent: 0, group: 1, started: "Fri Aug 28 00:21:23 2026" },
    { pid: 511, parent: 1, group: 511, started: "Fri Aug 28 00:22:22 2026" },
  ]);
});

/**
 * The reading of the process table against the real one, which is the half of
 * this that a table of rows cannot exercise. The child is detached and answers no
 * signal, which is the shape of the tool the round has to reach.
 */
test("a detached child of this process is found in the real process table", async () => {
  const child = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);"],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  const pid = child.pid;
  assert.ok(pid !== undefined, "the child must have started for there to be anything to find");

  const found = watchDetached(process.pid);
  try {
    assert.deepEqual(
      await found.groups(),
      [pid],
      "a detached child leads a group of its own, and nothing of ours names it but this",
    );
    assert.equal(found.left(), true);
  } finally {
    found.stopLooking();
    process.kill(-pid, "SIGKILL");
  }
});

/** A table read one reading at a time, the last of them repeating. */
function readings(...each: readonly (readonly Process[])[]): Table {
  let at = -1;
  return () => {
    at = Math.min(at + 1, each.length - 1);
    return Promise.resolve(each[at] ?? []);
  };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((settle) => {
    setTimeout(settle, milliseconds);
  });
}
