import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { currentBranch } from "./branch.ts";

/** Run git in `directory`, and fail the test rather than the fixture. */
function git(directory: string, ...args: readonly string[]): void {
  const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
}

async function withTemporaryDirectory<T>(body: (directory: string) => Promise<T> | T): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "squiz-branch-"));
  try {
    return await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * A repository with one commit on `branch`.
 *
 * The identity is passed per command because the fixture must not depend on
 * whoever's git configuration the tests happen to run under.
 */
function commitOn(directory: string, branch: string): void {
  git(directory, "init", "--quiet", "--initial-branch", branch);
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
    "--allow-empty",
    "--message",
    "a commit to hang a branch off",
  );
}

test("the branch checked out in the directory is the one that comes back", async () => {
  await withTemporaryDirectory((directory) => {
    commitOn(directory, "review/the-gate");

    assert.deepEqual(currentBranch(directory), { outcome: "branch", name: "review/the-gate" });
  });
});

test("the branch resolves the same from a subdirectory of the worktree", async () => {
  // The hook is given the session's directory, which is inside the worktree and
  // not necessarily its root.
  // (docs/notes/the-worktree-toplevel-separates-concurrent-subagents.md)
  await withTemporaryDirectory(async (directory) => {
    commitOn(directory, "review/the-gate");
    const inside = join(directory, "src", "deep");
    await mkdir(inside, { recursive: true });

    assert.deepEqual(currentBranch(inside), { outcome: "branch", name: "review/the-gate" });
  });
});

test("a branch name carrying shell metacharacters comes back as it was written", async () => {
  await withTemporaryDirectory((directory) => {
    const branch = "evil/$(id);rm-rf&`x`";
    commitOn(directory, branch);

    assert.deepEqual(currentBranch(directory), { outcome: "branch", name: branch });
  });
});

test("a detached HEAD is no branch, and that is not a failure", async () => {
  await withTemporaryDirectory((directory) => {
    commitOn(directory, "main");
    git(directory, "checkout", "--quiet", "--detach");

    assert.deepEqual(currentBranch(directory), { outcome: "detached" });
  });
});

test("a directory that is no repository is a failure carrying git's own words", async () => {
  await withTemporaryDirectory((directory) => {
    const result = currentBranch(directory);

    assert.equal(result.outcome, "failed");
    assert.match(
      result.outcome === "failed" ? result.reason : "",
      /^git exited 128: fatal: not a git repository/u,
    );
  });
});

test("a git that is not installed is a failure", async () => {
  await withTemporaryDirectory((directory) => {
    const previous = process.env["PATH"];
    // A PATH holding one empty directory rather than none: an unset PATH sends
    // the lookup to a default one, which is where git actually is.
    process.env["PATH"] = directory;
    try {
      const result = currentBranch(directory);

      assert.equal(result.outcome, "failed");
      assert.match(result.outcome === "failed" ? result.reason : "", /git could not be run/u);
    } finally {
      if (previous === undefined) delete process.env["PATH"];
      else process.env["PATH"] = previous;
    }
  });
});
