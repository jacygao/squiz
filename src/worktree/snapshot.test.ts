import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { deadlineIn } from "../reviewers/deadline.ts";
import { standIn } from "../testing/stand-in.ts";
import { addSnapshot, removeSnapshot, type SnapshotAddition } from "./snapshot.ts";

/** Run git in `directory` and return its stdout, failing the test rather than the fixture. */
function git(directory: string, ...args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

/** The identity is passed per command so the fixture does not depend on whoever runs it. */
function commit(directory: string, message: string): string {
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
  return git(directory, "rev-parse", "HEAD").trim();
}

async function withTemporaryDirectory<T>(body: (directory: string) => Promise<T> | T): Promise<T> {
  const directory = realpathSync(await mkdtemp(join(tmpdir(), "squiz-snapshot-")));
  try {
    return await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * A repository with `.squiz/` gitignored, as adoption requires, and a coding
 * agent's linked worktree beside it, holding a commit and an uncommitted change.
 *
 * The linked worktree is where a subagent works, and `git worktree add` from it
 * registers the snapshot in the common directory the two share.
 */
async function repositoryWithLinkedWorktree(root: string): Promise<{
  readonly main: string;
  readonly agent: string;
  readonly head: string;
}> {
  const main = join(root, "main");
  await mkdir(main);
  git(main, "init", "--quiet", "--initial-branch", "main");
  await writeFile(join(main, ".gitignore"), ".squiz/\n");
  await writeFile(join(main, "code.ts"), "one\n");
  commit(main, "the base");

  const agent = join(root, "agent");
  git(main, "worktree", "add", "--quiet", "-b", "feature", agent);
  await writeFile(join(agent, "code.ts"), "two\n");
  const head = commit(agent, "the change under review");
  await writeFile(join(agent, "code.ts"), "uncommitted\n");
  await writeFile(join(agent, "untracked.ts"), "not committed\n");
  return { main, agent, head };
}

function addedPath(addition: SnapshotAddition): string {
  assert.equal(addition.outcome, "added", addition.outcome === "failed" ? addition.reason : "");
  return addition.outcome === "added" ? addition.path : "";
}

function reasonOf(result: { readonly outcome: string; readonly reason?: string }): string {
  assert.equal(result.outcome, "failed");
  return result.reason ?? "";
}

const roundTwo = { pullRequest: 41, round: 2 } as const;

test("a snapshot is a detached worktree at the commit, under the round's directory", async () => {
  await withTemporaryDirectory(async (root) => {
    const { agent, head } = await repositoryWithLinkedWorktree(root);

    const path = addedPath(addSnapshot(agent, { ...roundTwo, commit: head }, deadlineIn(30_000)));

    assert.equal(path, join(agent, ".squiz", "41", "rounds", "2", "tree"));
    assert.equal(git(path, "rev-parse", "HEAD").trim(), head);
    assert.equal(
      spawnSync("git", ["symbolic-ref", "--quiet", "HEAD"], { cwd: path }).status,
      1,
      "the snapshot's HEAD is detached",
    );
  });
});

test("a snapshot holds the commit and none of the coding agent's uncommitted work", async () => {
  await withTemporaryDirectory(async (root) => {
    const { agent, head } = await repositoryWithLinkedWorktree(root);

    const path = addedPath(addSnapshot(agent, { ...roundTwo, commit: head }, deadlineIn(30_000)));

    assert.equal(readFileSync(join(path, "code.ts"), "utf8"), "two\n");
    assert.equal(existsSync(join(path, "untracked.ts")), false);
  });
});

test("a snapshot shows in neither the coding agent's git status nor its HEAD", async () => {
  await withTemporaryDirectory(async (root) => {
    const { agent, head } = await repositoryWithLinkedWorktree(root);
    const statusBefore = git(agent, "status", "--porcelain");

    addedPath(addSnapshot(agent, { ...roundTwo, commit: head }, deadlineIn(30_000)));

    assert.equal(git(agent, "status", "--porcelain"), statusBefore);
    assert.equal(git(agent, "rev-parse", "HEAD").trim(), head);
    assert.equal(git(agent, "symbolic-ref", "HEAD").trim(), "refs/heads/feature");
  });
});

test("a commit the repository lacks is fetched before the snapshot is added", async () => {
  await withTemporaryDirectory(async (root) => {
    const { main, agent } = await repositoryWithLinkedWorktree(root);
    // The remote has a commit pushed from elsewhere, which the agent's
    // repository has never seen.
    const remote = join(root, "remote");
    git(root, "clone", "--quiet", main, remote);
    git(remote, "switch", "--quiet", "-c", "elsewhere");
    await writeFile(join(remote, "code.ts"), "pushed from elsewhere\n");
    const pushed = commit(remote, "pushed from elsewhere");
    git(agent, "remote", "add", "origin", remote);
    assert.notEqual(spawnSync("git", ["cat-file", "-e", `${pushed}^{commit}`], { cwd: agent }).status, 0);

    const addition = addSnapshot(agent, { ...roundTwo, commit: pushed }, deadlineIn(30_000));

    const path = addedPath(addition);
    assert.equal(addition.outcome === "added" && addition.fetched, true);
    assert.equal(readFileSync(join(path, "code.ts"), "utf8"), "pushed from elsewhere\n");
  });
});

test("a commit already present is not fetched", async () => {
  await withTemporaryDirectory(async (root) => {
    const { agent, head } = await repositoryWithLinkedWorktree(root);
    // No remote is configured, so a fetch would fail.
    const addition = addSnapshot(agent, { ...roundTwo, commit: head }, deadlineIn(30_000));

    addedPath(addition);
    assert.equal(addition.outcome === "added" && addition.fetched, false);
  });
});

test("a fetch that fails is a failure naming the commit, and nothing is added", async () => {
  await withTemporaryDirectory(async (root) => {
    const { agent } = await repositoryWithLinkedWorktree(root);
    const missing = "0123456789abcdef0123456789abcdef01234567";

    const addition = addSnapshot(agent, { ...roundTwo, commit: missing }, deadlineIn(30_000));

    assert.match(reasonOf(addition), new RegExp(`^${missing} could not be fetched: git exited \\d+`, "u"));
    assert.equal(existsSync(join(agent, ".squiz", "41", "rounds", "2", "tree")), false);
  });
});

test("a fetch that succeeds without bringing the commit is a failure, and nothing is added", async () => {
  await withTemporaryDirectory(async (root) => {
    const { agent } = await repositoryWithLinkedWorktree(root);
    const missing = "0123456789abcdef0123456789abcdef01234567";

    const addition = await withGitWhoseFetchDoesNothing(root, () =>
      addSnapshot(agent, { ...roundTwo, commit: missing }, deadlineIn(30_000)),
    );

    assert.equal(reasonOf(addition), `the fetch finished without bringing ${missing}`);
    assert.equal(existsSync(join(agent, ".squiz", "41", "rounds", "2", "tree")), false);
  });
});

test("a snapshot already standing at the path is a failure naming it, and is left alone", async () => {
  await withTemporaryDirectory(async (root) => {
    const { agent, head } = await repositoryWithLinkedWorktree(root);
    // A killed round's leftover, which recovery removes, not this. An empty
    // directory is the case git itself would accept and add into.
    const leftover = join(agent, ".squiz", "41", "rounds", "2", "tree");
    await mkdir(leftover, { recursive: true });

    const addition = addSnapshot(agent, { ...roundTwo, commit: head }, deadlineIn(30_000));

    assert.equal(reasonOf(addition), `something already stands at ${leftover}`);
    assert.equal(existsSync(leftover), true);
    assert.equal(git(agent, "worktree", "list", "--porcelain").includes(leftover), false);
  });
});

test("a deadline with nothing left starts nothing", async () => {
  await withTemporaryDirectory(async (root) => {
    const { agent, head } = await repositoryWithLinkedWorktree(root);

    const addition = addSnapshot(agent, { ...roundTwo, commit: head }, deadlineIn(0));

    assert.match(reasonOf(addition), /ran out of the time it was given/u);
    assert.equal(existsSync(join(agent, ".squiz", "41", "rounds", "2", "tree")), false);
  });
});

test("a fetch that spends the deadline leaves the add unstarted", async () => {
  await withTemporaryDirectory(async (root) => {
    const { agent } = await repositoryWithLinkedWorktree(root);
    const missing = "0123456789abcdef0123456789abcdef01234567";

    const addition = await withGitWhoseFetchHangs(root, () =>
      addSnapshot(agent, { ...roundTwo, commit: missing }, deadlineIn(500)),
    );

    assert.equal(reasonOf(addition), `${missing} could not be fetched: git ran out of the time it was given`);
    assert.equal(existsSync(join(agent, ".squiz", "41", "rounds", "2", "tree")), false);
  });
});

test("a commit that is not a full object name is refused before git sees it", async () => {
  await withTemporaryDirectory(async (root) => {
    const { agent } = await repositoryWithLinkedWorktree(root);

    const addition = addSnapshot(agent, { ...roundTwo, commit: "--upload-pack=touch pwned" }, deadlineIn(30_000));

    assert.equal(reasonOf(addition), `"--upload-pack=touch pwned" is not a full commit name`);
  });
});

test("removal leaves git worktree list as it was before the add, from a linked worktree", async () => {
  await withTemporaryDirectory(async (root) => {
    const { main, agent, head } = await repositoryWithLinkedWorktree(root);
    const listBefore = git(main, "worktree", "list", "--porcelain");
    const path = addedPath(addSnapshot(agent, { ...roundTwo, commit: head }, deadlineIn(30_000)));
    assert.notEqual(git(main, "worktree", "list", "--porcelain"), listBefore);

    assert.deepEqual(removeSnapshot(agent, path), { outcome: "removed" });

    assert.equal(git(main, "worktree", "list", "--porcelain"), listBefore);
    assert.equal(existsSync(path), false);
  });
});

test("removal succeeds where the reviewer left changes, untracked files and build output", async () => {
  await withTemporaryDirectory(async (root) => {
    const { main, agent, head } = await repositoryWithLinkedWorktree(root);
    const listBefore = git(main, "worktree", "list", "--porcelain");
    const path = addedPath(addSnapshot(agent, { ...roundTwo, commit: head }, deadlineIn(30_000)));
    await writeFile(join(path, "code.ts"), "edited by the reviewer\n");
    await writeFile(join(path, "probe.ts"), "left behind\n");
    await mkdir(join(path, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(path, "node_modules", "pkg", "index.js"), "installed\n");
    await writeFile(join(path, ".gitignore"), "node_modules/\n");

    assert.deepEqual(removeSnapshot(agent, path), { outcome: "removed" });

    assert.equal(existsSync(path), false);
    assert.equal(git(main, "worktree", "list", "--porcelain"), listBefore);
  });
});

test("a removal that fails says so", async () => {
  await withTemporaryDirectory(async (root) => {
    const { agent } = await repositoryWithLinkedWorktree(root);
    const path = join(agent, ".squiz", "41", "rounds", "2", "tree");

    const removal = removeSnapshot(agent, path);

    assert.match(reasonOf(removal), new RegExp(`^the snapshot at ${path} could not be removed: git exited \\d+`, "u"));
  });
});

/** Run `body` with a `git` whose fetch exits 0 having done nothing. */
async function withGitWhoseFetchDoesNothing<T>(root: string, body: () => T): Promise<T> {
  return withFakeFetch(root, "exit 0", body);
}

/** Run `body` with a `git` whose fetch never finishes. */
async function withGitWhoseFetchHangs<T>(root: string, body: () => T): Promise<T> {
  return withFakeFetch(root, "exec sleep 30", body);
}

/** Run `body` with a `git` that runs `fetch` as `script`, and hands every other call to the real git. */
async function withFakeFetch<T>(root: string, script: string, body: () => T): Promise<T> {
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" });
  assert.equal(real.status, 0, "the test needs the real git to stand behind the fake");
  const directory = join(root, "fake-git");
  await mkdir(directory);
  standIn(
    directory,
    "git",
    ["#!/bin/sh", `[ "$1" = fetch ] && { ${script}; }`, `exec '${real.stdout.trim()}' "$@"`, ""].join("\n"),
  );
  const previous = process.env["PATH"];
  process.env["PATH"] = `${directory}:${previous ?? ""}`;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previous;
  }
}
