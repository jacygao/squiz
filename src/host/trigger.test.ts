import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { renderComment, renderReply } from "../findings/comment.ts";
import { episodeAt, type Episode } from "../loop/episode.ts";
import { readState, writeState, type EpisodeState } from "../loop/episode-state.ts";
import type { StateRecord } from "../loop/state-record.ts";
import { deadlineIn } from "../reviewers/deadline.ts";
import { identityOf, stillRunning, type ProcessIdentity } from "../sessions/process.ts";
import { standIn } from "../testing/stand-in.ts";
import { takeHostLock } from "./lock.ts";
import { trigger, type TriggerRequest, type Triggered } from "./trigger.ts";

const BOUND_MS = 10_000;
const NUMBER = 41;
const BRANCH = "feature-a";
const HEAD = "3f9c2e0a1b2c3d4e5f60718293a4b5c6d7e8f901";
const standInHost = fileURLToPath(new URL("host-stand-in.ts", import.meta.url));
const racer = fileURLToPath(new URL("trigger-racer.ts", import.meta.url));
const originalPath = process.env["PATH"] ?? "";

/** A worktree on a branch, a `gh` on PATH answering for it, and where the stand-in host reports. */
type Fixture = {
  readonly worktree: string;
  readonly bin: string;
  readonly episode: Episode;
  readonly hostLog: string;
  /** PATH with the fake `gh` first. */
  readonly path: string;
};

function git(directory: string, ...args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * The fake `gh`. `gh pr list` prints `list.out`. The nth GraphQL call prints
 * `graphql.<n>.out` where there is one and `graphql.out` otherwise, with the
 * matching `.err` on stderr and `.status` as its exit status.
 */
function fakeGh(directory: string): string {
  const at = `'${directory.replaceAll("'", `'\\''`)}'`;
  return [
    "#!/bin/sh",
    "cat > /dev/null",
    'for arg in "$@"; do',
    '  if [ "$arg" = graphql ]; then',
    `    n=$(( $(cat ${at}/count 2>/dev/null || echo 0) + 1 ))`,
    `    echo "$n" > ${at}/count`,
    `    f=${at}/graphql; [ -f ${at}/graphql.$n.out ] && f=${at}/graphql.$n`,
    '    cat "$f.out"',
    '    [ -f "$f.err" ] && cat "$f.err" >&2',
    '    exit "$(cat "$f.status" 2>/dev/null || echo 0)"',
    "  fi",
    "done",
    `cat ${at}/list.out`,
    "",
  ].join("\n");
}

function pullRequestRow(headRefName: string = BRANCH, number: number = NUMBER): string {
  return JSON.stringify([
    { number, id: "PR_kwDOUEd2qM8AAAABDNPXSA", baseRefName: "main", headRefName, headRefOid: HEAD, body: "" },
  ]);
}

function answered(value: unknown): string {
  return `HTTP/2.0 200 OK\nContent-Type: application/json; charset=utf-8\r\n\r\n${JSON.stringify(value)}`;
}

type CommentNode = { readonly id: string; readonly body: string; readonly createdAt: string };

function threadNode(id: string, comments: readonly CommentNode[]): unknown {
  return {
    id,
    isResolved: false,
    isOutdated: false,
    path: "src/queue.ts",
    line: 134,
    originalLine: 134,
    subjectType: "LINE",
    comments: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: comments.map((comment) => ({ ...comment, databaseId: null, author: { login: "someone" } })),
    },
  };
}

function listing(threads: readonly unknown[], next: string | null = null): string {
  return answered({
    data: { node: { reviewThreads: { pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes: threads } } },
  });
}

const finding = renderComment({
  scope: "change",
  severity: "high",
  headline: "Retry backoff resets on every enqueue",
  reasoning: ["`enqueue()` calls `resetBackoff()` on every call."],
  suggestedFix: "Reset the backoff only when the queue was empty.",
});

function withFixture(body: (fixture: Fixture) => void | Promise<void>): Promise<void> {
  // Real paths, because git answers the toplevel with symlinks resolved.
  const worktree = realpathSync(mkdtempSync(join(tmpdir(), "squiz-trigger-")));
  const bin = mkdtempSync(join(tmpdir(), "squiz-trigger-gh-"));
  git(worktree, "init", "--quiet", "--initial-branch", BRANCH);
  git(worktree, "-c", "user.email=squiz@example.invalid", "-c", "user.name=Squiz", "-c", "commit.gpgsign=false",
    "commit", "--quiet", "--allow-empty", "--message", "a commit to hang a branch off");
  writeFileSync(join(bin, "list.out"), pullRequestRow(), "utf8");
  writeFileSync(join(bin, "graphql.out"), listing([]), "utf8");
  standIn(bin, "gh", fakeGh(bin));
  const path = `${bin}:${originalPath}`;
  const fixture: Fixture = { worktree, bin, episode: episodeAt(worktree, NUMBER), hostLog: join(bin, "hosts.log"), path };
  process.env["PATH"] = path;
  return (async () => {
    try {
      await body(fixture);
    } finally {
      process.env["PATH"] = originalPath;
      for (const pid of hostsThatTook(fixture)) stop(pid);
      rmSync(worktree, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  })();
}

function request(fixture: Fixture, overrides: Partial<TriggerRequest> = {}): TriggerRequest {
  return {
    directory: fixture.worktree,
    trigger: "hook",
    environment: {},
    until: deadlineIn(60_000),
    host: () => ({ command: process.execPath, args: [standInHost, fixture.episode.directory, fixture.hostLog] }),
    ...overrides,
  };
}

function hostLines(fixture: Fixture): string[] {
  return existsSync(fixture.hostLog) ? readFileSync(fixture.hostLog, "utf8").trim().split("\n").filter(Boolean) : [];
}

function hostsThatTook(fixture: Fixture): number[] {
  return hostLines(fixture).filter((line) => line.startsWith("took ")).map((line) => Number(line.slice(5)));
}

function stop(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

async function eventually(done: () => boolean, what: string, ms: number = BOUND_MS): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) assert.fail(`${what} did not happen within ${ms}ms`);
    await sleep(50);
  }
}

function records(episode: Episode): readonly StateRecord[] {
  const read = readState(episode);
  assert.equal(read.outcome, "read", `state read as ${JSON.stringify(read)}`);
  return read.outcome === "read" ? (read.state.records ?? []) : [];
}

function seed(episode: Episode, state: Partial<EpisodeState>): void {
  const written = writeState(episode, { rounds: [], spentOutsideRounds: { dollars: 0, tokens: 0, messages: 0 }, ...state });
  assert.equal(written.outcome, "written");
}

function decided(triggered: Triggered): Extract<Triggered, { outcome: "decided" }> {
  assert.equal(triggered.outcome, "decided", `triggered as ${JSON.stringify(triggered)}`);
  return triggered as Extract<Triggered, { outcome: "decided" }>;
}

function ownIdentity(): ProcessIdentity {
  const read = identityOf(process.pid, BOUND_MS);
  assert.equal(read.outcome, "read");
  return read.outcome === "read" ? read.identity : { pid: 0, startedAt: 0 };
}

const state = { head: HEAD, activity: null };

test("a state with no record is queued with its owner and workspace, and a host is started", async () => {
  await withFixture(async (fixture) => {
    const owner = { sessionId: "6f1c", subagent: "a5336e10", messagingSocket: "/tmp/cc.sock" };
    const result = decided(
      trigger(request(fixture, { owner, environment: { HERDR_WORKSPACE_ID: "w2" } })),
    );

    assert.deepEqual(result.decision, { outcome: "queue", startHost: true });
    assert.equal(result.queued, true);
    assert.equal(result.host.outcome, "started", `host ${JSON.stringify(result.host)}`);
    assert.deepEqual(records(fixture.episode), [
      { head: HEAD, activity: null, owner, herdrWorkspace: "w2", status: "queued" },
    ]);
    await eventually(() => hostsThatTook(fixture).length === 1, "the started host taking the lock");
  });
});

test("the state is keyed by the newest reply on the reviewer's threads", async () => {
  await withFixture((fixture) => {
    writeFileSync(join(fixture.bin, "graphql.out"), listing([
      threadNode("PRRT_a", [
        { id: "PRRC_opened", body: finding, createdAt: "2026-10-05T07:00:00Z" },
        { id: "PRRC_reply", body: renderReply("Reset only when empty now."), createdAt: "2026-10-05T07:05:00Z" },
      ]),
    ]), "utf8");

    const result = decided(trigger(request(fixture)));

    assert.deepEqual(result.state, { head: HEAD, activity: "PRRC_reply" });
    assert.deepEqual(records(fixture.episode).map((record) => record.activity), ["PRRC_reply"]);
  });
});

test("a workspace id Herdr would not give is not recorded, so the record still reads", async () => {
  await withFixture((fixture) => {
    decided(trigger(request(fixture, { environment: { HERDR_WORKSPACE_ID: "not a workspace" } })));

    assert.deepEqual(records(fixture.episode), [{ head: HEAD, activity: null, status: "queued" }]);
  });
});

test("threads that could not be listed fail the trigger and queue nothing", async () => {
  await withFixture((fixture) => {
    writeFileSync(join(fixture.bin, "graphql.out"), "", "utf8");
    writeFileSync(join(fixture.bin, "graphql.err"), "gh: HTTP 502", "utf8");
    writeFileSync(join(fixture.bin, "graphql.status"), "1", "utf8");

    const result = trigger(request(fixture));

    assert.equal(result.outcome, "failed", `a listing that failed read as ${JSON.stringify(result)}`);
    assert.match(result.outcome === "failed" ? result.reason : "", /threads on PR #41 could not all be listed: .*HTTP 502/u);
    assert.equal(existsSync(join(fixture.worktree, ".squiz")), false, "a state was queued with no activity read");
  });
});

test("threads listed only in part fail the trigger, and are not read as no activity", async () => {
  await withFixture((fixture) => {
    writeFileSync(join(fixture.bin, "graphql.1.out"), listing([threadNode("PRRT_a", [
      { id: "PRRC_opened", body: finding, createdAt: "2026-10-05T07:00:00Z" },
    ])], "cursor-1"), "utf8");
    writeFileSync(join(fixture.bin, "graphql.2.out"), "", "utf8");
    writeFileSync(join(fixture.bin, "graphql.2.status"), "1", "utf8");

    const result = trigger(request(fixture));

    assert.equal(result.outcome, "failed", `a partial listing read as ${JSON.stringify(result)}`);
    assert.match(result.outcome === "failed" ? result.reason : "", /threads on PR #41 could not all be listed: /u);
    assert.equal(existsSync(join(fixture.worktree, ".squiz")), false);
  });
});

test("a branch with no open pull request queues nothing and makes no .squiz", async () => {
  await withFixture((fixture) => {
    writeFileSync(join(fixture.bin, "list.out"), "[]", "utf8");

    const result = trigger(request(fixture));

    assert.equal(result.outcome, "no review", JSON.stringify(result));
    assert.match(result.outcome === "no review" ? result.reason : "", /no open pull request has "feature-a" as its head/u);
    assert.equal(existsSync(join(fixture.worktree, ".squiz")), false);
  });
});

test("a pull request whose head is not the branch checked out queues nothing and makes no .squiz", async () => {
  await withFixture((fixture) => {
    writeFileSync(join(fixture.bin, "list.out"), pullRequestRow(BRANCH, 12), "utf8");

    const result = trigger(request(fixture, { trigger: "review", pullRequest: NUMBER }));

    assert.equal(result.outcome, "no review", JSON.stringify(result));
    assert.match(result.outcome === "no review" ? result.reason : "", /PR #41.*"feature-a"/u);
    assert.equal(existsSync(join(fixture.worktree, ".squiz")), false);
  });
});

test("a detached HEAD queues nothing and makes no .squiz", async () => {
  await withFixture((fixture) => {
    git(fixture.worktree, "checkout", "--quiet", "--detach");

    const result = trigger(request(fixture));

    assert.equal(result.outcome, "no review", JSON.stringify(result));
    assert.match(result.outcome === "no review" ? result.reason : "", /HEAD is detached/u);
    assert.equal(existsSync(join(fixture.worktree, ".squiz")), false);
  });
});

test("a queued state no live host holds gets a host, and is not queued again", async () => {
  await withFixture(async (fixture) => {
    const queued: StateRecord = { ...state, owner: { sessionId: "first" }, status: "queued" };
    seed(fixture.episode, { records: [queued] });

    const result = decided(trigger(request(fixture, { owner: { sessionId: "second" } })));

    assert.deepEqual(result.decision, { outcome: "start-host" });
    assert.equal(result.queued, false);
    assert.deepEqual(records(fixture.episode), [queued]);
    await eventually(() => hostsThatTook(fixture).length === 1, "the started host taking the lock");
  });
});

test("a queued state a live host holds starts nothing", async () => {
  await withFixture((fixture) => {
    seed(fixture.episode, { records: [{ ...state, status: "queued" }] });
    const held = takeHostLock(fixture.episode.directory, { boundMs: BOUND_MS });
    assert.equal(held.outcome, "taken");
    try {
      const result = decided(trigger(request(fixture)));

      assert.deepEqual(result.decision, { outcome: "in-hand" });
      assert.deepEqual(result.host, { outcome: "not started" });
    } finally {
      if (held.outcome === "taken") held.lock.release();
    }
    assert.deepEqual(hostLines(fixture), []);
  });
});

test("a hook leaves a failed state failed, and squiz review queues it again", async () => {
  await withFixture(async (fixture) => {
    const failed: StateRecord = { ...state, status: "failed", reason: "the round host died", ownerNoted: true };
    seed(fixture.episode, { records: [failed] });

    const byHook = decided(trigger(request(fixture)));
    assert.deepEqual(byHook.decision, { outcome: "left-failed" });
    assert.deepEqual(records(fixture.episode), [failed]);
    assert.deepEqual(byHook.host, { outcome: "not started" });

    const byReview = decided(trigger(request(fixture, { trigger: "review", pullRequest: NUMBER })));
    assert.deepEqual(byReview.decision, { outcome: "queue", startHost: true });
    assert.equal(byReview.queued, true);
    assert.deepEqual(records(fixture.episode), [{ ...state, status: "queued" }]);
    await eventually(() => hostsThatTook(fixture).length === 1, "the started host taking the lock");
  });
});

test("a round whose host has gone is handed back for recovery, and nothing is changed", async () => {
  await withFixture((fixture) => {
    const gone = { pid: process.pid, startedAt: ownIdentity().startedAt - 1_000 };
    const reviewing: StateRecord = { ...state, status: "reviewing", host: gone };
    seed(fixture.episode, { records: [reviewing] });

    const result = decided(trigger(request(fixture)));

    assert.equal(result.decision.outcome, "recover");
    assert.equal(result.queued, false);
    assert.deepEqual(result.host, { outcome: "not started" });
    assert.deepEqual(records(fixture.episode), [reviewing]);
  });
});

test("a closed episode queues nothing, even for a state it never saw", async () => {
  await withFixture((fixture) => {
    seed(fixture.episode, { closeReported: true });

    const result = decided(trigger(request(fixture)));

    assert.deepEqual(result.decision, { outcome: "closed" });
    assert.deepEqual(records(fixture.episode), []);
    assert.deepEqual(hostLines(fixture), []);
  });
});

test("a host that took the state between the trigger's read and its queue keeps its reviewing record", async () => {
  await withFixture((fixture) => {
    const self = ownIdentity();
    // A lock naming a host that has gone, so the trigger asks whether it runs.
    // The host's record is written while it asks: after the read, before the queue.
    mkdirSync(fixture.episode.directory, { recursive: true });
    writeFileSync(join(fixture.episode.directory, "host.lock"), `${JSON.stringify({ pid: self.pid, startedAt: self.startedAt - 1_000 })}\n`);
    const reviewing: StateRecord = { ...state, status: "reviewing", host: self };

    const result = decided(trigger(request(fixture, {
      presence: () => {
        seed(fixture.episode, { records: [reviewing] });
        return { outcome: "gone" };
      },
    })));

    assert.deepEqual(result.decision, { outcome: "queue", startHost: true });
    assert.equal(result.queued, false);
    assert.deepEqual(records(fixture.episode), [reviewing], "the queue overwrote a round under way");
  });
});

/** Run one racer process and read the line it prints. */
function startRacer(fixture: Fixture, at: number, linger: boolean) {
  const child = spawn(
    process.execPath,
    [racer, JSON.stringify({ directory: fixture.worktree, episodeDirectory: fixture.episode.directory, hostLog: fixture.hostLog, at, linger })],
    { env: { ...process.env, PATH: fixture.path }, detached: true, stdio: ["ignore", "pipe", "inherit"] },
  );
  const printed = new Promise<Triggered>((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    lines.once("line", (line) => resolve(JSON.parse(line) as Triggered));
    child.once("exit", (code) => reject(new Error(`the racer exited ${code} without printing`)));
  });
  return { child, printed };
}

test("two triggers for one state at once queue it once and leave one host running", async () => {
  await withFixture(async (fixture) => {
    const at = Date.now() + 1_500;
    const results = await Promise.all([startRacer(fixture, at, false).printed, startRacer(fixture, at, false).printed]);

    for (const result of results) assert.equal(result.outcome, "decided", JSON.stringify(result));
    assert.deepEqual(records(fixture.episode), [{ ...state, status: "queued" }]);
    const started = results.filter((result) => result.outcome === "decided" && result.host.outcome !== "not started");
    await eventually(() => hostLines(fixture).length === started.length, "every started host reporting");
    const took = hostsThatTook(fixture);
    assert.equal(took.length, 1, `hosts: ${hostLines(fixture).join(", ")}`);
    const holder = JSON.parse(readFileSync(join(fixture.episode.directory, "host.lock"), "utf8")) as ProcessIdentity;
    assert.equal(holder.pid, took[0]);
    assert.deepEqual(stillRunning(holder, BOUND_MS), { outcome: "running" });
  });
});

test("the host a trigger starts outlives the trigger's process group", async () => {
  await withFixture(async (fixture) => {
    const { child, printed } = startRacer(fixture, 0, true);
    const exited = new Promise((resolve) => child.once("exit", resolve));
    let result: Triggered;
    try {
      result = await printed;
    } finally {
      process.kill(-(child.pid ?? 0), "SIGKILL");
      await exited;
    }
    assert.equal(result.outcome === "decided" ? result.host.outcome : result.outcome, "started");
    const host = result.outcome === "decided" && result.host.outcome === "started" ? result.host.identity : undefined;
    assert.ok(host !== undefined);
    await sleep(200);

    assert.deepEqual(stillRunning(host, BOUND_MS), { outcome: "running" }, "the host died with the trigger");
    stop(host.pid);
  });
});
