import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  compareTrackedFiles,
  readTrackedFiles,
  type TrackedFilesComparison,
  type TrackedFilesReading,
} from "./tracked-files.ts";

/** Run git in `directory`, and fail the test rather than the fixture. */
function git(directory: string, ...args: readonly string[]): void {
  const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
}

async function withTemporaryDirectory<T>(body: (directory: string) => Promise<T> | T): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "squiz-tracked-"));
  try {
    return await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Commit everything in `directory`.
 *
 * The identity is passed per command because the fixture must not depend on
 * whoever's git configuration the tests happen to run under.
 */
function commitEverything(directory: string, message: string): void {
  git(directory, "add", "--all");
  git(
    directory,
    "-c",
    "user.email=squiz@example.invalid",
    "-c",
    "user.name=Squiz",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "--message",
    message,
  );
}

/**
 * A worktree with a change under review in it.
 *
 * Two of its tracked paths hold a space and a newline, which are the characters
 * git quotes in any format but the NUL-separated one. `.squiz/` is the scratch
 * space: gitignored, inside the tree, and written to on every round.
 */
async function treeWithTrackedFiles(root: string): Promise<void> {
  git(root, "init", "--quiet", "--initial-branch", "review/the-round");
  await mkdir(join(root, "sub"), { recursive: true });
  await mkdir(join(root, ".squiz", "the-episode", "scratch"), { recursive: true });
  await writeFile(join(root, ".gitignore"), ".squiz/\n");
  await writeFile(join(root, "plain.ts"), "one\n");
  await writeFile(join(root, "sub", "nested.ts"), "two\n");
  await writeFile(join(root, "with space.ts"), "three\n");
  await writeFile(join(root, "with\nnewline.ts"), "four\n");
  await writeFile(join(root, ".squiz", "the-episode", "scratch", "compiled.mjs"), "scratch\n");
  commitEverything(root, "the change under review");
}

type Read = Extract<TrackedFilesReading, { outcome: "read" }>;

/** A reading that was taken, or a failed test carrying git's reason. */
function reading(directory: string): Read {
  const taken = readTrackedFiles(directory);
  if (taken.outcome === "failed") assert.fail(`the reading could not be taken: ${taken.reason}`);
  return taken;
}

function reasonOf(comparison: TrackedFilesComparison): string {
  return comparison.outcome === "unknown" ? comparison.reason : "";
}

test("two readings of an unchanged tree compare equal", async () => {
  await withTemporaryDirectory(async (root) => {
    await treeWithTrackedFiles(root);

    assert.deepEqual(compareTrackedFiles(reading(root), reading(root)), { outcome: "unchanged" });
  });
});

test("every tracked path is read, a space and a newline in one included", async () => {
  await withTemporaryDirectory(async (root) => {
    await treeWithTrackedFiles(root);

    const taken = reading(root);

    assert.equal(taken.root, realpathSync(root));
    assert.deepEqual(
      [...taken.content.keys()].sort(),
      [".gitignore", "plain.ts", "sub/nested.ts", "with space.ts", "with\nnewline.ts"].sort(),
    );
    assert.deepEqual([...taken.status.keys()], [], "the committed tree has nothing to report");
  });
});

test("a tree with no tracked files reads empty and compares equal", async () => {
  await withTemporaryDirectory(async (root) => {
    git(root, "init", "--quiet", "--initial-branch", "review/the-round");

    const before = reading(root);

    assert.deepEqual([...before.content.keys()], []);
    assert.deepEqual([...before.status.keys()], []);
    assert.deepEqual(compareTrackedFiles(before, reading(root)), { outcome: "unchanged" });
  });
});

test("a write to a gitignored path is not a change", async () => {
  await withTemporaryDirectory(async (root) => {
    await treeWithTrackedFiles(root);
    const before = reading(root);

    const scratch = join(root, ".squiz", "the-episode", "scratch");
    await writeFile(join(scratch, "compiled.mjs"), "compiled again\n");
    await mkdir(join(scratch, "jiti"), { recursive: true });
    await writeFile(join(scratch, "jiti", "pi-extension.3ffe37ba.mjs"), "the extension\n");

    assert.deepEqual(compareTrackedFiles(before, reading(root)), { outcome: "unchanged" });
    assert.deepEqual(
      [...reading(root).status.keys()],
      [],
      "an ignored path is not git's to report, so it never reaches a reading",
    );
  });
});

test("an edit, a new file, a staged file and a deletion are each named, and nothing else is", async () => {
  await withTemporaryDirectory(async (root) => {
    await treeWithTrackedFiles(root);
    const before = reading(root);

    await writeFile(join(root, "plain.ts"), "one, changed\n");
    await unlink(join(root, "sub", "nested.ts"));
    await writeFile(join(root, "probe.sh"), "#!/bin/sh\n");
    // A file in a directory of its own, because git names a new directory and
    // not what is in it unless it is asked for every untracked file.
    await mkdir(join(root, "probes"), { recursive: true });
    await writeFile(join(root, "probes", "deeper.sh"), "#!/bin/sh\n");
    await writeFile(join(root, "staged.ts"), "added and staged\n");
    git(root, "add", "staged.ts");

    assert.deepEqual(compareTrackedFiles(before, reading(root)), {
      outcome: "changed",
      paths: ["plain.ts", "probe.sh", "probes/deeper.sh", "staged.ts", "sub/nested.ts"],
    });
  });
});

test("a renamed tracked file is named at both paths", async () => {
  await withTemporaryDirectory(async (root) => {
    await treeWithTrackedFiles(root);
    const before = reading(root);

    git(root, "mv", "plain.ts", "moved.ts");

    assert.deepEqual(compareTrackedFiles(before, reading(root)), {
      outcome: "changed",
      paths: ["moved.ts", "plain.ts"],
    });
  });
});

test("a content change under a status entry that did not change is named", async () => {
  await withTemporaryDirectory(async (root) => {
    await treeWithTrackedFiles(root);
    const before = reading(root);

    // git skips a path marked assume-unchanged, so its status says nothing about
    // it however the content moves. This is the write the hashes are there for.
    git(root, "update-index", "--assume-unchanged", "plain.ts");
    await writeFile(join(root, "plain.ts"), "one, changed\n");

    const after = reading(root);

    assert.deepEqual([...after.status.keys()], [], "git reports nothing about the edited file");
    assert.deepEqual(compareTrackedFiles(before, after), {
      outcome: "changed",
      paths: ["plain.ts"],
    });
  });
});

test("staging a change already in the tree is named, though the bytes on disk did not move", async () => {
  await withTemporaryDirectory(async (root) => {
    await treeWithTrackedFiles(root);
    await writeFile(join(root, "plain.ts"), "one, changed\n");
    const before = reading(root);

    git(root, "add", "plain.ts");
    const after = reading(root);

    assert.equal(before.content.get("plain.ts"), after.content.get("plain.ts"));
    assert.deepEqual(compareTrackedFiles(before, after), {
      outcome: "changed",
      paths: ["plain.ts"],
    });
  });
});

test("a reading compared against itself names nothing", async () => {
  await withTemporaryDirectory(async (root) => {
    await treeWithTrackedFiles(root);
    await writeFile(join(root, "plain.ts"), "one, changed\n");
    await writeFile(join(root, "probe.sh"), "#!/bin/sh\n");

    const taken = reading(root);

    assert.deepEqual(compareTrackedFiles(taken, taken), { outcome: "unchanged" });
  });
});

test("taking a reading writes nothing, git's index included", async () => {
  await withTemporaryDirectory(async (root) => {
    await treeWithTrackedFiles(root);
    // A tracked file whose mtime moved is what makes git refresh the index and
    // write it back. Without one the reading has nothing to rewrite, and this
    // would pass whatever it asked git for.
    const long = new Date("2020-01-01T00:00:00Z");
    await utimes(join(root, "plain.ts"), long, long);
    const index = readFileSync(join(root, ".git", "index"));

    reading(root);

    assert.ok(readFileSync(join(root, ".git", "index")).equals(index), "the index was rewritten");

    const plain = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
    assert.equal(plain.stdout, "", "the tree is still clean");
    assert.ok(
      !readFileSync(join(root, ".git", "index")).equals(index),
      "a plain status left the index alone, so nothing above was proved",
    );
  });
});

test("a directory that is no repository is a reading that could not be taken", async () => {
  await withTemporaryDirectory((directory) => {
    const taken = readTrackedFiles(directory);

    assert.equal(taken.outcome, "failed");
    assert.match(
      taken.outcome === "failed" ? taken.reason : "",
      /^git exited 128: fatal: not a git repository/u,
    );
  });
});

test("a reading that could not be taken is unknown rather than unchanged", async () => {
  await withTemporaryDirectory(async (base) => {
    const root = join(base, "tree");
    const elsewhere = join(base, "no-repository");
    await mkdir(root);
    await mkdir(elsewhere);
    await treeWithTrackedFiles(root);
    const taken = reading(root);
    const failed = readTrackedFiles(elsewhere);

    const first = compareTrackedFiles(failed, taken);
    const second = compareTrackedFiles(taken, failed);

    assert.equal(first.outcome, "unknown");
    assert.match(reasonOf(first), /^the reading before could not be taken: git exited 128/u);
    assert.equal(second.outcome, "unknown");
    assert.match(reasonOf(second), /^the reading after could not be taken: git exited 128/u);
  });
});

test("readings of two worktrees are not compared", async () => {
  await withTemporaryDirectory(async (base) => {
    const first = join(base, "first");
    const second = join(base, "second");
    await mkdir(first);
    await treeWithTrackedFiles(first);
    git(first, "worktree", "add", "--quiet", second, "-b", "review/second");

    const answer = compareTrackedFiles(reading(first), reading(second));

    assert.equal(answer.outcome, "unknown");
    assert.match(reasonOf(answer), /^the readings are of two worktrees, /u);
  });
});

test("a tracked link is read by where it points, and one pointing nowhere is no change", async () => {
  await withTemporaryDirectory(async (root) => {
    await treeWithTrackedFiles(root);
    await symlink("plain.ts", join(root, "link.ts"));
    await symlink("nowhere.ts", join(root, "dangling.ts"));
    commitEverything(root, "two links");
    const before = reading(root);

    assert.deepEqual(
      compareTrackedFiles(before, reading(root)),
      { outcome: "unchanged" },
      "a link with no target is not a tracked file that was deleted",
    );

    await unlink(join(root, "link.ts"));
    await symlink("sub/nested.ts", join(root, "link.ts"));

    assert.deepEqual(compareTrackedFiles(before, reading(root)), {
      outcome: "changed",
      paths: ["link.ts"],
    });
  });
});
