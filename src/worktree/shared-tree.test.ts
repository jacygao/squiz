import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { writeState } from "../loop/episode-state.ts";
import { episodeAt } from "../loop/episode.ts";
import { unspent } from "../reviewers/adapter.ts";
import { deadlineIn } from "../reviewers/deadline.ts";
import { standIn } from "../testing/stand-in.ts";
import {
  clearRoundRunning,
  markRoundRunning,
  otherLiveEpisodes,
  type OtherEpisodes,
} from "./shared-tree.ts";

/** Longer than any of these spends, so nothing but the fixture decides the answer. */
const BOUND_MS = 30_000;

/** Who else is in the worktree holding `directory`, under a bound no test reaches. */
function whoElseIsHere(directory: string, id: string): OtherEpisodes {
  return otherLiveEpisodes(directory, id, deadlineIn(BOUND_MS));
}

/** Run git in `directory`, and fail the test rather than the fixture. */
function git(directory: string, ...args: readonly string[]): void {
  const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
}

/** A temporary directory with every symlink resolved, so git's answer is known. */
async function withWorktree<T>(body: (root: string) => Promise<T> | T): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "squiz-shared-"));
  try {
    const root = realpathSync(directory);
    git(root, "init", "--quiet", "--initial-branch", "review/the-round");
    return await body(root);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Mark a round of `id` running in `worktree`, as a round of it would. */
function roundRunning(worktree: string, id: string): void {
  const marked = markRoundRunning(episodeAt(worktree, Number(id)));
  assert.equal(marked.outcome, "written", marked.outcome === "failed" ? marked.reason : "");
}

/** An episode of `worktree` that has run a round, and closed or not. */
function episodeRecorded(worktree: string, id: string, closed: boolean): void {
  const written = writeState(episodeAt(worktree, Number(id)), {
    rounds: [unspent],
    spentOutsideRounds: unspent,
    ...(closed ? { closeReported: true } : {}),
  });
  assert.equal(written.outcome, "written", written.outcome === "failed" ? written.reason : "");
}

function markerFile(worktree: string, id: string): string {
  return join(episodeAt(worktree, Number(id)).directory, "running.json");
}

/** The pid of a process that has exited, which is what a killed round's marker names. */
function pidOfAProcessThatHasGone(): number {
  const result = spawnSync("node", ["-e", "process.stdout.write(String(process.pid))"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const pid = Number(result.stdout.trim());
  assert.ok(Number.isInteger(pid) && pid > 1, `no pid came back: ${result.stdout}`);
  return pid;
}

async function writeMarker(worktree: string, id: string, marker: unknown): Promise<void> {
  const episode = episodeAt(worktree, Number(id));
  await mkdir(episode.directory, { recursive: true });
  await writeFile(markerFile(worktree, id), JSON.stringify(marker), "utf8");
}

async function readMarker(worktree: string, id: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(markerFile(worktree, id), "utf8"));
  assert.ok(typeof parsed === "object" && parsed !== null, "the marker holds a JSON object");
  return parsed as Record<string, unknown>;
}

/**
 * Run `body` with a `ps` of the test's own on the front of `PATH`.
 *
 * Only `ps` is replaced, so git still resolves to the real one.
 */
async function withPsThat<T>(script: string, body: () => Promise<T> | T): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "squiz-ps-"));
  const previous = process.env["PATH"];
  try {
    standIn(directory, "ps", `#!/bin/sh\n${script}\n`);
    process.env["PATH"] = `${directory}:${previous ?? ""}`;
    return await body();
  } finally {
    if (previous === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test("an episode running a round makes the tree shared, and its round is named", async () => {
  await withWorktree((root) => {
    roundRunning(root, "41");

    assert.deepEqual(whoElseIsHere(root, "42"), {
      outcome: "shared",
      episodes: [{ id: "41", pid: process.pid }],
    });
  });
});

test("an episode between two of its rounds is live, and has no round in flight", async () => {
  // Its hook exited and its coding agent is editing this tree to address the
  // findings. Read as gone, a reviewer running now would have those edits read
  // back as its own.
  await withWorktree((root) => {
    episodeRecorded(root, "41", false);

    assert.deepEqual(whoElseIsHere(root, "42"), {
      outcome: "shared",
      episodes: [{ id: "41", pid: null }],
    });
  });
});

test("an episode that reported its close is not live", async () => {
  await withWorktree((root) => {
    episodeRecorded(root, "41", true);

    assert.deepEqual(whoElseIsHere(root, "42"), { outcome: "alone" });
  });
});

test("the episode asking is never one of the episodes it finds", async () => {
  // The round asking is running in the tree it asks about, so its own marker and
  // its own state are both there. Counting itself would call every tree shared
  // and disable the comparison always.
  await withWorktree((root) => {
    roundRunning(root, "41");
    episodeRecorded(root, "41", false);

    assert.deepEqual(whoElseIsHere(root, "41"), { outcome: "alone" });
  });
});

test("a round that ended leaves the episode live, and names no round", async () => {
  await withWorktree((root) => {
    const episode = episodeAt(root, 41);
    roundRunning(root, "41");
    episodeRecorded(root, "41", false);
    clearRoundRunning(episode);

    assert.deepEqual(whoElseIsHere(root, "42"), {
      outcome: "shared",
      episodes: [{ id: "41", pid: null }],
    });
  });
});

test("the marker a killed round left behind cannot read a live episode as gone", async () => {
  // The runtime kills a hook at its ceiling and none of the round's cleanup
  // runs, so the marker stays and names a process that has gone. The episode is
  // still live, because nothing reported its close.
  await withWorktree(async (root) => {
    await writeMarker(root, "41", {
      pid: pidOfAProcessThatHasGone(),
      startedAt: "Thu Jan  1 00:00:00 1970",
      toplevel: root,
    });
    episodeRecorded(root, "41", false);

    assert.deepEqual(whoElseIsHere(root, "42"), {
      outcome: "shared",
      episodes: [{ id: "41", pid: null }],
    });
  });
});

test("a round in flight is named in an episode whose state records a close", async () => {
  // The two disagree, and the marker only ever adds. Reading the close first
  // would answer that a tree with a reviewer running in it is a tree nobody else
  // is in.
  await withWorktree((root) => {
    roundRunning(root, "41");
    episodeRecorded(root, "41", true);

    assert.deepEqual(whoElseIsHere(root, "42"), {
      outcome: "shared",
      episodes: [{ id: "41", pid: process.pid }],
    });
  });
});

test("an episode that recorded nothing and is running no round is not live", async () => {
  // Nothing on disk says it ever got as far as a round, and the directory
  // outlives the episode, which is why the directories alone answer nothing.
  await withWorktree(async (root) => {
    await mkdir(episodeAt(root, 41).directory, { recursive: true });

    assert.deepEqual(whoElseIsHere(root, "42"), { outcome: "alone" });
  });
});

test("a directory no episode key could have produced holds nobody's episode", async () => {
  await withWorktree(async (root) => {
    await mkdir(join(root, ".squiz", "not-an-episode"), { recursive: true });

    assert.deepEqual(whoElseIsHere(root, "42"), { outcome: "alone" });
  });
});

test("an episode kept under a subagent's id, as episodes once were, is not read", async () => {
  // A worktree from before episodes were keyed by pull request can still hold
  // one. Its state is left where it is rather than read under the new key.
  await withWorktree(async (root) => {
    const before = join(root, ".squiz", "a1e3196c5ad0f2410");
    await mkdir(before, { recursive: true });
    const state = { rounds: [unspent], spentOutsideRounds: unspent };
    await writeFile(join(before, "state.json"), JSON.stringify(state), "utf8");

    assert.deepEqual(whoElseIsHere(root, "42"), { outcome: "alone" });
  });
});

test("a worktree no episode has written in is one this round has to itself", async () => {
  await withWorktree((root) => {
    assert.deepEqual(whoElseIsHere(root, "42"), { outcome: "alone" });
  });
});

test("two spellings of one worktree are one worktree", async () => {
  // The marker records the toplevel through a symlink and git resolves the
  // physical path, so the two strings differ and the directory is one. Compared
  // as text this reads as a tree nobody else is in, which is the reading that
  // would let the comparison run in a shared tree.
  await withWorktree(async (root) => {
    const inside = join(root, "tree");
    await mkdir(inside);
    git(inside, "init", "--quiet", "--initial-branch", "review/the-round");
    const spelling = join(root, "link");
    await symlink(inside, spelling);

    roundRunning(spelling, "41");

    const marker = await readMarker(spelling, "41");
    assert.equal(marker["toplevel"], spelling, "the marker records the spelling it resolved");
    assert.deepEqual(whoElseIsHere(inside, "42"), {
      outcome: "shared",
      episodes: [{ id: "41", pid: process.pid }],
    });
  });
});

test("a round in another worktree is no round of this one", async () => {
  await withWorktree(async (root) => {
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere);
    roundRunning(root, "41");
    // Everything about the live process is kept, so the worktree is all that
    // decides this.
    await writeMarker(root, "41", { ...(await readMarker(root, "41")), toplevel: elsewhere });

    assert.deepEqual(whoElseIsHere(root, "42"), { outcome: "alone" });
  });
});

test("a marker that will not read is not a tree nobody else is in", async () => {
  await withWorktree(async (root) => {
    await writeMarker(root, "41", { pid: 0, startedAt: "", toplevel: root });

    const answer = whoElseIsHere(root, "42");

    assert.equal(answer.outcome, "unknown");
    assert.match(answer.outcome === "unknown" ? answer.reason : "", /"pid" is no process id/u);
  });
});

test("a state file that will not read is not a tree nobody else is in", async () => {
  await withWorktree(async (root) => {
    const episode = episodeAt(root, 41);
    await mkdir(episode.directory, { recursive: true });
    await writeFile(episode.stateFile, "{ not json", "utf8");

    const answer = whoElseIsHere(root, "42");

    assert.equal(answer.outcome, "unknown");
    assert.match(answer.outcome === "unknown" ? answer.reason : "", /is not valid JSON/u);
  });
});

test("a live episode is named even where another episode could not be read", async () => {
  await withWorktree(async (root) => {
    roundRunning(root, "41");
    await writeMarker(root, "42", { nothing: "a marker holds" });

    assert.deepEqual(whoElseIsHere(root, "43"), {
      outcome: "shared",
      episodes: [{ id: "41", pid: process.pid }],
    });
  });
});

test("a ps killed before it answered establishes nothing about a round", async () => {
  // A killed inspection returns no status, an empty stdout and an empty stderr,
  // which is what ps's own answer for a process that is not there looks like on
  // everything but the status. Read as that answer, it would report a round that
  // is running as one that has gone.
  await withWorktree(async (root) => {
    roundRunning(root, "41");

    assert.deepEqual(
      whoElseIsHere(root, "42"),
      { outcome: "shared", episodes: [{ id: "41", pid: process.pid }] },
      "the real ps answers that the round is running",
    );

    const answer = await withPsThat("kill -TERM $$", () => whoElseIsHere(root, "42"));

    assert.equal(answer.outcome, "unknown");
    assert.match(
      answer.outcome === "unknown" ? answer.reason : "",
      /ps was killed by SIGTERM before it answered/u,
    );
  });
});

test("a ps that exits of its own accord saying nothing is a process that has gone", async () => {
  await withWorktree(async (root) => {
    roundRunning(root, "41");

    const answer = await withPsThat("exit 1", () => whoElseIsHere(root, "42"));

    assert.deepEqual(answer, { outcome: "alone" });
  });
});

test("a git that could not resolve the worktree is not a tree nobody else is in", async () => {
  const directory = await mkdtemp(join(tmpdir(), "squiz-shared-"));
  try {
    const answer = whoElseIsHere(directory, "41");

    assert.equal(answer.outcome, "unknown");
    assert.match(
      answer.outcome === "unknown" ? answer.reason : "",
      /the worktree could not be resolved: git exited 128: fatal: not a git repository/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a key that names no episode is not a tree nobody else is in", async () => {
  // Without our own directory name there is no leaving ourselves out.
  await withWorktree((root) => {
    const answer = whoElseIsHere(root, "!!!");

    assert.equal(answer.outcome, "unknown");
    assert.match(
      answer.outcome === "unknown" ? answer.reason : "",
      /"!!!" names no episode/u,
    );
  });
});

/**
 * A ps that will not answer is the deepest call the lookup makes, and no clock
 * outside a subprocess reaches one already running.
 *
 * Read as a process that has gone, a ps cut short would answer that a round in
 * flight had ended. Waited out, it spends the window the round had to review and
 * post in.
 */
test("a ps that will not answer does not outlive the bound the lookup was given", async () => {
  await withWorktree(async (root) => {
    roundRunning(root, "41");

    const started = Date.now();
    const answer = await withPsThat(WAITS_AND_WAITS, () =>
      otherLiveEpisodes(root, "42", deadlineIn(300)),
    );
    const elapsedMs = Date.now() - started;

    assert.equal(answer.outcome, "unknown");
    assert.match(
      answer.outcome === "unknown" ? answer.reason : "",
      /ps ran out of the time it was given/u,
      "a lookup that ran out of time is its own answer and never a tree nobody else is in",
    );
    assert.ok(
      elapsedMs < 10_000,
      `the lookup is cut short rather than waited out: it took ${elapsedMs}ms`,
    );
  });
});

/**
 * A wait far longer than any bound a test gives it, in short steps.
 *
 * A shell blocked in one long sleep outlives the signal that stops it and holds
 * the pipe its caller is reading, so the wait is short and repeated instead.
 */
const WAITS_AND_WAITS = [
  "waited=0",
  'while [ "$waited" -lt 300 ]; do',
  "  sleep 0.2",
  "  waited=$((waited + 1))",
  "done",
].join("\n");
