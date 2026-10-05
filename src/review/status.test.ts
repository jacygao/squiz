import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { unspent } from "../reviewers/adapter.ts";
import type { Presence, ProcessIdentity } from "../sessions/process.ts";
import { episodeAt } from "../loop/episode.ts";
import { writeState } from "../loop/episode-state.ts";
import type { StateRecord } from "../loop/state-record.ts";
import { collectStatus, composeStatus, worktreesIn } from "./status.ts";

// Started is printed in local time, and these tests fix what local time is.
process.env["TZ"] = "UTC";

const scratch = mkdtempSync(join(tmpdir(), "squiz-status-"));
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

let made = 0;

/** A directory standing in for one worktree, with `.squiz/` written as `episodes` says. */
function worktree(episodes: Record<number, readonly StateRecord[]>): string {
  made += 1;
  const root = join(scratch, `wt-${made}`);
  mkdirSync(root, { recursive: true });
  for (const [number, records] of Object.entries(episodes)) {
    const episode = episodeAt(root, Number(number));
    const written = writeState(episode, { rounds: [], spentOutsideRounds: unspent, records });
    assert.deepEqual(written, { outcome: "written" });
  }
  return root;
}

function resume(root: string, pullRequest: number, round: number, line: string): void {
  const directory = join(root, ".squiz", String(pullRequest), "rounds", String(round));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "resume.txt"), `${line}\n`, "utf8");
}

const head = "3f9c2e07b1d4a8c6e5f0923b7a1d6c4e8b2f5a90";
const laterHead = "8d21a4f0c3b2e1d4a5f6b7c8d9e0f1a2b3c4d5e6";
const latestHead = "9e01b2c7d1d4a8c6e5f0923b7a1d6c4e8b2f5a91";
const otherHead = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const reply = "PRRC_kwDOL7tYbc6OmQx7a";

// 2026-10-05 07:06:02 UTC.
const sevenOhSix = 1_791_183_962;
const now = sevenOhSix + 600;

const running = (): Presence => ({ outcome: "running" });

function presenceBy(table: Record<number, Presence>): (identity: ProcessIdentity) => Presence {
  return (identity) => table[identity.pid] ?? { outcome: "running" };
}

function rowsOf(stdout: string): string[][] {
  return stdout
    .trimEnd()
    .split("\n")
    .map((line) => line.split(/ {2,}/u));
}

test("worktreesIn reads every worktree git lists, and no bare repository", () => {
  const porcelain = [
    "worktree /work/squiz",
    "HEAD 37ef921aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "branch refs/heads/main",
    "",
    "worktree /work/squiz.git",
    "bare",
    "",
    "worktree /work/squiz/.claude/worktrees/agent-a5336e10",
    "HEAD 8d21a4f0c3b2e1d4a5f6b7c8d9e0f1a2b3c4d5e6",
    "detached",
    "prunable gitdir file points to non-existent location",
    "",
  ].join("\n");

  assert.deepEqual(worktreesIn(porcelain), ["/work/squiz", "/work/squiz/.claude/worktrees/agent-a5336e10"]);
});

test("a finished round prints every column § 6 shows, its resume line included", () => {
  const root = worktree({
    41: [
      {
        head,
        activity: reply,
        status: "reviewed",
        result: "exited",
        exitStatus: 2,
        openThreads: ["PRRT_kwDOL7tYbc5abcd2"],
        round: { number: 2, startedAt: sevenOhSix, endedAt: sevenOhSix + 160, reviewer: { backend: "tmux", pane: "@14" } },
      },
    ],
  });
  const line = "pi --session-dir .squiz/41/rounds/2/session --session 0193f2c4-7d1e-7b52-9c1a-5e2f4d8a6b31";
  resume(root, 41, 2, line);

  const collected = collectStatus([root], { main: scratch, presence: running, now });
  const printed = composeStatus(collected);

  assert.equal(printed.stderr, "");
  assert.deepEqual(rowsOf(printed.stdout), [
    ["PR", "Commit", "Replies", "State", "Started", "Elapsed", "Result", "Session", "Worktree", "Resume"],
    ["#41", "3f9c2e0", "OmQx7a", "reviewed", "07:06:02", "2m 40s", "1 thread open", "tmux squiz-41-r2", `wt-${made}`, line],
  ]);
});

test("a reviewing record whose round host has gone is killed, and one nobody can check is not", () => {
  const root = worktree({
    41: [
      { head, activity: null, status: "reviewing", host: { pid: 501, startedAt: sevenOhSix } },
    ],
    42: [
      { head, activity: null, status: "reviewing", host: { pid: 502, startedAt: sevenOhSix } },
    ],
    43: [
      { head, activity: null, status: "reviewing", host: { pid: 503, startedAt: sevenOhSix } },
    ],
  });
  const presence = presenceBy({
    501: { outcome: "gone" },
    502: { outcome: "unknown", reason: "ps did not answer within 2000ms" },
  });

  const rows = rowsOf(composeStatus(collectStatus([root], { main: scratch, presence, now })).stdout);
  const byPr = new Map(rows.slice(1).map((row) => [row[0], row]));

  assert.equal(byPr.get("#41")?.[3], "killed");
  assert.equal(byPr.get("#42")?.[3], "reviewing", "a host that may still be running is not called killed");
  assert.equal(byPr.get("#42")?.[6], "the round host could not be checked: ps did not answer within 2000ms");
  assert.equal(byPr.get("#43")?.[3], "reviewing");
  assert.equal(byPr.get("#43")?.[6], "—");
});

test("a failed state's result is its reason, and a state the episode closed before is not reviewed", () => {
  const root = worktree({
    38: [
      {
        head: otherHead,
        activity: null,
        status: "failed",
        reason: "the reviewer was stopped at the time bound",
        ownerNoted: true,
        round: { number: 1, startedAt: sevenOhSix, endedAt: sevenOhSix + 480, reviewer: { backend: "detached" } },
      },
      {
        head,
        activity: null,
        status: "not reviewed",
        reason: "the episode closed at the round cap, after reviewing a1b2c3d",
      },
    ],
  });

  const rows = rowsOf(composeStatus(collectStatus([root], { main: scratch, presence: running, now })).stdout);

  assert.deepEqual(rows.slice(1).map((row) => row.slice(3, 8)), [
    ["not reviewed", "—", "—", "the episode closed at the round cap, after reviewing a1b2c3d", "—"],
    ["failed", "07:06:02", "8m 00s", "the reviewer was stopped at the time bound", "detached"],
  ]);
});

test("elapsed is the time so far while a review runs, and — where a record keeps no times", () => {
  const root = worktree({
    41: [
      { head, activity: null, status: "reviewed", result: "clean, episode open" },
      {
        head: laterHead,
        activity: null,
        status: "reviewing",
        host: { pid: 600, startedAt: sevenOhSix - 30 },
        reviewer: {
          backend: "herdr",
          pane: "w2-p3",
          process: { pid: 601, startedAt: sevenOhSix },
          boundEndsAt: sevenOhSix + 480,
          snapshot: "/work/.squiz/41/rounds/3/tree",
        },
      },
    ],
  });

  const rows = rowsOf(composeStatus(collectStatus([root], { main: scratch, presence: running, now: sevenOhSix + 192 })).stdout);

  assert.deepEqual(rows.slice(1).map((row) => row.slice(3, 8)), [
    ["reviewing", "07:06:02", "3m 12s", "—", "herdr squiz-41-r3"],
    ["reviewed", "—", "—", "nothing open, episode open", "—"],
  ]);
});

test("resume is — until the round is over, even where its file is already there", () => {
  const root = worktree({
    41: [
      {
        head,
        activity: null,
        status: "reviewing",
        host: { pid: 700, startedAt: sevenOhSix },
        reviewer: {
          backend: "tmux",
          pane: "@3",
          process: { pid: 701, startedAt: sevenOhSix },
          boundEndsAt: sevenOhSix + 480,
          snapshot: "/work/.squiz/41/rounds/1/tree",
        },
      },
    ],
  });
  resume(root, 41, 1, "pi --session-dir .squiz/41/rounds/1/session --session x");

  const rows = rowsOf(composeStatus(collectStatus([root], { main: scratch, presence: running, now })).stdout);

  assert.equal(rows[1]?.[9], "—");
});

test("newest first: an episode with a review waiting or running, then by the latest time a record carries", () => {
  const older = worktree({
    38: [
      {
        head: otherHead,
        activity: null,
        status: "failed",
        reason: "pi could not be started",
        ownerNoted: false,
        round: { number: 1, startedAt: sevenOhSix - 3_600, endedAt: sevenOhSix - 3_500 },
      },
    ],
  });
  const newer = worktree({
    39: [
      {
        head: otherHead,
        activity: null,
        status: "reviewed",
        result: "exited",
        exitStatus: 0,
        openThreads: [],
        round: { number: 1, startedAt: sevenOhSix, endedAt: sevenOhSix + 60, reviewer: { backend: "detached" } },
      },
    ],
  });
  // Oldest first in the file, as a trigger appends them. The queued record carries
  // no time at all, and is newest because nothing has started it yet.
  const active = worktree({
    41: [
      {
        head,
        activity: reply,
        status: "reviewed",
        result: "exited",
        exitStatus: 2,
        openThreads: ["a", "b"],
        round: { number: 1, startedAt: sevenOhSix - 7_200, endedAt: sevenOhSix - 7_000, reviewer: { backend: "detached" } },
      },
      { head: laterHead, activity: reply, status: "reviewing", host: { pid: 800, startedAt: sevenOhSix - 6_000 } },
      { head: latestHead, activity: reply, status: "queued" },
    ],
  });
  const timeless = worktree({
    12: [{ head, activity: null, status: "not reviewed", reason: "the episode closed at the token bound, after reviewing x" }],
  });

  const collected = collectStatus([timeless, older, active, newer], { main: scratch, presence: running, now });
  const rows = rowsOf(composeStatus(collected).stdout).slice(1);

  assert.deepEqual(
    rows.map((row) => `${row[0]} ${row[1]} ${row[3]}`),
    [
      "#41 9e01b2c queued",
      "#41 8d21a4f reviewing",
      "#41 3f9c2e0 reviewed",
      "#39 a1b2c3d reviewed",
      "#38 a1b2c3d failed",
      "#12 3f9c2e0 not reviewed",
    ],
  );
});

test("a state file that cannot be read is named on stderr, and every other worktree is still listed", () => {
  const good = worktree({ 41: [{ head, activity: null, status: "queued" }] });
  const bad = worktree({});
  mkdirSync(join(bad, ".squiz", "38"), { recursive: true });
  writeFileSync(join(bad, ".squiz", "38", "state.json"), "{ not json", "utf8");
  const alsoGood = worktree({ 39: [{ head: laterHead, activity: null, status: "queued" }] });

  const printed = composeStatus(collectStatus([good, bad, alsoGood], { main: scratch, presence: running, now }));

  assert.deepEqual(rowsOf(printed.stdout).slice(1).map((row) => row[0]).sort(), ["#39", "#41"]);
  assert.match(printed.stderr, /^squiz: the reviews of #38 in .*wt-\d+ could not be read: .*state\.json is not valid JSON/u);
  assert.equal(printed.stderr.split("\n").length, 2, "one line, and nothing else");
});

test("a worktree git lists that is gone from disk is skipped, and the rest are listed", () => {
  const good = worktree({ 41: [{ head, activity: null, status: "queued" }] });
  const gone = join(scratch, "removed-long-ago");

  const printed = composeStatus(collectStatus([gone, good], { main: scratch, presence: running, now }));

  assert.equal(printed.stderr, "");
  assert.deepEqual(rowsOf(printed.stdout).slice(1).map((row) => row[0]), ["#41"]);
});

test("the main worktree is printed as ., and a worktree outside it by its whole path", () => {
  const root = worktree({ 41: [{ head, activity: null, status: "queued" }] });

  const asMain = rowsOf(composeStatus(collectStatus([root], { main: root, presence: running, now })).stdout);
  const outside = rowsOf(composeStatus(collectStatus([root], { main: join(scratch, "elsewhere"), presence: running, now })).stdout);

  assert.equal(asMain[1]?.[8], ".");
  assert.equal(outside[1]?.[8], root);
});

test("no record anywhere says so rather than printing an empty table", () => {
  const empty = worktree({});

  const printed = composeStatus(collectStatus([empty], { main: scratch, presence: running, now }));

  assert.equal(printed.stdout, "No review is recorded in any worktree of this repository.\n");
  assert.equal(printed.stderr, "");
});

test("session is the label squiz-<number>-r<k>, never the backend's own id, and — where no reviewer started", () => {
  const root = worktree({
    41: [
      {
        head,
        activity: null,
        status: "failed",
        reason: "pi could not be started",
        ownerNoted: true,
        round: { number: 1, startedAt: sevenOhSix - 900, endedAt: sevenOhSix - 899 },
      },
      {
        head: laterHead,
        activity: null,
        status: "reviewed",
        result: "exited",
        exitStatus: 2,
        openThreads: ["a"],
        round: { number: 2, startedAt: sevenOhSix - 600, endedAt: sevenOhSix - 400, reviewer: { backend: "tmux", pane: "@14" } },
      },
      {
        head: latestHead,
        activity: null,
        status: "reviewing",
        host: { pid: 900, startedAt: sevenOhSix - 300 },
        // A snapshot that does not stand at rounds/<k>/tree names no round.
        reviewer: {
          backend: "tmux",
          pane: "@15",
          process: { pid: 901, startedAt: sevenOhSix },
          boundEndsAt: sevenOhSix + 480,
          snapshot: "/somewhere/else",
        },
      },
    ],
  });

  const rows = rowsOf(composeStatus(collectStatus([root], { main: scratch, presence: running, now })).stdout);

  assert.deepEqual(rows.slice(1).map((row) => row[7]), ["tmux", "tmux squiz-41-r2", "—"]);
});

test("started is the time of day for a review started today, and the date and time otherwise", () => {
  const root = worktree({
    41: [
      {
        head,
        activity: null,
        status: "failed",
        reason: "the reviewer was stopped at the time bound",
        ownerNoted: true,
        round: { number: 1, startedAt: sevenOhSix - 86_400, endedAt: sevenOhSix - 85_920, reviewer: { backend: "detached" } },
      },
      { head: laterHead, activity: null, status: "reviewing", host: { pid: 1000, startedAt: sevenOhSix } },
    ],
  });

  const rows = rowsOf(composeStatus(collectStatus([root], { main: scratch, presence: running, now })).stdout);

  assert.deepEqual(rows.slice(1).map((row) => row[4]), ["07:06:02", "2026-10-04 07:06"]);
});
