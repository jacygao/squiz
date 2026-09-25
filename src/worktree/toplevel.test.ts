import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { worktreeToplevel } from "./toplevel.ts";

/** Run git in `directory`, and fail the test rather than the fixture. */
function git(directory: string, ...args: readonly string[]): void {
  const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
}

async function withTemporaryDirectory<T>(body: (directory: string) => Promise<T> | T): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "squiz-worktree-"));
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
    "a commit to hang a worktree off",
  );
}

/** What git answers with: the temporary directory with every symlink resolved. */
function resolved(directory: string): string {
  return realpathSync(directory);
}

test("the worktree root comes back rather than the directory the hook fired in", async () => {
  // The hook is given the session's directory, which is somewhere inside the
  // worktree and not necessarily its root. An episode's state hangs off the
  // root, so the two must not be confused.
  await withTemporaryDirectory(async (root) => {
    commitOn(root, "review/the-round");
    const inside = join(root, "src", "deep");
    await mkdir(inside, { recursive: true });

    assert.deepEqual(worktreeToplevel(inside), {
      outcome: "resolved",
      path: resolved(root),
    });
  });
});

test("two worktrees of one repository resolve apart", async () => {
  // Two subagents share an object store and nothing else, and this is what
  // separates their episodes.
  await withTemporaryDirectory(async (root) => {
    const first = join(root, "first");
    const second = join(root, "second");
    await mkdir(first);
    commitOn(first, "review/first");
    git(first, "worktree", "add", "--quiet", second, "-b", "review/second");

    const one = worktreeToplevel(first);
    const other = worktreeToplevel(second);

    assert.deepEqual(one, { outcome: "resolved", path: resolved(first) });
    assert.deepEqual(other, { outcome: "resolved", path: resolved(second) });
  });
});

test("a directory that is no repository is a failure carrying git's own words", async () => {
  await withTemporaryDirectory((directory) => {
    const result = worktreeToplevel(directory);

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
      const result = worktreeToplevel(directory);

      assert.equal(result.outcome, "failed");
      assert.match(result.outcome === "failed" ? result.reason : "", /git could not be run/u);
    } finally {
      if (previous === undefined) delete process.env["PATH"];
      else process.env["PATH"] = previous;
    }
  });
});
