import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import { deadlineIn } from "../reviewers/deadline.ts";
import { identityOf, type IdentityRead, type Presence, type ProcessIdentity } from "../sessions/process.ts";
import { type EpisodeState, readState } from "./episode-state.ts";
import { type Episode, episodeAt } from "./episode.ts";
import { putRecord } from "./state-record.ts";
import { updateState } from "./state-update.ts";

const pullRequest = 142;

// Far longer than any wait these tests make, so no load on the machine reaches it.
// A test whose claim is about time runs on a clock of its own instead.
const LONG_MS = 120_000;

/** A worktree of its own, holding one episode, removed when the test ends. */
function episodeIn(t: TestContext): Episode {
  const worktree = mkdtempSync(join(tmpdir(), "squiz-state-update-"));
  t.after(() => rmSync(worktree, { recursive: true, force: true }));
  return episodeAt(worktree, pullRequest);
}

/** Run one racer to its end, and return what it printed: how many of its updates failed. */
function racer(episode: Episode, label: string, count: number, status: string, at: number): Promise<string> {
  const child = spawn(
    process.execPath,
    [join(import.meta.dirname, "state-update-racer.ts"), episode.worktree, String(pullRequest), label, String(count), status, String(at)],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  let printed = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (printed += chunk));
  return new Promise((resolve) => child.once("exit", (code) => resolve(`exit ${code}, failed ${printed.trim()}`)));
}

test("a trigger queueing states while the round host records others as reviewing loses none of them", { timeout: 120_000 }, async (t) => {
  const episode = episodeIn(t);
  const count = 150;
  // Far enough ahead that both processes have loaded and are spinning toward it.
  const at = Date.now() + 1_500;

  const ended = await Promise.all([
    racer(episode, "B", count, "queued", at),
    racer(episode, "A", count, "reviewing", at),
  ]);

  assert.deepEqual(ended, ["exit 0, failed 0", "exit 0, failed 0"]);
  const read = readState(episode);
  assert.equal(read.outcome, "read", JSON.stringify(read));
  const heads = new Set((read.outcome === "read" ? (read.state.records ?? []) : []).map((record) => record.head));
  const missing = ["A", "B"].flatMap((label) =>
    Array.from({ length: count }, (_, index) => `${label}-${index}`).filter((head) => !heads.has(head)),
  );
  assert.deepEqual(missing, [], `${missing.length} of ${2 * count} records were lost to an update that read before another wrote`);
});

test("a lock left by a writer killed while holding it is taken over, and the update is made", { timeout: 30_000 }, async (t) => {
  const episode = episodeIn(t);
  const lockFile = pathToFileURL(join(import.meta.dirname, "..", "sessions", "lock-file.ts")).href;
  // Takes the state lock as an update does, then dies with no chance to release it.
  const script = [
    `import { takeLock } from ${JSON.stringify(lockFile)};`,
    `const taking = takeLock(${JSON.stringify(episode.directory)}, "state.lock", { boundMs: 5000 });`,
    `if (taking.outcome !== "taken") process.exit(1);`,
    `process.kill(process.pid, "SIGKILL");`,
  ].join("\n");
  const killed = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "inherit" });
  const signal = await new Promise((resolve) => killed.once("exit", (_code, signal) => resolve(signal)));
  assert.equal(signal, "SIGKILL");
  assert.equal(existsSync(join(episode.directory, "state.lock")), true, "the killed writer left no lock to take over");

  const updated = updateState(episode, queue("B"), { until: deadlineIn(LONG_MS) });

  assert.equal(updated.outcome, "written", JSON.stringify(updated));
  assert.deepEqual(headsIn(episode), ["B"]);
  assert.deepEqual(readdirSync(episode.directory), ["state.json"], "the update left something behind beside the state file");
});

test("a holder that cannot be told running or gone keeps its lock, and the update reports it could not be made", (t) => {
  const episode = episodeIn(t);
  const lock = holdLock(episode, goneIdentity());
  const clock = fakeClock();
  let asked = 0;
  // Each answer takes 100ms of the clock, so the 300ms deadline passes at the third.
  const unknown = (): Presence => {
    asked += 1;
    clock.advance(100);
    return { outcome: "unknown", reason: "ps could not be run" };
  };

  const updated = updateState(episode, queue("B"), { until: deadlineIn(300, clock.now), presence: unknown });

  assert.equal(updated.outcome, "failed", JSON.stringify(updated));
  assert.match(updated.outcome === "failed" ? updated.reason : "", /could not be written.*ps could not be run/su);
  assert.equal(asked, 3, "the update did not wait on the holder until its deadline");
  assert.equal(readFileSync(lock.path, "utf8"), lock.text, "the lock was broken");
  assert.equal(existsSync(episode.stateFile), false, "the state file was written without the lock");
});

test("an update waits for a live holder to release the lock, then makes its change", (t) => {
  const episode = episodeIn(t);
  const lock = holdLock(episode, ownIdentity());
  let asked = 0;
  // The holder is alive, and lets go once it has been asked about three times.
  const presence = (): Presence => {
    asked += 1;
    if (asked === 3) rmSync(lock.path);
    return { outcome: "running" };
  };

  const updated = updateState(episode, queue("B"), { until: deadlineIn(LONG_MS), presence });

  assert.equal(updated.outcome, "written", JSON.stringify(updated));
  assert.equal(asked, 3, "the update did not wait on the holder");
  assert.deepEqual(headsIn(episode), ["B"]);
});

test("an update whose wait for a live holder runs out fails at its deadline, and writes nothing", (t) => {
  const episode = episodeIn(t);
  const holder = ownIdentity();
  const lock = holdLock(episode, holder);
  const clock = fakeClock();
  let asked = 0;
  // The holder is alive at every look, and each look takes 100ms of the clock.
  const running = (): Presence => {
    asked += 1;
    clock.advance(100);
    return { outcome: "running" };
  };

  const updated = updateState(episode, queue("B"), { until: deadlineIn(300, clock.now), presence: running });

  assert.equal(updated.outcome, "failed", JSON.stringify(updated));
  assert.match(updated.outcome === "failed" ? updated.reason : "", new RegExp(`could not be written.*process ${holder.pid}`, "su"));
  assert.equal(asked, 3, "the update stopped waiting before its deadline, or after it");
  assert.equal(readFileSync(lock.path, "utf8"), lock.text, "the lock was broken");
  assert.equal(existsSync(episode.stateFile), false, "the state file was written without the lock");
});

test("a wait on a live holder gives ps no longer than its deadline has left", (t) => {
  const episode = episodeIn(t);
  const holder = ownIdentity();
  holdLock(episode, holder);
  const clock = fakeClock();
  const bounds: number[] = [];
  // A ps that never answers in time: it runs to its bound and is cut off.
  const slow = (_identity: ProcessIdentity, boundMs: number): Presence => {
    bounds.push(boundMs);
    clock.advance(boundMs);
    return { outcome: "unknown", reason: `ps did not answer within ${boundMs}ms` };
  };

  const updated = updateState(episode, queue("B"), { until: deadlineIn(50, clock.now), self: holder, presence: slow });

  assert.equal(updated.outcome, "failed", JSON.stringify(updated));
  assert.deepEqual(bounds, [50], "the bound each ps was given, against a deadline 50ms away");
});

test("a takeover that needs more ps checks than its deadline leaves fails at the deadline, and writes nothing", (t) => {
  const episode = episodeIn(t);
  const stale = goneIdentity();
  const taker = { pid: process.pid, startedAt: stale.startedAt - 1 };
  const lock = holdLock(episode, stale);
  // A taker that died replacing the lock, so taking it over asks ps about two processes.
  writeFileSync(join(episode.directory, `state.lock.${stale.pid}-${stale.startedAt}.claim`), `${JSON.stringify(taker)}\n`);
  const clock = fakeClock();
  const bounds: number[] = [];
  // A ps that takes 150ms to answer "gone", and is cut off where its bound is shorter.
  const slow = (_identity: ProcessIdentity, boundMs: number): Presence => {
    bounds.push(boundMs);
    if (boundMs < 150) {
      clock.advance(boundMs);
      return { outcome: "unknown", reason: `ps did not answer within ${boundMs}ms` };
    }
    clock.advance(150);
    return { outcome: "gone" };
  };

  const updated = updateState(episode, queue("B"), { until: deadlineIn(200, clock.now), self: ownIdentity(), presence: slow });

  assert.equal(updated.outcome, "failed", JSON.stringify(updated));
  assert.deepEqual(bounds, [200, 50], "the bound each ps was given, against a deadline 200ms away");
  assert.equal(readFileSync(lock.path, "utf8"), lock.text, "the lock was replaced past the deadline");
  assert.equal(existsSync(episode.stateFile), false, "the state file was written past the deadline");
});

test("an update reading its own identity gives that ps no longer than its deadline has left, and asks no holder after", (t) => {
  const episode = episodeIn(t);
  const holder = ownIdentity();
  holdLock(episode, holder);
  const clock = fakeClock();
  const bounds: { readonly self: number[]; readonly holder: number[] } = { self: [], holder: [] };
  // Every ps takes 150ms, and one whose bound is shorter is cut off at it.
  const answer = <T>(boundMs: number, answered: T, cut: T): T => {
    clock.advance(Math.min(boundMs, 150));
    return boundMs < 150 ? cut : answered;
  };
  const identify = (boundMs: number): IdentityRead => {
    bounds.self.push(boundMs);
    return answer<IdentityRead>(boundMs, { outcome: "read", identity: holder }, { outcome: "unknown", reason: "ps was cut off" });
  };
  const running = (_identity: ProcessIdentity, boundMs: number): Presence => {
    bounds.holder.push(boundMs);
    return answer<Presence>(boundMs, { outcome: "running" }, { outcome: "unknown", reason: "ps was cut off" });
  };

  const updated = updateState(episode, queue("B"), { until: deadlineIn(50, clock.now), identify, presence: running });

  assert.equal(updated.outcome, "failed", JSON.stringify(updated));
  assert.deepEqual(bounds, { self: [50], holder: [] }, "the bound each ps was given, against a deadline 50ms away");
});

/** A clock that moves only when the test moves it. */
function fakeClock(): { readonly now: () => number; readonly advance: (milliseconds: number) => void } {
  let at = 0;
  return {
    now: () => at,
    advance: (milliseconds) => {
      at += milliseconds;
    },
  };
}

function ownIdentity(): ProcessIdentity {
  const read = identityOf(process.pid, 5_000);
  assert.equal(read.outcome, "read", `this process's identity was not read: ${JSON.stringify(read)}`);
  return read.outcome === "read" ? read.identity : { pid: 0, startedAt: 0 };
}

/** This process's pid with a start time it did not start at, which `ps` reads as gone. */
function goneIdentity(): ProcessIdentity {
  return { pid: process.pid, startedAt: ownIdentity().startedAt - 1_000 };
}

/** The state lock, written as a writer holding it would have written it. */
function holdLock(episode: Episode, holder: ProcessIdentity): { readonly path: string; readonly text: string } {
  const path = join(episode.directory, "state.lock");
  const text = `${JSON.stringify(holder)}\n`;
  mkdirSync(episode.directory, { recursive: true });
  writeFileSync(path, text);
  return { path, text };
}

function queue(head: string): (state: EpisodeState) => EpisodeState {
  return (state) => ({ ...state, records: putRecord(state.records ?? [], { head, activity: null, status: "queued" }) });
}

function headsIn(episode: Episode): readonly string[] {
  const read = readState(episode);
  assert.equal(read.outcome, "read", JSON.stringify(read));
  return (read.outcome === "read" ? (read.state.records ?? []) : []).map((record) => record.head);
}
