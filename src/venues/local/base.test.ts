/**
 * Where a worktree's work started, recorded at its first start and read as
 * the base of every review after. Every case runs real git, in repositories of
 * its own, because what moves the base is what git does to branches.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { deadlineIn } from "../../reviewers/deadline.ts";
import { readBase, recordBase } from "./base.ts";

function git(directory: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd: directory, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** Commit `file` holding `text`, with an identity of the test's own. */
function commit(directory: string, file: string, text = `${file}\n`): string {
  writeFileSync(join(directory, file), text);
  git(directory, ["add", "--all"]);
  git(directory, ["-c", "user.email=squiz@example.invalid", "-c", "user.name=Squiz", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", file]);
  return git(directory, ["rev-parse", "HEAD"]);
}

function rebase(directory: string, onto: string): void {
  git(directory, ["-c", "user.email=squiz@example.invalid", "-c", "user.name=Squiz", "-c", "commit.gpgsign=false", "rebase", "--quiet", onto]);
}

type Repository = {
  /** The upstream every clone pushes to and fetches from. */
  readonly origin: string;
  /** A second clone, standing in for everyone else's work on `main`. */
  readonly others: string;
  /** The clone the work happens in, on `main`, tracking `origin/main`. */
  readonly work: string;
};

/** A bare `origin` with one commit on `main`, and two clones of it. */
function repository(t: TestContext): Repository {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "squiz-base-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  git(root, ["init", "--quiet", "--bare", "--initial-branch", "main", origin]);
  const others = join(root, "others");
  git(root, ["clone", "--quiet", origin, others]);
  commit(others, "first.txt");
  git(others, ["push", "--quiet", "origin", "main"]);
  const work = join(root, "work");
  git(root, ["clone", "--quiet", origin, work]);
  return { origin, others, work };
}

/** Another commit on `origin/main`, made by someone else, and fetched into `work`. */
function mainMovesOn(repository: Repository, file: string): string {
  git(repository.others, ["pull", "--quiet", "--rebase", "origin", "main"]);
  const moved = commit(repository.others, file);
  git(repository.others, ["push", "--quiet", "origin", "main"]);
  git(repository.work, ["fetch", "--quiet", "origin"]);
  return moved;
}

function recorded(worktree: string): unknown {
  return JSON.parse(readFileSync(join(worktree, ".squiz", "local", "base.json"), "utf8"));
}

function baseOf(worktree: string): string {
  const read = readBase(worktree, deadlineIn(30_000));
  assert.equal(read.outcome, "found", read.outcome === "found" ? "" : read.reason);
  return read.outcome === "found" ? read.base : "";
}

function changedFiles(worktree: string, base: string): string {
  return git(worktree, ["diff", "--name-only", base, "HEAD"]);
}

test("a start records HEAD and every branch pointing at it, the checked-out one included", (t) => {
  const { work } = repository(t);
  const start = git(work, ["rev-parse", "HEAD"]);

  assert.deepEqual(recordBase(work, deadlineIn(30_000)), { outcome: "done" });

  // origin/HEAD is a symbolic ref, a name for origin/main and no branch of its own.
  assert.deepEqual(recorded(work), { commit: start, branches: ["refs/heads/main", "refs/remotes/origin/main"] });
});

test("a second start, after commits, leaves the first record as it was", (t) => {
  const { work } = repository(t);
  const start = git(work, ["rev-parse", "HEAD"]);
  recordBase(work, deadlineIn(30_000));
  const first = readFileSync(join(work, ".squiz", "local", "base.json"), "utf8");
  commit(work, "work.txt");

  assert.deepEqual(recordBase(work, deadlineIn(30_000)), { outcome: "done" });

  assert.equal(readFileSync(join(work, ".squiz", "local", "base.json"), "utf8"), first, "a resumed session overwrote the base");
  assert.equal(baseOf(work), start);
});

test("a start writes .squiz/.gitignore where it is missing, so the record stays out of git", (t) => {
  const { work } = repository(t);
  recordBase(work, deadlineIn(30_000));

  assert.equal(readFileSync(join(work, ".squiz", ".gitignore"), "utf8"), "*\n");
  assert.equal(git(work, ["status", "--porcelain", "--untracked-files=all"]), "");
});

test("(a) work on a branch from main, rebased onto main once it moved on, has the new main as its base", (t) => {
  const repo = repository(t);
  const { work } = repo;
  git(work, ["switch", "--quiet", "-c", "work"]);
  recordBase(work, deadlineIn(30_000));
  commit(work, "work.txt");
  const moved = mainMovesOn(repo, "others.txt");
  git(work, ["switch", "--quiet", "main"]);
  git(work, ["merge", "--quiet", "--ff-only", "origin/main"]);
  git(work, ["switch", "--quiet", "work"]);
  rebase(work, "main");

  const base = baseOf(work);

  assert.equal(base, moved, "the base stayed where the work started, and the change holds main's new commit");
  assert.equal(changedFiles(work, base), "work.txt");
});

test("(b) work committed straight onto the checked-out main keeps the recorded commit as its base", (t) => {
  const { work } = repository(t);
  const start = git(work, ["rev-parse", "HEAD"]);
  recordBase(work, deadlineIn(30_000));
  commit(work, "work.txt");

  const base = baseOf(work);

  assert.equal(base, start, "main moved with the work, and the change came out empty");
  assert.equal(changedFiles(work, base), "work.txt");
});

test("(c) the work's own branch on a remote, pushed on, is never its base", (t) => {
  const { work } = repository(t);
  const start = git(work, ["rev-parse", "HEAD"]);
  git(work, ["switch", "--quiet", "-c", "work"]);
  git(work, ["push", "--quiet", "-u", "origin", "work"]);
  recordBase(work, deadlineIn(30_000));
  assert.deepEqual(recorded(work), {
    commit: start,
    branches: ["refs/heads/main", "refs/heads/work", "refs/remotes/origin/main", "refs/remotes/origin/work"],
  });
  commit(work, "work.txt");
  git(work, ["push", "--quiet", "origin", "work"]);

  const base = baseOf(work);

  assert.equal(base, start, "origin/work moved with the work, and the change came out empty");
  assert.equal(changedFiles(work, base), "work.txt");
});

test("(d) a branch made from origin/main follows origin/main when it moves on and the work rebases", (t) => {
  const repo = repository(t);
  const { work } = repo;
  // main is left behind on purpose: only origin/main moves.
  git(work, ["switch", "--quiet", "-c", "work", "origin/main"]);
  recordBase(work, deadlineIn(30_000));
  commit(work, "work.txt");
  const moved = mainMovesOn(repo, "others.txt");
  rebase(work, "origin/main");

  const base = baseOf(work);

  assert.equal(base, moved);
  assert.equal(changedFiles(work, base), "work.txt");
});

test("(e) a Claude Code isolation branch left at the start commit changes nothing", (t) => {
  const repo = repository(t);
  const { work } = repo;
  git(work, ["switch", "--quiet", "-c", "worktree-agent-x", "origin/main"]);
  recordBase(work, deadlineIn(30_000));
  git(work, ["switch", "--quiet", "-c", "area/x", "origin/main"]);
  commit(work, "work.txt");
  const moved = mainMovesOn(repo, "others.txt");
  rebase(work, "origin/main");

  const base = baseOf(work);

  assert.equal(base, moved);
  assert.equal(changedFiles(work, base), "work.txt");
});

test("(f) a recorded branch that was deleted is left out", (t) => {
  const repo = repository(t);
  const { work } = repo;
  git(work, ["branch", "--quiet", "gone"]);
  git(work, ["switch", "--quiet", "-c", "work"]);
  recordBase(work, deadlineIn(30_000));
  commit(work, "work.txt");
  const moved = mainMovesOn(repo, "others.txt");
  rebase(work, "origin/main");
  git(work, ["branch", "--quiet", "-D", "gone"]);

  assert.equal(baseOf(work), moved);
});

test("(f) a recorded branch force-moved off the recorded commit's line is left out", (t) => {
  const repo = repository(t);
  const { work } = repo;
  const start = git(work, ["rev-parse", "HEAD"]);
  git(work, ["switch", "--quiet", "-c", "work"]);
  recordBase(work, deadlineIn(30_000));
  commit(work, "work.txt");
  // main is rewritten from nothing, so its merge-base with the work no longer
  // descends from where the work started.
  git(work, ["switch", "--quiet", "--orphan", "rewritten"]);
  commit(work, "rewritten.txt");
  git(work, ["branch", "--quiet", "--force", "main", "rewritten"]);
  git(work, ["switch", "--quiet", "work"]);

  const base = baseOf(work);

  assert.equal(base, start);
  assert.equal(changedFiles(work, base), "work.txt");
});

test("a worktree with no recorded base reviews nothing, with the line the local venue gives", (t) => {
  const { work } = repository(t);
  assert.deepEqual(readBase(work, deadlineIn(30_000)), {
    outcome: "none",
    reason: `${work} has no recorded base, which squiz records when a session or subagent starts there`,
  });
});

test("a recorded base the repository lacks reviews nothing, with the line the local venue gives", (t) => {
  const { work } = repository(t);
  const absent = "7c1e0d3f2a4b5c6d7e8f90a1b2c3d4e5f6a7b8c9";
  mkdirSync(join(work, ".squiz", "local"), { recursive: true });
  writeFileSync(join(work, ".squiz", "local", "base.json"), JSON.stringify({ commit: absent, branches: [] }));

  assert.deepEqual(readBase(work, deadlineIn(30_000)), {
    outcome: "none",
    reason: `the recorded base ${absent} is not a commit in ${work}`,
  });
});

test("a recorded base that is no full commit name is never handed to git", (t) => {
  const { work } = repository(t);
  mkdirSync(join(work, ".squiz", "local"), { recursive: true });
  writeFileSync(join(work, ".squiz", "local", "base.json"), JSON.stringify({ commit: "--output=/tmp/x", branches: [] }));

  const read = readBase(work, deadlineIn(30_000));
  assert.equal(read.outcome, "failed");
  assert.match(read.outcome === "failed" ? read.reason : "", /base\.json/u);
});

test("a start in a repository with no commit yet records nothing, and says why", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "squiz-base-empty-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "--quiet"]);

  const recordedNow = recordBase(root, deadlineIn(30_000));

  assert.equal(recordedNow.outcome, "failed");
  assert.equal(existsSync(join(root, ".squiz", "local", "base.json")), false);
});
