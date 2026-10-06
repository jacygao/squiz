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
import { chmodSync, realpathSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { renderSummary } from "../github/summary-body.ts";
import { unspent } from "../reviewers/adapter.ts";
import { deadlineIn } from "../reviewers/deadline.ts";
import { standIn } from "../testing/stand-in.ts";
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
  const before = readBeforeReviewer(episode.worktree, deadlineIn(windowMs));
  await between();
  return readAfterReviewer(before, deadlineIn(windowMs));
}

/** A reviewer that wrote to the file under review, through its shell. */
async function wroteToTheTree(episode: Episode): Promise<void> {
  await appendFile(join(episode.worktree, TRACKED), "// line 2\n", "utf8");
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

test("a file the reviewer wrote to is named", async () => {
  await withWorktree(async (episode) => {
    const confinement = await around(episode, () => wroteToTheTree(episode));
    assert.deepEqual(confinement.trackedFiles, { outcome: "changed", paths: [TRACKED] });
  });
});

test("a reviewer that wrote nothing leaves the tree unchanged", async () => {
  await withWorktree(async (episode) => {
    const confinement = await around(episode, () => {});
    assert.deepEqual(confinement.trackedFiles, { outcome: "unchanged" });
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
    // is the one that could not be taken.
    await breakGit(episode);
    const confinement = await around(episode, () => {});

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
    const before = readBeforeReviewer(episode.worktree, deadlineIn(WINDOW_MS));
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

function quote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** One round's readings, with everything it established given. */
function established(found: Partial<RoundConfinement>): RoundConfinement {
  return {
    trackedFiles: { outcome: "unchanged" },
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
 * A round that leaves threads open posts no summary, so a file it named as changed
 * reaches a person through the closing round's comment or not at all. The closing round here
 * compared and found nothing, which is the answer that would overwrite it.
 */
test("a file an earlier round found changed survives a round that found nothing", () => {
  assert.deepEqual(
    after({ trackedFiles: { outcome: "changed", paths: [TRACKED] } }, {}),
    { ...nothingEstablished, changed: [TRACKED] },
  );
});

test("an earlier round that could not compare survives a closing round that could", () => {
  const short = "the round had too little of its window left to read the worktree";
  assert.deepEqual(
    after({ trackedFiles: { outcome: "not-taken", reason: short } }, {}),
    { ...nothingEstablished, uncompared: [short] },
  );
});

test("an episode whose rounds left the worktree alone establishes nothing at all", () => {
  assert.equal(after({}, {}, {}), undefined);
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
 * An attempt that is no round spends none of the round cap and can fail the same
 * way on every run, so nothing bounds the firings of one episode. A list
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
 * Round 1 names one changed file and leaves threads open, and round 2 names
 * sixty-four that all sort before it. Choosing the sixty-four to keep from the
 * sorted list drops the earlier round's file, which this comment is the only
 * report of, while the file itself is still changed in the worktree.
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

/**
 * Each reviewer reads a snapshot that only it writes, so what another episode of
 * the worktree recorded says nothing about the snapshot. A running marker an
 * earlier version left there is read by nothing.
 */
test("another episode's state in the worktree takes nothing from the comparison or the comment", async () => {
  await withWorktree(async (episode) => {
    liveEpisode(episode.worktree, OTHER_KEY);
    const other = episodeAt(episode.worktree, Number(OTHER_KEY));
    await writeFile(join(other.directory, "running.json"), `{"pid": 4021}\n`, "utf8");
    await mkdir(episode.directory, { recursive: true });
    await writeFile(join(episode.directory, "running.json"), `{"pid": 4022}\n`, "utf8");
    const was = headOf(episode.worktree);

    const confinement = await around(episode, async () => {
      await wroteToTheTree(episode);
      git(episode.worktree, "commit", "--quiet", "--all", "--message", "the reviewer's commit");
    });
    const comment = commentOn(evidenceWith(undefined, confinement));

    const move = `from refs/heads/review-me at ${was} to refs/heads/review-me at ${headOf(episode.worktree)}`;
    assert.ok(
      comment.includes(`- A file changed in the worktree while the reviewer ran: \`${TRACKED}\``),
      `the reviewer changed ${TRACKED} and the comment does not say so:\n${comment}`,
    );
    assert.ok(
      comment.includes(`- \`HEAD\` moved while the reviewer ran: ${move}`),
      `the reviewer moved HEAD and the comment does not say so:\n${comment}`,
    );
  });
});

test("a HEAD an earlier round found moved survives a round that found nothing", () => {
  const head = { before: "refs/heads/review-me at 1111", after: "refs/heads/review-me at 2222" };
  assert.deepEqual(after({ trackedFiles: { outcome: "changed", paths: [], head } }, {}), {
    ...nothingEstablished,
    moved: ["from refs/heads/review-me at 1111 to refs/heads/review-me at 2222"],
  });
});

/**
 * The episode's worktree with a snapshot added in it by `git worktree add`, as a
 * round adds one, so that a write made through the snapshot reaches the git
 * directory the two share.
 */
function snapshotIn(episode: Episode): string {
  const tree = join(episode.worktree, ".squiz", KEY, "rounds", "1", "tree");
  git(episode.worktree, "-c", "core.hooksPath=/dev/null", "worktree", "add", "--quiet", "--detach", tree, "HEAD");
  return tree;
}

/** What `husky` does as a `prepare` script, run in the snapshot as `run_tests` runs it. */
function setTheHooksPath(tree: string): void {
  git(tree, "config", "core.hooksPath", ".husky/_");
}

const SHARED_NOTE =
  "- The git config or hooks this repository's worktrees share changed while the reviewer ran." +
  " The reviewer's tests may have changed them, or anything else using the repository may have:" +
  " `core.hookspath` in `config`";

test("at deep, a key the test command set in the shared config is named in the comment", async () => {
  await withWorktree(async (episode) => {
    const tree = snapshotIn(episode);
    const before = readBeforeReviewer(tree, deadlineIn(WINDOW_MS), episode.worktree);
    setTheHooksPath(tree);
    const confinement = readAfterReviewer(before, deadlineIn(WINDOW_MS));

    assert.deepEqual(confinement.trackedFiles, { outcome: "unchanged" });
    assert.deepEqual(confinement.sharedConfig, {
      outcome: "changed",
      changes: [{ file: "config", key: "core.hookspath" }],
    });
    const comment = commentOn(evidenceWith(undefined, confinement));
    assert.ok(comment.includes(SHARED_NOTE), `the comment does not name the key:\n${comment}`);
  });
});

/**
 * At `read` the reviewer has nothing that runs the project's code, so a change
 * to the shared config is someone else's, and the comment is the one a round
 * that never read the config would post.
 */
test("at read, a change to the shared config is not read and changes nothing in the comment", async () => {
  await withWorktree(async (episode) => {
    const tree = snapshotIn(episode);
    const before = readBeforeReviewer(tree, deadlineIn(WINDOW_MS));
    setTheHooksPath(tree);
    const confinement = readAfterReviewer(before, deadlineIn(WINDOW_MS));

    assert.equal(confinement.sharedConfig, undefined);
    assert.equal(evidenceWith(undefined, confinement), undefined);
  });
});

test("at deep, a shared reading that could not be taken is a note of its own", async () => {
  await withWorktree(async (episode) => {
    const tree = snapshotIn(episode);
    const before = readBeforeReviewer(tree, deadlineIn(WINDOW_MS), episode.worktree);
    const exclude = join(episode.worktree, ".git", "info", "exclude");
    chmodSync(exclude, 0o000);
    let confinement: RoundConfinement;
    try {
      confinement = readAfterReviewer(before, deadlineIn(WINDOW_MS));
    } finally {
      chmodSync(exclude, 0o644);
    }

    assert.equal(confinement.sharedConfig?.outcome, "unknown");
    const comment = commentOn(evidenceWith(undefined, confinement));
    assert.ok(
      comment.includes(
        "- A round could not tell whether the git config or hooks this repository's worktrees share" +
          " changed while the reviewer ran: the reading after could not be taken: info/exclude could not be read",
      ),
      `a reading that failed reads as a config nobody changed:\n${comment}`,
    );
  });
});

test("at deep, a round with too little of its window left says it did not read the shared config", async () => {
  await withWorktree(async (episode) => {
    const tree = snapshotIn(episode);
    const before = readBeforeReviewer(tree, deadlineIn(0), episode.worktree);
    const confinement = readAfterReviewer(before, deadlineIn(WINDOW_MS));
    assert.equal(confinement.sharedConfig?.outcome, "not-taken");
  });
});

test("a shared key an earlier round found changed survives a round that found nothing", () => {
  const changed = { outcome: "changed", changes: [{ file: "config", key: "core.hookspath" }] } as const;
  assert.deepEqual(after({ sharedConfig: changed }, { sharedConfig: { outcome: "unchanged" } }), {
    ...nothingEstablished,
    sharedChanged: ["`core.hookspath` in `config`"],
  });
});
