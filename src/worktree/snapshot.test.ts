import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, sep } from "node:path";
import { test } from "node:test";

import { deadlineIn } from "../reviewers/deadline.ts";
import { gitBlame, gitLogSearch, gitShow } from "../reviewers/git-tools.ts";
import { standIn } from "../testing/stand-in.ts";
import { addSnapshot, removeSnapshot, type SnapshotAddition, snapshotPath } from "./snapshot.ts";

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

/**
 * Run `body` in a directory of its own, with `TMPDIR` pointing inside it, so the
 * snapshots it makes land there and go with it.
 */
async function withTemporaryDirectory<T>(body: (directory: string) => Promise<T> | T): Promise<T> {
  const directory = realpathSync(await mkdtemp(join(tmpdir(), "squiz-snapshot-")));
  const temporary = join(directory, "temporary");
  await mkdir(temporary);
  const previous = process.env["TMPDIR"];
  process.env["TMPDIR"] = temporary;
  try {
    return await body(directory);
  } finally {
    if (previous === undefined) delete process.env["TMPDIR"];
    else process.env["TMPDIR"] = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

/** Where this user's snapshots go, under the temporary directory `withTemporaryDirectory` sets. */
function snapshotsOf(root: string): string {
  return join(root, "temporary", `squiz-${userInfo().uid}`);
}

/** Where the round-two snapshot of `worktree` goes. */
function roundTwoPath(worktree: string): string {
  return snapshotPath(worktree, roundTwo);
}

/**
 * A repository whose own `.gitignore` lists `.squiz/`, as an older project's does, and a coding
 * agent's linked worktree beside it, holding a commit and an uncommitted change.
 *
 * The linked worktree is where a subagent works. Its repository is the common
 * directory it shares with the main worktree, and the snapshot is cloned from that.
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

test("a snapshot is a detached checkout of the commit, in the temporary directory", async () => {
  await withTemporaryDirectory(async (root) => {
    const { agent, head } = await repositoryWithLinkedWorktree(root);

    const path = addedPath(addSnapshot(agent, { ...roundTwo, commit: head }, deadlineIn(30_000)));

    assert.equal(path, roundTwoPath(agent));
    assert.ok(path.startsWith(snapshotsOf(root) + sep), `${path} is not under ${snapshotsOf(root)}`);
    assert.ok(path.endsWith(join("41", "rounds", "2", "tree")), `${path} does not name the round`);
    assert.equal(git(path, "rev-parse", "HEAD").trim(), head);
    assert.equal(
      spawnSync("git", ["symbolic-ref", "--quiet", "HEAD"], { cwd: path }).status,
      1,
      "the snapshot's HEAD is detached",
    );
  });
});

test("a snapshot is a clone with a git directory of its own, borrowing the repository's objects", async () => {
  await withTemporaryDirectory(async (root) => {
    const { main, agent, head } = await repositoryWithLinkedWorktree(root);
    const listBefore = git(main, "worktree", "list", "--porcelain");

    const path = addedPath(addSnapshot(agent, { ...roundTwo, commit: head }, deadlineIn(30_000)));

    const own = realpathSync(git(path, "rev-parse", "--path-format=absolute", "--git-common-dir").trim());
    assert.equal(own, join(realpathSync(path), ".git"), "the snapshot's git directory is inside it");
    assert.equal(
      readFileSync(join(path, ".git", "objects", "info", "alternates"), "utf8").trim(),
      join(realpathSync(main), ".git", "objects"),
    );
    assert.equal(git(main, "worktree", "list", "--porcelain"), listBefore, "git lists no snapshot");
  });
});

/** What a test command could change in the coding agent's repository, read from that repository. */
function agentRepositoryState(main: string, agent: string): string {
  const common = git(agent, "rev-parse", "--path-format=absolute", "--git-common-dir").trim();
  assert.equal(realpathSync(common), join(realpathSync(main), ".git"), "the state read is the coding agent's");
  return [
    readFileSync(join(common, "config"), "utf8"),
    ...readdirSync(join(common, "hooks"))
      .sort()
      .map((hook) => `${hook} ${createHash("sha256").update(readFileSync(join(common, "hooks", hook))).digest("hex")}`),
    git(agent, "for-each-ref", "--format=%(refname) %(objectname)"),
  ].join("\n---\n");
}

test("git config run in the snapshot leaves the coding agent's repository's config unchanged", async () => {
  await withTemporaryDirectory(async (root) => {
    const { main, agent, head } = await repositoryWithLinkedWorktree(root);
    const path = addedPath(addSnapshot(agent, { ...roundTwo, commit: head }, deadlineIn(30_000)));
    const before = agentRepositoryState(main, agent);

    // What a `husky` install runs.
    git(path, "config", "core.hooksPath", ".husky/_");

    assert.equal(agentRepositoryState(main, agent), before);
    assert.equal(spawnSync("git", ["config", "--get", "core.hooksPath"], { cwd: agent }).status, 1);
  });
});

test("a hook written in the snapshot's hooks directory is not in the coding agent's", async () => {
  await withTemporaryDirectory(async (root) => {
    const { main, agent, head } = await repositoryWithLinkedWorktree(root);
    const path = addedPath(addSnapshot(agent, { ...roundTwo, commit: head }, deadlineIn(30_000)));
    const before = agentRepositoryState(main, agent);

    // Where git in the snapshot looks for hooks, which is where an installer writes one.
    const hooks = git(path, "rev-parse", "--path-format=absolute", "--git-path", "hooks").trim();
    await writeFile(join(hooks, "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    assert.equal(agentRepositoryState(main, agent), before);
    assert.equal(existsSync(join(main, ".git", "hooks", "pre-commit")), false);
  });
});

test("a branch and a tag created in the snapshot are not the coding agent's repository's", async () => {
  await withTemporaryDirectory(async (root) => {
    const { main, agent, head } = await repositoryWithLinkedWorktree(root);
    const path = addedPath(addSnapshot(agent, { ...roundTwo, commit: head }, deadlineIn(30_000)));
    const before = agentRepositoryState(main, agent);

    git(path, "branch", "made-by-a-test");
    git(path, "tag", "v0-made-by-a-test");

    assert.equal(agentRepositoryState(main, agent), before);
  });
});

test("a push from the snapshot to its origin reaches nothing of the coding agent's", async () => {
  await withTemporaryDirectory(async (root) => {
    const { main, agent, head } = await repositoryWithLinkedWorktree(root);
    const path = addedPath(addSnapshot(agent, { ...roundTwo, commit: head }, deadlineIn(30_000)));
    const before = agentRepositoryState(main, agent);

    const pushed = spawnSync("git", ["push", "--quiet", "origin", "HEAD:refs/heads/pushed-by-a-test"], {
      cwd: path,
      encoding: "utf8",
    });

    assert.notEqual(pushed.status, 0, "the push is refused");
    assert.equal(agentRepositoryState(main, agent), before);
  });
});

test("the history tools answer in the snapshot as in a worktree at the same commit", async () => {
  await withTemporaryDirectory(async (root) => {
    const { main, agent } = await repositoryWithLinkedWorktree(root);
    await writeFile(join(agent, "code.ts"), "two\nthree\n");
    const middle = commit(agent, "add a third line");
    await writeFile(join(agent, "code.ts"), "two\nthree\nfour\n");
    const head = commit(agent, "add a fourth line");
    const worktree = join(root, "beside");
    git(main, "worktree", "add", "--quiet", "--detach", worktree, head);

    const path = addedPath(addSnapshot(agent, { ...roundTwo, commit: head }, deadlineIn(30_000)));

    const calls = [
      [gitLogSearch, { term: "three" }],
      [gitLogSearch, { term: "one" }],
      [gitBlame, { file: "code.ts", line: 2 }],
      [gitBlame, { file: "code.ts", line: 1 }],
      [gitShow, { commit: middle }],
      [gitShow, { commit: "HEAD~2" }],
    ] as const;
    for (const [tool, params] of calls) {
      const inSnapshot = await tool.run(path, params);
      const inWorktree = await tool.run(worktree, params);
      assert.equal(inSnapshot.failed, false, `${tool.name} ${JSON.stringify(params)}: ${inSnapshot.text}`);
      assert.deepEqual(inSnapshot, inWorktree, `${tool.name} ${JSON.stringify(params)}`);
    }
  });
});

// A suite that matches its own absolute paths against a glob, as mocha's
// `--ignore` does, skips every file under a component that begins with a dot.
test("no component of a snapshot's path begins with a dot, though the worktree's does", async () => {
  await withTemporaryDirectory(async (root) => {
    const { main, head } = await repositoryWithLinkedWorktree(root);
    const agent = join(main, ".claude", "worktrees", "agent-1");
    git(main, "worktree", "add", "--quiet", "--detach", agent, head);

    const path = addedPath(addSnapshot(agent, { ...roundTwo, commit: head }, deadlineIn(30_000)));

    assert.deepEqual(
      path.split(sep).filter((component) => component.startsWith(".")),
      [],
      `${path} has a component beginning with a dot`,
    );
  });
});

test("two worktrees' snapshots of the same round stand apart", async () => {
  await withTemporaryDirectory(async (root) => {
    const { main, agent, head } = await repositoryWithLinkedWorktree(root);
    const other = join(root, "other");
    git(main, "worktree", "add", "--quiet", "--detach", other, head);

    const first = addedPath(addSnapshot(agent, { ...roundTwo, commit: head }, deadlineIn(30_000)));
    const second = addedPath(addSnapshot(other, { ...roundTwo, commit: head }, deadlineIn(30_000)));

    assert.notEqual(first, second);
  });
});

test("a snapshot directory that is a link is refused, and nothing is added through it", async () => {
  await withTemporaryDirectory(async (root) => {
    const { agent, head } = await repositoryWithLinkedWorktree(root);
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, snapshotsOf(root));

    const addition = addSnapshot(agent, { ...roundTwo, commit: head }, deadlineIn(30_000));

    assert.equal(reasonOf(addition), `${snapshotsOf(root)} is not a directory of this user's alone`);
    assert.equal(git(agent, "worktree", "list", "--porcelain").includes(elsewhere), false);
  });
});

test("a snapshot directory others can write is refused", async () => {
  await withTemporaryDirectory(async (root) => {
    const { agent, head } = await repositoryWithLinkedWorktree(root);
    await mkdir(snapshotsOf(root));
    chmodSync(snapshotsOf(root), 0o777);

    const addition = addSnapshot(agent, { ...roundTwo, commit: head }, deadlineIn(30_000));

    assert.equal(reasonOf(addition), `${snapshotsOf(root)} is not a directory of this user's alone`);
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
    assert.equal(existsSync(roundTwoPath(agent)), false);
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
    assert.equal(existsSync(roundTwoPath(agent)), false);
  });
});

test("a snapshot already standing at the path is a failure naming it, and is left alone", async () => {
  await withTemporaryDirectory(async (root) => {
    const { agent, head } = await repositoryWithLinkedWorktree(root);
    // A killed round's leftover, which recovery removes, not this. An empty
    // directory is the case git itself would accept and add into.
    const leftover = roundTwoPath(agent);
    await mkdir(leftover, { recursive: true });

    const addition = addSnapshot(agent, { ...roundTwo, commit: head }, deadlineIn(30_000));

    assert.equal(reasonOf(addition), `something already stands at ${leftover}`);
    assert.equal("leftBehind" in addition, false, "what this attempt did not make is not handed over for removal");
    assert.equal(existsSync(leftover), true);
    assert.equal(git(agent, "worktree", "list", "--porcelain").includes(leftover), false);
  });
});

test("a deadline with nothing left starts nothing", async () => {
  await withTemporaryDirectory(async (root) => {
    const { agent, head } = await repositoryWithLinkedWorktree(root);

    const addition = addSnapshot(agent, { ...roundTwo, commit: head }, deadlineIn(0));

    assert.match(reasonOf(addition), /ran out of the time it was given/u);
    assert.equal(existsSync(roundTwoPath(agent)), false);
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
    assert.equal(existsSync(roundTwoPath(agent)), false);
  });
});

test("a commit that is not a full object name is refused before git sees it", async () => {
  await withTemporaryDirectory(async (root) => {
    const { agent } = await repositoryWithLinkedWorktree(root);

    const addition = addSnapshot(agent, { ...roundTwo, commit: "--upload-pack=touch pwned" }, deadlineIn(30_000));

    assert.equal(reasonOf(addition), `"--upload-pack=touch pwned" is not a full commit name`);
  });
});

test("the project's checkout hooks do not run in a snapshot", async () => {
  await withTemporaryDirectory(async (root) => {
    const { main, agent, head } = await repositoryWithLinkedWorktree(root);
    const ran = join(root, "hook-ran");
    await writeFile(join(main, ".git", "hooks", "post-checkout"), `#!/bin/sh\ntouch '${ran}'\n`, { mode: 0o755 });

    addedPath(addSnapshot(agent, { ...roundTwo, commit: head }, deadlineIn(30_000)));

    assert.equal(existsSync(ran), false);
  });
});

test("an add that fails after git made the snapshot names it for removal, apart from a refusal", async () => {
  await withTemporaryDirectory(async (root) => {
    const { agent, head } = await repositoryWithLinkedWorktree(root);

    const first = await withFakeCheckout(root, () =>
      addSnapshot(agent, { ...roundTwo, commit: head }, deadlineIn(30_000)),
    );
    const path = roundTwoPath(agent);
    assert.equal(first.outcome, "failed");
    assert.equal(first.outcome === "failed" && first.leftBehind, path);
    assert.deepEqual(removeSnapshot(path), { outcome: "removed" });
    assert.equal(addedPath(addSnapshot(agent, { ...roundTwo, commit: head }, deadlineIn(30_000))), path);
  });
});

test("removal leaves nothing on disk, and git lists no worktree at any point", async () => {
  await withTemporaryDirectory(async (root) => {
    const { main, agent, head } = await repositoryWithLinkedWorktree(root);
    const listBefore = git(main, "worktree", "list", "--porcelain");
    const path = addedPath(addSnapshot(agent, { ...roundTwo, commit: head }, deadlineIn(30_000)));
    assert.equal(git(main, "worktree", "list", "--porcelain"), listBefore);

    assert.deepEqual(removeSnapshot(path), { outcome: "removed" });

    assert.equal(git(main, "worktree", "list", "--porcelain"), listBefore);
    assert.equal(existsSync(path), false);
    const episode = dirname(dirname(dirname(path)));
    assert.equal(existsSync(episode), false, "the directories the snapshot sat in go with it");
  });
});

// The snapshot no longer goes with the coding agent's worktree, which whatever
// made it may remove while a round runs.
test("removal succeeds after the coding agent's worktree has gone", async () => {
  await withTemporaryDirectory(async (root) => {
    const { main, agent, head } = await repositoryWithLinkedWorktree(root);
    const path = addedPath(addSnapshot(agent, { ...roundTwo, commit: head }, deadlineIn(30_000)));
    await rm(agent, { recursive: true, force: true });

    assert.deepEqual(removeSnapshot(path), { outcome: "removed" });

    assert.equal(existsSync(path), false);
    assert.equal(git(main, "worktree", "list", "--porcelain").includes(path), false);
  });
});

test("removal succeeds where the reviewer left changes, untracked files and build output", async () => {
  await withTemporaryDirectory(async (root) => {
    const { agent, head } = await repositoryWithLinkedWorktree(root);
    const path = addedPath(addSnapshot(agent, { ...roundTwo, commit: head }, deadlineIn(30_000)));
    await writeFile(join(path, "code.ts"), "edited by the reviewer\n");
    await writeFile(join(path, "probe.ts"), "left behind\n");
    await mkdir(join(path, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(path, "node_modules", "pkg", "index.js"), "installed\n");
    await writeFile(join(path, ".gitignore"), "node_modules/\n");

    assert.deepEqual(removeSnapshot(path), { outcome: "removed" });

    assert.equal(existsSync(path), false);
  });
});

test("a removal that fails says so", async () => {
  await withTemporaryDirectory(async (root) => {
    const { agent } = await repositoryWithLinkedWorktree(root);
    const path = roundTwoPath(agent);

    const removal = removeSnapshot(path);

    assert.match(reasonOf(removal), new RegExp(`^the snapshot at ${path} could not be removed: `, "u"));
  });
});

test("removal refuses a path that is not a round's snapshot, and leaves it as it was", async () => {
  await withTemporaryDirectory(async (root) => {
    const { agent } = await repositoryWithLinkedWorktree(root);
    const episode = dirname(dirname(dirname(roundTwoPath(agent))));
    await mkdir(episode, { recursive: true });

    for (const path of [agent, episode, join(roundTwoPath(agent), "..", "..", "..", "..", "..")]) {
      assert.equal(reasonOf(removeSnapshot(path)), `${path} is not the path of a round's snapshot`);
      assert.equal(existsSync(path), true, `${path} is left`);
    }
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

/** Run `body` with a `git` whose checkout checks out and then exits 1. */
async function withFakeCheckout<T>(root: string, body: () => T): Promise<T> {
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" });
  assert.equal(real.status, 0, "the test needs the real git to stand behind the fake");
  const directory = join(root, "fake-git");
  await mkdir(directory);
  standIn(
    directory,
    "git",
    [
      "#!/bin/sh",
      `for word in "$@"; do [ "$word" = checkout ] && { '${real.stdout.trim()}' "$@"; exit 1; }; done`,
      `exec '${real.stdout.trim()}' "$@"`,
      "",
    ].join("\n"),
  );
  return withPathFirst(directory, body);
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
  return withPathFirst(directory, body);
}

/** Run `body` with `directory` first on PATH, so the git there stands in for the real one. */
function withPathFirst<T>(directory: string, body: () => T): T {
  const previous = process.env["PATH"];
  process.env["PATH"] = `${directory}:${previous ?? ""}`;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previous;
  }
}
