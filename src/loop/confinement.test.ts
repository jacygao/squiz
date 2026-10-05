/**
 * The readings are taken around a real reviewer's worth of writing: a real git
 * work tree, written to between the two calls the way a reviewer's shell would.
 *
 * What these are arranged around is a comparison that could not be taken reading
 * as a tree nobody touched. Every answer that is not `changed` is asserted to be
 * the one it is, and never merely not `changed`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { renderSummary } from "../github/summary-body.ts";
import { unspent } from "../reviewers/adapter.ts";
import { deadlineIn } from "../reviewers/deadline.ts";
import { standIn } from "../testing/stand-in.ts";
import { markRoundRunning } from "../worktree/shared-tree.ts";
import {
  evidenceWith,
  nothingEstablished,
  readAfterReviewer,
  readBeforeReviewer,
  type ConfinementEvidence,
  type RoundConfinement,
} from "./confinement.ts";
import { writeState } from "./episode-state.ts";
import { episodeAt, type Episode } from "./episode.ts";

// Pull requests' numbers, as the episodes' directories spell them.
const KEY = "41";
const OTHER_KEY = "42";

/** A tracked file, which is what a comparison is about. */
const TRACKED = "src/card.ts";

/** Longer than a round ever spends here, so no reading is skipped for the clock. */
const WINDOW_MS = 60_000;

function git(directory: string, ...args: readonly string[]): void {
  const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
}

/**
 * A git work tree holding one tracked file and one commit, with every symlink
 * resolved so that git's own answer for the root is the path the test passed.
 *
 * `.squiz/` is gitignored, as a project the harness is installed in has it, so
 * the episode's own directory is not itself a change the reviewer made.
 */
async function withWorktree<T>(body: (episode: Episode) => Promise<T> | T): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "squiz-confinement-"));
  try {
    const root = realpathSync(directory);
    git(root, "init", "--quiet", "--initial-branch", "review-me");
    git(root, "config", "user.email", "squiz@example.invalid");
    git(root, "config", "user.name", "Squiz");
    await writeFile(join(root, ".gitignore"), ".squiz/\n", "utf8");
    await mkdir(join(root, "src"));
    await writeFile(join(root, TRACKED), "// line 1\n", "utf8");
    git(root, "add", ".");
    git(root, "commit", "--quiet", "--message", "the change under review");
    return await body(episodeAt(root, Number(KEY)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Take both readings, with `between` standing for everything the reviewer did. */
async function around(
  episode: Episode,
  between: () => Promise<void> | void,
  windowMs = WINDOW_MS,
): Promise<RoundConfinement> {
  const before = readBeforeReviewer(episode, deadlineIn(windowMs));
  await between();
  return readAfterReviewer(before, deadlineIn(windowMs));
}

/** A reviewer that wrote to the file under review, through its shell. */
async function wroteToTheTree(episode: Episode): Promise<void> {
  await appendFile(join(episode.worktree, TRACKED), "// line 2\n", "utf8");
}

/** A round of another episode, started in this worktree after ours. */
function otherRoundStarts(worktree: string, id: string): void {
  const marked = markRoundRunning(episodeAt(worktree, Number(id)));
  assert.equal(marked.outcome, "written", marked.outcome === "failed" ? marked.reason : "");
}

/** An episode of the worktree that has run `rounds` rounds and reported its close. */
function episodeRanRounds(worktree: string, id: string, rounds: number): void {
  const written = writeState(episodeAt(worktree, Number(id)), {
    rounds: Array.from({ length: rounds }, () => unspent),
    spentOutsideRounds: unspent,
    closeReported: true,
  });
  assert.equal(written.outcome, "written", written.outcome === "failed" ? written.reason : "");
}

/** An episode of the worktree that has run a round and not closed. */
function liveEpisode(worktree: string, id: string): void {
  const written = writeState(episodeAt(worktree, Number(id)), {
    rounds: [unspent],
    spentOutsideRounds: unspent,
  });
  assert.equal(written.outcome, "written", written.outcome === "failed" ? written.reason : "");
}

/** Corrupt git's index, which is a reading that cannot be taken at all. */
async function breakGit(episode: Episode): Promise<void> {
  await writeFile(join(episode.worktree, ".git", "index"), "not an index", "utf8");
}

function markerIn(episode: Episode): string {
  return join(episode.directory, "running.json");
}

test("a file the reviewer wrote to is named, and the round is marked while it runs", async () => {
  await withWorktree(async (episode) => {
    const before = readBeforeReviewer(episode, deadlineIn(WINDOW_MS));
    assert.equal(before.marked.outcome, "written");
    assert.ok(existsSync(markerIn(episode)), "the round is marked for as long as it runs");

    await wroteToTheTree(episode);
    const confinement = readAfterReviewer(before, deadlineIn(WINDOW_MS));

    assert.deepEqual(confinement.trackedFiles, { outcome: "changed", paths: [TRACKED] });
    assert.deepEqual(confinement.otherEpisodes, { outcome: "alone" });
  });
});

test("a reviewer that wrote nothing leaves the tree unchanged", async () => {
  await withWorktree(async (episode) => {
    const confinement = await around(episode, () => {});
    assert.deepEqual(confinement.trackedFiles, { outcome: "unchanged" });
  });
});

/**
 * The round is marked before it asks who else is here, so a round that starts
 * between the two can still find this one.
 *
 * A git of the test's own witnesses the marker: every question about the worktree
 * starts with `git rev-parse`, and the marker is already there when the first one
 * is asked.
 */
test("the round is marked before the worktree is asked about", async () => {
  await withWorktree(async (episode) => {
    const witness = join(episode.worktree, "witness");
    await withGitThatRecords(markerIn(episode), witness, async () => {
      readBeforeReviewer(episode, deadlineIn(WINDOW_MS));
    });
    const seen = (await readLines(witness))[0];
    assert.equal(seen, "marked", "a round that read first could miss a round that marked after it");
  });
});

test("a worktree shared with another live episode takes no comparison", async () => {
  await withWorktree(async (episode) => {
    liveEpisode(episode.worktree, OTHER_KEY);

    const confinement = await around(episode, () => wroteToTheTree(episode));

    assert.equal(confinement.otherEpisodes.outcome, "shared");
    assert.deepEqual(
      confinement.otherEpisodes.outcome === "shared"
        ? confinement.otherEpisodes.episodes.map((other) => other.id)
        : [],
      [OTHER_KEY],
    );
    assert.equal(confinement.trackedFiles.outcome, "not-taken");
    assert.match(
      confinement.trackedFiles.outcome === "not-taken" ? confinement.trackedFiles.reason : "",
      new RegExp(`shared with live episode ${OTHER_KEY}`, "u"),
      "the reading would have named the other episode's writing as this reviewer's",
    );
  });
});

test("a worktree nothing could be established about takes no comparison either", async () => {
  await withWorktree(async (episode) => {
    const other = episodeAt(episode.worktree, Number(OTHER_KEY));
    await mkdir(other.directory, { recursive: true });
    await writeFile(other.stateFile, "{ not json", "utf8");

    const confinement = await around(episode, () => wroteToTheTree(episode));

    assert.equal(confinement.otherEpisodes.outcome, "unknown");
    assert.equal(confinement.trackedFiles.outcome, "not-taken");
  });
});

test("a reading that failed is not a tree that did not change", async () => {
  await withWorktree(async (episode) => {
    const confinement = await around(episode, () => breakGit(episode));

    assert.equal(
      confinement.trackedFiles.outcome,
      "unknown",
      "a git that failed read as a clean tree would report a reviewer that touched nothing",
    );
    assert.match(
      confinement.trackedFiles.outcome === "unknown" ? confinement.trackedFiles.reason : "",
      /the reading after could not be taken/u,
      "which of the two readings failed is part of the answer",
    );
  });
});

test("a first reading that failed is its own answer", async () => {
  await withWorktree(async (episode) => {
    // Broken before the round starts, so the reading it would be compared against
    // is the one that could not be taken. Resolving the worktree reads no index,
    // so the other episodes are still asked about.
    await breakGit(episode);
    const confinement = await around(episode, () => {});

    assert.deepEqual(confinement.otherEpisodes, { outcome: "alone" });
    assert.equal(confinement.trackedFiles.outcome, "unknown");
    assert.match(
      confinement.trackedFiles.outcome === "unknown" ? confinement.trackedFiles.reason : "",
      /the reading before could not be taken/u,
    );
  });
});

test("a round with too little of its window left reads nothing", async () => {
  await withWorktree(async (episode) => {
    const confinement = await around(episode, () => wroteToTheTree(episode), 0);

    assert.equal(confinement.trackedFiles.outcome, "not-taken");
    assert.match(
      confinement.trackedFiles.outcome === "not-taken" ? confinement.trackedFiles.reason : "",
      /window/u,
    );
    assert.equal(confinement.marked.outcome, "written", "the round is marked whatever is left");
  });
});

test("a marker that could not be written is carried out, and the comparison is taken all the same", async () => {
  await withWorktree(async (episode) => {
    // A directory where the marker goes: the round's own write cannot replace it.
    await mkdir(join(markerIn(episode), "occupied"), { recursive: true });

    const confinement = await around(episode, () => wroteToTheTree(episode));

    assert.equal(confinement.marked.outcome, "failed");
    assert.deepEqual(
      confinement.trackedFiles,
      { outcome: "changed", paths: [TRACKED] },
      "a round no other episode can find still reads its own worktree",
    );
  });
});


/**
 * The tree is asked about again after the reviewer, because an episode that
 * became live during the review is the one a single asking cannot see.
 *
 * Marking this round first only makes the round that starts later see this one.
 * It does nothing for this one, which asked before that round existed, so a
 * comparison built on the first answer alone names the other reviewer's writing
 * as this one's.
 */
test("an episode that became live after the first reading is not compared against", async () => {
  await withWorktree(async (episode) => {
    const before = readBeforeReviewer(episode, deadlineIn(WINDOW_MS));
    assert.deepEqual(before.otherEpisodes, { outcome: "alone" });

    otherRoundStarts(episode.worktree, OTHER_KEY);
    await wroteToTheTree(episode);

    const confinement = readAfterReviewer(before, deadlineIn(WINDOW_MS));

    assert.equal(confinement.otherEpisodes.outcome, "shared");
    assert.equal(
      confinement.trackedFiles.outcome,
      "not-taken",
      "the write is the other episode's, and naming it here accuses this reviewer of it",
    );
  });
});

/**
 * An episode that started and closed inside one review is live at neither asking,
 * and the tree was shared for the whole of the interval the comparison covers.
 */
test("an episode that came and went inside the review is not compared against", async () => {
  await withWorktree(async (episode) => {
    const before = readBeforeReviewer(episode, deadlineIn(WINDOW_MS));
    assert.deepEqual(before.otherEpisodes, { outcome: "alone" });

    episodeRanRounds(episode.worktree, OTHER_KEY, 1);
    await wroteToTheTree(episode);

    const confinement = readAfterReviewer(before, deadlineIn(WINDOW_MS));

    assert.equal(confinement.trackedFiles.outcome, "not-taken");
    assert.match(
      confinement.trackedFiles.outcome === "not-taken" ? confinement.trackedFiles.reason : "",
      new RegExp(`${OTHER_KEY} worked in the worktree`, "u"),
      "the episode that appeared while the reviewer ran is what the answer names",
    );
  });
});

/**
 * The reading is bounded rather than merely admitted.
 *
 * Nothing about a round's remaining window reaches a `git status` that has
 * already started, so a reading let in on what was left and then given no bound
 * of its own runs as long as git does. What the round would lose there is the
 * cost of a review that finished and the posting after it.
 */
test("a reading that runs past its bound is cut short and answered as one that failed", async () => {
  await withWorktree(async (episode) => {
    const before = readBeforeReviewer(episode, deadlineIn(WINDOW_MS));
    assert.equal(before.reading.outcome, "read");

    const started = Date.now();
    const confinement = await withGitThatDelays("status", 20, () =>
      readAfterReviewer(before, deadlineIn(WINDOW_MS)),
    );
    const elapsedMs = Date.now() - started;

    assert.equal(confinement.trackedFiles.outcome, "unknown");
    assert.match(
      confinement.trackedFiles.outcome === "unknown" ? confinement.trackedFiles.reason : "",
      /ran out of/u,
      "a reading that ran out of time is its own answer and never a tree nobody touched",
    );
    assert.ok(
      elapsedMs < 15_000,
      `the reading is cut short rather than waited out: it took ${elapsedMs}ms`,
    );
  });
});


/**
 * The case a comparison of directory names cannot see.
 *
 * The other episode has run before, so its directory and its state file are both
 * there at the first asking, and it is closed at both. It runs again and closes
 * again while this reviewer is running: neither asking finds it live, the
 * directory names are identical, and what it recorded is the only thing that
 * moved.
 */
test("an episode that ran and closed inside the review is not compared against", async () => {
  await withWorktree(async (episode) => {
    episodeRanRounds(episode.worktree, OTHER_KEY, 1);

    const before = readBeforeReviewer(episode, deadlineIn(WINDOW_MS));
    assert.deepEqual(before.otherEpisodes, { outcome: "alone" }, "the other episode has closed");

    episodeRanRounds(episode.worktree, OTHER_KEY, 2);
    await wroteToTheTree(episode);

    const confinement = readAfterReviewer(before, deadlineIn(WINDOW_MS));

    assert.deepEqual(confinement.otherEpisodes, { outcome: "alone" });
    assert.equal(confinement.trackedFiles.outcome, "not-taken");
    assert.match(
      confinement.trackedFiles.outcome === "not-taken" ? confinement.trackedFiles.reason : "",
      new RegExp(`${OTHER_KEY} worked in the worktree`, "u"),
      "the write may be the other episode's, and naming it here accuses this reviewer of it",
    );
  });
});

/**
 * A directory with nothing recorded under it is an episode that may be in its
 * first round, which is the round nothing on disk says anything about.
 */
test("an episode with nothing recorded is not a tree this round had to itself", async () => {
  await withWorktree(async (episode) => {
    await mkdir(episodeAt(episode.worktree, Number(OTHER_KEY)).directory, { recursive: true });

    const confinement = await around(episode, () => wroteToTheTree(episode));

    assert.deepEqual(confinement.otherEpisodes, { outcome: "alone" });
    assert.equal(confinement.trackedFiles.outcome, "not-taken");
    assert.match(
      confinement.trackedFiles.outcome === "not-taken" ? confinement.trackedFiles.reason : "",
      new RegExp(`${OTHER_KEY}: nothing is recorded`, "u"),
      "an episode that recorded nothing cannot be shown to have done nothing",
    );
  });
});

/**
 * The lookup is bounded rather than merely gated.
 *
 * What the round has left of its window decides that the lookup starts, and
 * nothing about it reaches a git already spawned. A lookup let in on what was left
 * and then given no bound of its own waits as long as git does, and it runs before
 * the comparison, so an overrun here leaves that with none of the window either.
 */
test("a lookup that runs past its bound is cut short and establishes nothing", async () => {
  await withWorktree(async (episode) => {
    const before = readBeforeReviewer(episode, deadlineIn(WINDOW_MS));
    assert.equal(before.reading.outcome, "read");

    const started = Date.now();
    const confinement = await withGitThatDelays("rev-parse", 30, () =>
      readAfterReviewer(before, deadlineIn(WINDOW_MS)),
    );
    const elapsedMs = Date.now() - started;

    assert.equal(confinement.otherEpisodes.outcome, "unknown");
    assert.match(
      confinement.otherEpisodes.outcome === "unknown" ? confinement.otherEpisodes.reason : "",
      /the worktree could not be resolved: git ran out of the time it was given/u,
      "a lookup that ran out of time is its own answer and never a tree this round had to itself",
    );
    assert.equal(confinement.trackedFiles.outcome, "not-taken");
    assert.match(
      confinement.trackedFiles.outcome === "not-taken" ? confinement.trackedFiles.reason : "",
      /the live episodes of the worktree could not be established/u,
    );
    assert.ok(
      elapsedMs < 20_000,
      `the lookup is cut short rather than waited out: it took ${elapsedMs}ms`,
    );
  });
});

/**
 * Run `body` with a `git` of the test's own in front of the real one, recording
 * for each call whether the marker was already there.
 */
async function withGitThatRecords(
  marker: string,
  witness: string,
  body: () => Promise<void>,
): Promise<void> {
  await withGitThat(
    `if [ -f ${quote(marker)} ]; then echo marked; else echo unmarked; fi >> ${quote(witness)}`,
    body,
  );
}

/**
 * Run `body` with a `git` that waits before answering one subcommand.
 *
 * Only that subcommand waits, so resolving the worktree still answers at once and
 * the one call that hangs is what the reading has to be cut short during. The wait
 * is short and repeated, because a shell blocked in one long sleep outlives the
 * signal that stops it and holds the pipe its caller is reading.
 */
async function withGitThatDelays<T>(
  subcommand: string,
  seconds: number,
  body: () => T | Promise<T>,
): Promise<T> {
  return await withGitThat(
    [
      `for arg in "$@"; do`,
      `  [ "$arg" = ${quote(subcommand)} ] || continue`,
      `  waited=0`,
      `  while [ "$waited" -lt ${Math.round(seconds * 5)} ]; do`,
      `    sleep 0.2`,
      `    waited=$((waited + 1))`,
      `  done`,
      "done",
    ].join("\n"),
    body,
  );
}

/**
 * Run `body` with a `git` that runs `preamble` and then the real git.
 *
 * Everything asked of it is answered as it would be, because the real git stands
 * behind it. Its path comes from the environment rather than from a guess at
 * where git is installed.
 */
async function withGitThat<T>(preamble: string, body: () => T | Promise<T>): Promise<T> {
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" });
  assert.equal(real.status, 0, "the test needs the real git to stand behind the fake");
  const realGit = real.stdout.trim();

  const directory = await mkdtemp(join(tmpdir(), "squiz-git-"));
  const previous = process.env["PATH"];
  try {
    standIn(
      directory,
      "git",
      ["#!/bin/sh", preamble, `exec ${quote(realGit)} "$@"`, ""].join("\n"),
    );
    process.env["PATH"] = `${directory}:${previous ?? ""}`;
    return await body();
  } finally {
    if (previous === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

async function readLines(path: string): Promise<readonly string[]> {
  const source = await readFile(path, "utf8");
  return source.split("\n").filter((line) => line !== "");
}

function quote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** One round's readings, with everything it established given. */
function established(found: Partial<RoundConfinement>): RoundConfinement {
  return {
    trackedFiles: { outcome: "unchanged" },
    otherEpisodes: { outcome: "alone" },
    marked: { outcome: "written" },
    ...found,
  };
}

/** What the episode has established after its rounds found `rounds`, in order. */
function after(...rounds: readonly Partial<RoundConfinement>[]): ConfinementEvidence | undefined {
  let evidence: ConfinementEvidence | undefined;
  for (const round of rounds) evidence = evidenceWith(evidence, established(round));
  return evidence;
}

/**
 * What an earlier round found is what the closing round's comment carries.
 *
 * A round that blocks posts no comment, so a file it named as changed reaches a
 * person through the closing round's comment or not at all. The closing round here
 * compared and found nothing, which is the answer that would overwrite it.
 */
test("a file an earlier round found changed survives a round that found nothing", () => {
  assert.deepEqual(
    after({ trackedFiles: { outcome: "changed", paths: [TRACKED] } }, {}),
    { ...nothingEstablished, changed: [TRACKED] },
  );
});

test("an earlier round that could not compare survives a closing round that could", () => {
  const shared = `the worktree is shared with live episode ${OTHER_KEY}`;
  assert.deepEqual(
    after(
      {
        otherEpisodes: { outcome: "shared", episodes: [{ id: OTHER_KEY, pid: 4021 }] },
        trackedFiles: { outcome: "not-taken", reason: shared },
      },
      {},
    ),
    { changed: [], moved: [], uncompared: [shared], shared: [OTHER_KEY], unestablished: [] },
  );
});

test("an earlier round that could not tell who else was here survives a round that was alone", () => {
  const killed = "ps was killed by SIGKILL";
  assert.deepEqual(
    after(
      {
        otherEpisodes: { outcome: "unknown", reason: killed },
        trackedFiles: {
          outcome: "not-taken",
          reason: `the live episodes of the worktree could not be established: ${killed}`,
        },
      },
      {},
    )?.unestablished,
    [killed],
  );
});

test("an episode whose rounds left the worktree alone establishes nothing at all", () => {
  assert.equal(after({}, {}, {}), undefined);
});

/**
 * A marker that was not written costs a later round its comparison rather than this
 * episode's, and nobody reading this pull request can act on it.
 */
test("a marker that was not written is nothing the episode establishes", () => {
  assert.equal(after({ marked: { outcome: "failed", reason: "EACCES" } }), undefined);
});

// One entry per path however many rounds changed it, which is what keeps the list
// bounded by the worktree rather than by the rounds.
test("a file two rounds changed is named once", () => {
  assert.deepEqual(
    after(
      { trackedFiles: { outcome: "changed", paths: [TRACKED] } },
      { trackedFiles: { outcome: "changed", paths: ["src/queue.ts", TRACKED] } },
    )?.changed,
    ["src/card.ts", "src/queue.ts"],
  );
});

/**
 * The lists stop growing, and what they keep is the earliest answer rather than the
 * latest.
 *
 * An attempt that is no round spends none of the round cap and fails the same way
 * every time the hook fires, so nothing bounds the firings of one episode. A list
 * that grew with them would grow without end, and an episode's earliest evidence is
 * the evidence a later firing must not push out.
 */
test("the reasons an episode keeps do not grow with its firings", () => {
  const firings = (howMany: number): readonly string[] => {
    let evidence: ConfinementEvidence | undefined;
    for (let firing = 0; firing < howMany; firing += 1) {
      evidence = evidenceWith(
        evidence,
        established({ trackedFiles: { outcome: "unknown", reason: `git exited ${firing}` } }),
      );
    }
    return evidence?.uncompared ?? [];
  };

  const kept = firings(100);
  assert.deepEqual(firings(400), kept, "the list grew with the firings, so nothing bounds it");
  assert.equal(
    kept[0],
    "git exited 0",
    "the earliest round's answer is the one a later firing must not push out",
  );
});

/** Sixty-four names under `prefix`, which is the whole of one list's cap. */
function aCapsWorth(prefix: string): readonly string[] {
  return Array.from({ length: 64 }, (_, index) => `${prefix}${String(index).padStart(2, "0")}`);
}

/**
 * The summary comment for an episode that raised nothing and established `found`.
 *
 * What a list keeps is worth what the comment says and nothing else, and the
 * comment is posted once and never edited.
 */
function commentOn(found: ConfinementEvidence | undefined): string {
  return renderSummary({
    rounds: [unspent],
    threads: [],
    findings: { outcomes: [] },
    because: "nothing-open",
    confinement: found ?? nothingEstablished,
    leftNotReviewed: null,
  });
}

/**
 * A later round that fills the cap pushes nothing of an earlier round's out.
 *
 * Round 1 names one changed file and blocks, and round 2 names sixty-four that all
 * sort before it. Choosing the sixty-four to keep from the sorted list drops the
 * earlier round's file, which this comment is the only report of, while the file
 * itself is still changed in the worktree.
 */
test("a file an earlier round found changed survives a later round that fills the cap", () => {
  const crowd = aCapsWorth("a").map((name) => `${name}.txt`);
  const evidence = after(
    { trackedFiles: { outcome: "changed", paths: [TRACKED] } },
    { trackedFiles: { outcome: "changed", paths: crowd } },
  );
  const comment = commentOn(evidence);

  assert.deepEqual(
    evidence?.changed,
    [...crowd.slice(0, 63), TRACKED],
    "the cap drops the entry that arrived last, and orders what it kept for display",
  );
  assert.ok(
    comment.includes(`\`${TRACKED}\``),
    `${TRACKED} changed in the worktree and the comment does not name it:\n${comment}`,
  );
});

/**
 * The same cap, over the episodes a round found in the worktree.
 *
 * An episode named by the round that blocked is the only account of who was in the
 * tree while that reviewer ran, and a later round that found a crowd must not take
 * its place.
 */
test("an episode an earlier round found here survives a later round that fills the cap", () => {
  const crowd = aCapsWorth("1");
  const evidence = after(
    {
      otherEpisodes: { outcome: "shared", episodes: [{ id: OTHER_KEY, pid: 4021 }] },
      trackedFiles: {
        outcome: "not-taken",
        reason: `the worktree is shared with live episode ${OTHER_KEY}`,
      },
    },
    {
      otherEpisodes: {
        outcome: "shared",
        episodes: crowd.map((id, index) => ({ id, pid: 5000 + index })),
      },
      trackedFiles: {
        outcome: "not-taken",
        reason: "the worktree is shared with 64 live episodes",
      },
    },
  );
  const comment = commentOn(evidence);

  assert.deepEqual(
    evidence?.shared,
    [...crowd.slice(0, 63), OTHER_KEY],
    "the cap drops the episode that arrived last, and orders what it kept for display",
  );
  assert.ok(
    comment.includes(OTHER_KEY),
    `episode ${OTHER_KEY} was in the worktree and the comment does not name it:\n${comment}`,
  );
});

function headOf(worktree: string): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" });
  assert.equal(result.status, 0, `git rev-parse: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * A reviewer that amended the commit under review through its shell, which leaves
 * every file as it was and changes what the coding agent would commit.
 */
function amendedTheCommit(episode: Episode): void {
  git(episode.worktree, "commit", "--quiet", "--amend", "--message", "the reviewer's amend");
}

test("a reviewer that amended the commit is named from a clean tree, and so is the comment", async () => {
  await withWorktree(async (episode) => {
    const was = headOf(episode.worktree);
    const confinement = await around(episode, () => amendedTheCommit(episode));
    const move = `from refs/heads/review-me at ${was} to refs/heads/review-me at ${headOf(episode.worktree)}`;

    assert.deepEqual(confinement.trackedFiles, {
      outcome: "changed",
      paths: [],
      head: {
        before: `refs/heads/review-me at ${was}`,
        after: `refs/heads/review-me at ${headOf(episode.worktree)}`,
      },
    });
    const comment = commentOn(evidenceWith(undefined, confinement));
    assert.ok(
      comment.includes(`- \`HEAD\` moved while the reviewer ran: ${move}`),
      `the reviewer moved HEAD and the comment does not say so:\n${comment}`,
    );
  });
});

// Another episode's commit in a shared tree is not this reviewer's, so HEAD is
// read with the files or not at all.
test("a HEAD moved in a shared worktree is not named as this reviewer's", async () => {
  await withWorktree(async (episode) => {
    liveEpisode(episode.worktree, OTHER_KEY);

    const confinement = await around(episode, () => amendedTheCommit(episode));

    assert.equal(confinement.trackedFiles.outcome, "not-taken");
    assert.deepEqual(evidenceWith(undefined, confinement)?.moved, []);
  });
});

test("a HEAD an earlier round found moved survives a round that found nothing", () => {
  const head = { before: "refs/heads/review-me at 1111", after: "refs/heads/review-me at 2222" };
  assert.deepEqual(after({ trackedFiles: { outcome: "changed", paths: [], head } }, {}), {
    ...nothingEstablished,
    moved: ["from refs/heads/review-me at 1111 to refs/heads/review-me at 2222"],
  });
});
