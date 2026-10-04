import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";

import { identityOf, type Presence, type ProcessIdentity } from "../sessions/process.ts";
import { takeHostLock, type Taking } from "./lock.ts";

const BOUND_MS = 5_000;
const RACERS = 6;
const ROUNDS = 40;

function ownIdentity(): ProcessIdentity {
  const read = identityOf(process.pid, BOUND_MS);
  assert.equal(read.outcome, "read", `this process's identity was not read: ${JSON.stringify(read)}`);
  return read.outcome === "read" ? read.identity : { pid: 0, startedAt: 0 };
}

/** This process's pid with a start time it did not start at, which `ps` reads as gone. */
function goneIdentity(): ProcessIdentity {
  return { pid: process.pid, startedAt: ownIdentity().startedAt - 1_000 };
}

function lockText(identity: ProcessIdentity): string {
  return `${JSON.stringify({ pid: identity.pid, startedAt: identity.startedAt })}\n`;
}

function withDirectory<T>(body: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "squiz-host-lock-"));
  try {
    return body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertTaken(taking: Taking): asserts taking is Extract<Taking, { outcome: "taken" }> {
  assert.equal(taking.outcome, "taken", `taken as ${JSON.stringify(taking)}`);
}

test("a host takes a lock no one holds, and the lock names its pid and start time", () => {
  withDirectory((directory) => {
    const self = ownIdentity();
    const taking = takeHostLock(directory, { boundMs: BOUND_MS });

    assertTaken(taking);
    try {
      assert.equal(taking.lock.path, join(directory, "host.lock"));
      assert.deepEqual(JSON.parse(readFileSync(join(directory, "host.lock"), "utf8")), self);
    } finally {
      taking.lock.release();
    }
  });
});

test("a host that finds the lock held by a live process is told who holds it, and the lock is left alone", () => {
  withDirectory((directory) => {
    const holder = ownIdentity();
    const path = join(directory, "host.lock");
    writeFileSync(path, lockText(holder));

    const taking = takeHostLock(directory, { boundMs: BOUND_MS, self: { pid: 1, startedAt: 1 } });

    assert.deepEqual(taking, { outcome: "held", holder });
    assert.equal(readFileSync(path, "utf8"), lockText(holder));
  });
});

test("a lock naming a process that has gone is taken over", () => {
  withDirectory((directory) => {
    const self = ownIdentity();
    writeFileSync(join(directory, "host.lock"), lockText(goneIdentity()));

    const taking = takeHostLock(directory, { boundMs: BOUND_MS });

    assertTaken(taking);
    try {
      assert.deepEqual(JSON.parse(readFileSync(join(directory, "host.lock"), "utf8")), self);
    } finally {
      taking.lock.release();
    }
  });
});

test("a lock whose holder could not be told running or gone is left alone, and the reason is given", () => {
  withDirectory((directory) => {
    const holder = goneIdentity();
    const path = join(directory, "host.lock");
    writeFileSync(path, lockText(holder));
    const unknown = (): Presence => ({ outcome: "unknown", reason: "ps could not be run" });

    const taking = takeHostLock(directory, { boundMs: BOUND_MS, presence: unknown });

    assert.equal(taking.outcome, "unknown", `taken as ${JSON.stringify(taking)}`);
    assert.match(taking.outcome === "unknown" ? taking.reason : "", /ps could not be run/u);
    assert.equal(readFileSync(path, "utf8"), lockText(holder));
  });
});

for (const [name, text] of [
  ["empty", ""],
  ["cut off mid-write", '{"pid":4321,"start'],
  ["missing its start time", '{"pid":4321}\n'],
] as const) {
  test(`a lock that is ${name} is left alone, because nothing says its writer has gone`, () => {
    withDirectory((directory) => {
      const path = join(directory, "host.lock");
      writeFileSync(path, text);

      const taking = takeHostLock(directory, { boundMs: BOUND_MS });

      assert.equal(taking.outcome, "unknown", `taken as ${JSON.stringify(taking)}`);
      assert.match(taking.outcome === "unknown" ? taking.reason : "", /host\.lock/u);
      assert.equal(readFileSync(path, "utf8"), text);
    });
  });
}

test("what a host killed before its lock had a name left behind does not stop the next host", () => {
  withDirectory((directory) => {
    writeFileSync(join(directory, "host.lock.4321.0f1e2d3c.tmp"), '{"pid":43');

    const taking = takeHostLock(directory, { boundMs: BOUND_MS });

    assertTaken(taking);
    taking.lock.release();
  });
});

test("release removes the lock this host holds", () => {
  withDirectory((directory) => {
    const taking = takeHostLock(directory, { boundMs: BOUND_MS });
    assertTaken(taking);

    assert.deepEqual(taking.lock.release(), { outcome: "released" });
    assert.equal(existsSync(join(directory, "host.lock")), false);
  });
});

test("release leaves alone a lock another host took over while this one ran", () => {
  withDirectory((directory) => {
    const taking = takeHostLock(directory, { boundMs: BOUND_MS });
    assertTaken(taking);
    const path = join(directory, "host.lock");
    const successor = lockText({ pid: 1, startedAt: 1 });
    rmSync(path);
    writeFileSync(path, successor);

    assert.deepEqual(taking.lock.release(), { outcome: "lost" });
    assert.equal(readFileSync(path, "utf8"), successor);
  });
});

test("a takeover left unfinished by a taker that died is finished by the next host", () => {
  withDirectory((directory) => {
    const stale = goneIdentity();
    const taker = { pid: process.pid, startedAt: stale.startedAt - 1 };
    writeFileSync(join(directory, "host.lock"), lockText(stale));
    // The claim a taker holds while it replaces the lock naming `stale`.
    writeFileSync(join(directory, `host.lock.${stale.pid}-${stale.startedAt}.claim`), lockText(taker));

    const taking = takeHostLock(directory, { boundMs: BOUND_MS });

    assertTaken(taking);
    taking.lock.release();
    assert.deepEqual(readdirSync(directory), []);
  });
});

test("a host that finds a live taker replacing a dead holder's lock is told the taker holds it", () => {
  withDirectory((directory) => {
    const stale = { pid: 4321, startedAt: 1 };
    const taker = { pid: 4322, startedAt: 2 };
    writeFileSync(join(directory, "host.lock"), lockText(stale));
    writeFileSync(join(directory, `host.lock.${stale.pid}-${stale.startedAt}.claim`), lockText(taker));
    const presence = (identity: ProcessIdentity): Presence =>
      identity.pid === taker.pid ? { outcome: "running" } : { outcome: "gone" };

    const taking = takeHostLock(directory, { boundMs: BOUND_MS, presence });

    assert.deepEqual(taking, { outcome: "held", holder: taker });
    assert.equal(readFileSync(join(directory, "host.lock"), "utf8"), lockText(stale));
  });
});

/** A racer process, and the lines it prints, one at a time. */
type Racer = { readonly child: ChildProcess; readonly next: () => Promise<string> };

function startRacer(): Racer {
  const child = spawn(process.execPath, [join(import.meta.dirname, "lock-racer.ts")], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
  return {
    child,
    next: async () => {
      const line = await lines.next();
      assert.equal(line.done, false, "a racer exited before it answered");
      return String(line.value);
    },
  };
}

async function stopRacer(racer: Racer): Promise<number | null> {
  const exited = new Promise<number | null>((resolve) => racer.child.once("exit", resolve));
  racer.child.stdin!.end();
  return exited;
}

/**
 * Race `RACERS` processes for the lock in each of `ROUNDS` fresh directories,
 * each prepared by `prepare`, and return how many took it in each round.
 */
async function race(prepare: (directory: string) => void): Promise<readonly number[]> {
  const root = mkdtempSync(join(tmpdir(), "squiz-host-lock-race-"));
  const racers = Array.from({ length: RACERS }, startRacer);
  try {
    for (const racer of racers) assert.equal(await racer.next(), "ready");
    const winners: number[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const directory = join(root, String(round));
      prepare(directory);
      const at = Date.now() + 50;
      for (const racer of racers) racer.child.stdin!.write(`${directory}\t${at}\n`);
      const outcomes = await Promise.all(racers.map((racer) => racer.next()));
      for (const outcome of outcomes) assert.match(outcome, /\t(taken|held)$/u, `a racer answered ${outcome}`);
      winners.push(outcomes.filter((outcome) => outcome.endsWith("\ttaken")).length);
    }
    return winners;
  } finally {
    await Promise.all(racers.map(stopRacer));
    rmSync(root, { recursive: true, force: true });
  }
}

test("of hosts racing for a lock no one holds, exactly one takes it", { timeout: 120_000 }, async () => {
  const winners = await race((directory) => {
    rmSync(directory, { recursive: true, force: true });
  });

  assert.deepEqual(winners, Array(ROUNDS).fill(1), "the number of hosts that took the lock, round by round");
});

test("of hosts racing to take over a dead holder's lock, exactly one takes it", { timeout: 120_000 }, async () => {
  const stale = lockText(goneIdentity());
  const winners = await race((directory) => {
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory);
    writeFileSync(join(directory, "host.lock"), stale);
  });

  assert.deepEqual(winners, Array(ROUNDS).fill(1), "the number of hosts that took the lock, round by round");
});

test("a host that exits releases its lock", { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "squiz-host-lock-"));
  const racer = startRacer();
  try {
    assert.equal(await racer.next(), "ready");
    racer.child.stdin!.write(`${directory}\t0\n`);
    assert.equal(await racer.next(), `${directory}\ttaken`);
    assert.equal(existsSync(join(directory, "host.lock")), true);

    assert.equal(await stopRacer(racer), 0);
    assert.equal(existsSync(join(directory, "host.lock")), false);
  } finally {
    racer.child.kill();
    rmSync(directory, { recursive: true, force: true });
  }
});
