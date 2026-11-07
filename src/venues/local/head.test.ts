import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { deadlineIn } from "../../reviewers/deadline.ts";
import { changeDiff } from "../../reviewers/git-tools.ts";
import { addSnapshot, removeSnapshot } from "../../worktree/snapshot.ts";
import type { Change } from "../venue.ts";
import { buildHead, type HeadBuild, provideCommits } from "./head.ts";

const RACER = fileURLToPath(new URL("../../testing/head-racer.ts", import.meta.url));

/** Run git in `directory` and return its stdout, failing the test rather than the fixture. */
function git(directory: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync("git", args, { cwd: directory, encoding: "utf8", env });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

/** The identity is passed per command so the fixture does not depend on whoever runs it. */
function commit(directory: string, message: string): string {
  git(directory, ["add", "--all"]);
  git(directory, [
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
  ]);
  return git(directory, ["rev-parse", "HEAD"]).trim();
}

type Fixture = {
  readonly root: string;
  readonly main: string;
  /** A linked worktree, whose index is not at `.git/index`, holding every kind of change. */
  readonly agent: string;
  /** The agent's `.squiz/local/`, where the venue keeps its objects and index copies. */
  readonly local: string;
  readonly base: string;
};

/**
 * A repository and a linked worktree beside it, whose working tree changes the
 * base in each way a change can: a modified file, a deletion, a mode change, a
 * retargeted symlink, a tracked file `.gitignore` names, an untracked file, and
 * two untracked files `.gitignore` excludes.
 */
async function withFixture<T>(body: (fixture: Fixture) => Promise<T> | T): Promise<T> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "squiz-head-")));
  const temporary = join(root, "temporary");
  await mkdir(temporary);
  const previous = process.env["TMPDIR"];
  process.env["TMPDIR"] = temporary;
  try {
    const main = join(root, "main");
    await mkdir(main);
    git(main, ["init", "--quiet", "--initial-branch", "main"]);
    await writeFile(join(main, ".gitignore"), "ignored*\nbuild/\n");
    await writeFile(join(main, "kept.txt"), "kept\n");
    await writeFile(join(main, "changed.txt"), "before\n");
    await writeFile(join(main, "deleted.txt"), "going\n");
    await writeFile(join(main, "script.sh"), "echo run\n");
    symlinkSync("kept.txt", join(main, "link"));
    await writeFile(join(main, "ignored-tracked.txt"), "tracked before\n");
    git(main, ["add", "--force", "ignored-tracked.txt"]);
    const base = commit(main, "the base");

    const agent = join(root, "agent");
    git(main, ["worktree", "add", "--quiet", "-b", "feature", agent]);
    await writeFile(join(agent, "changed.txt"), "after\n");
    await unlink(join(agent, "deleted.txt"));
    chmodSync(join(agent, "script.sh"), 0o755);
    await unlink(join(agent, "link"));
    symlinkSync("changed.txt", join(agent, "link"));
    await writeFile(join(agent, "ignored-tracked.txt"), "tracked after\n");
    await writeFile(join(agent, "untracked.txt"), "new\n");
    await writeFile(join(agent, "ignored-new.txt"), "never added\n");
    await mkdir(join(agent, "build"));
    await writeFile(join(agent, "build", "out.txt"), "output\n");

    return await body({ root, main, agent, local: join(agent, ".squiz", "local"), base });
  } finally {
    if (previous === undefined) delete process.env["TMPDIR"];
    else process.env["TMPDIR"] = previous;
    await rm(root, { recursive: true, force: true });
  }
}

function builtHead(build: HeadBuild): string {
  assert.equal(build.outcome, "built", build.outcome === "built" ? "" : build.reason);
  return build.outcome === "built" ? build.head : "";
}

/** Git in `directory`, reading the local venue's objects beside the repository's. */
function gitWithHeads(directory: string, local: string, args: readonly string[]): string {
  return git(directory, args, { ...process.env, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(local, "objects") });
}

/** Every file under `directory`, each with its mode and a digest of its content or its link's target. */
function fingerprint(directory: string): string {
  const lines: string[] = [];
  const walk = (at: string, name: string): void => {
    const found = lstatSync(at);
    if (found.isDirectory()) {
      lines.push(`${name}/ ${found.mode.toString(8)}`);
      for (const entry of readdirSync(at).sort()) walk(join(at, entry), `${name}/${entry}`);
      return;
    }
    const content = found.isSymbolicLink() ? readlinkSync(at) : readFileSync(at);
    lines.push(`${name} ${found.mode.toString(8)} ${createHash("sha256").update(content).digest("hex")}`);
  };
  walk(directory, "");
  return lines.join("\n");
}

function indexCopies(local: string): readonly string[] {
  return existsSync(local) ? readdirSync(local).filter((name) => name.startsWith("index.")) : [];
}

function changeOf(base: string, head: string): Change {
  return { key: "k", name: "the working tree", rerun: "squiz review", summaryAt: "in .squiz/local/summary.md", followUp: "", base, head, description: "" };
}

test("two builds of an unchanged worktree are the same commit, whatever the clock, identity and config say", async () => {
  await withFixture(async ({ root, agent, local, base }) => {
    const first = builtHead(buildHead(agent, base, deadlineIn(30_000)));

    // A home whose config signs every commit with a program that fails, and
    // names another identity and encoding, with the dates and names git reads
    // from the environment all set.
    const home = join(root, "home");
    await mkdir(home);
    const signer = join(home, "sign");
    await writeFile(signer, "#!/bin/sh\nexit 1\n");
    chmodSync(signer, 0o755);
    await writeFile(
      join(home, ".gitconfig"),
      `[user]\n\tname = Someone\n\temail = someone@example.invalid\n[commit]\n\tgpgSign = true\n[gpg]\n\tprogram = ${signer}\n[i18n]\n\tcommitEncoding = ISO-8859-1\n`,
    );
    const changed: Record<string, string> = {
      HOME: home,
      GIT_AUTHOR_NAME: "Other",
      GIT_AUTHOR_EMAIL: "other@example.invalid",
      GIT_AUTHOR_DATE: "2001-02-03T04:05:06Z",
      GIT_COMMITTER_NAME: "Other",
      GIT_COMMITTER_EMAIL: "other@example.invalid",
      GIT_COMMITTER_DATE: "2001-02-03T04:05:06Z",
    };
    const saved = Object.fromEntries(Object.keys(changed).map((key) => [key, process.env[key]]));
    Object.assign(process.env, changed);
    let second: string;
    try {
      second = builtHead(buildHead(agent, base, deadlineIn(30_000)));
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    assert.equal(second, first, "the second build, under another clock, identity and config, made another commit");
    assert.equal(
      gitWithHeads(agent, local, ["cat-file", "commit", first]).replace(/^tree [0-9a-f]+\n/u, ""),
      `parent ${base}\nauthor squiz <squiz@localhost> 0 +0000\ncommitter squiz <squiz@localhost> 0 +0000\n\nsquiz: the working tree\n`,
    );
  });
});

test("a build changes nothing in the repository: not the worktree's index, its objects, nor any ref", async () => {
  await withFixture(({ main, agent, local, base }) => {
    const gitDirectory = join(main, ".git");
    const before = fingerprint(gitDirectory);
    builtHead(buildHead(agent, base, deadlineIn(30_000)));
    assert.equal(fingerprint(gitDirectory), before);
  });
});

test("a build changes nothing in a repository that splits its index", async () => {
  await withFixture(({ main, agent, local, base }) => {
    // A change of any size rewrites the shared part, which git keeps in the
    // repository's git directory rather than beside the index it serves.
    git(main, ["config", "core.splitIndex", "true"]);
    git(main, ["config", "splitIndex.maxPercentChange", "0"]);
    git(agent, ["update-index", "--split-index"]);
    const gitDirectory = join(main, ".git");
    const before = fingerprint(gitDirectory);
    builtHead(buildHead(agent, base, deadlineIn(30_000)));
    assert.equal(fingerprint(gitDirectory), before);
  });
});

test("a build runs none of the repository's hooks", async () => {
  await withFixture(async ({ root, main, agent, local, base }) => {
    const ran = join(root, "hook-ran");
    await writeFile(join(main, ".git", "hooks", "post-index-change"), `#!/bin/sh\ntouch '${ran}'\n`, { mode: 0o755 });
    builtHead(buildHead(agent, base, deadlineIn(30_000)));
    assert.equal(existsSync(ran), false, "the post-index-change hook ran");
  });
});

test("the head holds what git add --all would: tracked, deleted, re-moded, relinked and untracked files, and no ignored one", async () => {
  await withFixture(({ agent, local, base }) => {
    const head = builtHead(buildHead(agent, base, deadlineIn(30_000)));
    const blob = (content: string): string => hashOf(agent, content);
    const listed = gitWithHeads(agent, local, ["ls-tree", "-r", head]);
    assert.equal(
      listed,
      [
        `100644 blob ${blob("ignored*\nbuild/\n")}\t.gitignore`,
        `100644 blob ${blob("after\n")}\tchanged.txt`,
        `100644 blob ${blob("tracked after\n")}\tignored-tracked.txt`,
        `100644 blob ${blob("kept\n")}\tkept.txt`,
        `120000 blob ${blob("changed.txt")}\tlink`,
        `100755 blob ${blob("echo run\n")}\tscript.sh`,
        `100644 blob ${blob("new\n")}\tuntracked.txt`,
        "",
      ].join("\n"),
    );
  });
});

function hashOf(directory: string, content: string): string {
  const result = spawnSync("git", ["hash-object", "--stdin"], { cwd: directory, encoding: "utf8", input: content });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("the snapshot of the built head, given its alternates, diffs to the working tree's change byte for byte", async () => {
  await withFixture(async ({ root, agent, local, base }) => {
    const head = builtHead(buildHead(agent, base, deadlineIn(30_000)));
    const provided = provideCommits(agent, changeOf(base, head), deadlineIn(30_000));
    assert.deepEqual(provided, { outcome: "ready", alternates: [join(local, "objects")] });
    const alternates = provided.outcome === "ready" ? provided.alternates : [];
    assert.equal(
      spawnSync("git", ["cat-file", "-e", head], { cwd: agent }).status === 0,
      false,
      "the head was written into the repository",
    );

    const added = addSnapshot(agent, { key: "1", round: 1, commit: head, base, alternates }, deadlineIn(30_000));
    assert.equal(added.outcome, "added", added.outcome === "failed" ? added.reason : "");
    const snapshot = added.outcome === "added" ? added.path : "";
    try {
      const diff = await changeDiff(snapshot);
      assert.equal(diff.failed, false, diff.text);

      // The worktree's own diff against the base, with its untracked files
      // shown as new through an index of the test's own.
      const index = join(root, "worktree-index");
      copyFileSync(git(agent, ["rev-parse", "--path-format=absolute", "--git-path", "index"]).trim(), index);
      const env = { ...process.env, GIT_INDEX_FILE: index, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
      git(agent, ["add", "--intent-to-add", "--all"], env);
      const expected = git(agent, ["--no-pager", "diff", "--no-ext-diff", "--no-textconv", "--no-color", base], env);
      assert.match(expected, /untracked\.txt/u);
      assert.equal(diff.text, expected);
    } finally {
      removeSnapshot(snapshot);
    }
  });
});

test("provideCommits fails where the head is not among the venue's objects", async () => {
  await withFixture(({ agent, local, base }) => {
    const missing = "0123456789abcdef0123456789abcdef01234567";
    const provided = provideCommits(agent, changeOf(base, missing), deadlineIn(30_000));
    assert.equal(provided.outcome, "failed");
    assert.match(provided.outcome === "failed" ? provided.reason : "", new RegExp(missing, "u"));
  });
});

test("a base the repository lacks fails, naming it", async () => {
  await withFixture(({ agent, base }) => {
    const absent = "7c1e0d3f2a4b5c6d7e8f90a1b2c3d4e5f6a7b8c9";
    assert.deepEqual(buildHead(agent, absent, deadlineIn(30_000)), {
      outcome: "failed",
      reason: `the base ${absent} is not a commit in ${agent}`,
    });

    // A head built earlier is among the venue's objects and not the repository's.
    const head = builtHead(buildHead(agent, base, deadlineIn(30_000)));
    assert.deepEqual(buildHead(agent, head, deadlineIn(30_000)), {
      outcome: "failed",
      reason: `the base ${head} is not a commit in ${agent}`,
    });

    const tree = git(agent, ["rev-parse", `${base}^{tree}`]).trim();
    assert.equal(buildHead(agent, tree, deadlineIn(30_000)).outcome, "failed");
  });
});

test("a base that is not a full commit sha is never handed to git", async () => {
  await withFixture(({ agent }) => {
    assert.deepEqual(buildHead(agent, "--output=/tmp/x", deadlineIn(30_000)), {
      outcome: "failed",
      reason: '"--output=/tmp/x" is not a full commit name',
    });
  });
});

test("the head's tree holds nothing of .squiz/, though the build writes there and the worktree had no .squiz/.gitignore", async () => {
  await withFixture(async ({ agent, local, base }) => {
    assert.equal(existsSync(join(agent, ".squiz")), false);

    const head = builtHead(buildHead(agent, base, deadlineIn(30_000)));

    const paths = gitWithHeads(agent, local, ["ls-tree", "-r", "--name-only", head]).split("\n");
    assert.deepEqual(
      paths.filter((path) => path.startsWith(".squiz")),
      [],
      "the venue's own objects and index copy were taken into the reviewed tree",
    );
    assert.equal(readFileSync(join(agent, ".squiz", ".gitignore"), "utf8"), "*\n");
  });
});

test("provideCommits names the venue's objects by an absolute path, which the snapshot requires", async () => {
  await withFixture(({ agent, local, base }) => {
    const head = builtHead(buildHead(agent, base, deadlineIn(30_000)));
    const provided = provideCommits(relative(process.cwd(), agent), changeOf(base, head), deadlineIn(30_000));
    assert.deepEqual(provided, { outcome: "ready", alternates: [join(local, "objects")] });
    assert.ok(isAbsolute(provided.outcome === "ready" ? (provided.alternates[0] ?? "") : ""));
  });
});

test("concurrent builds each use an index copy of their own, and none is left after", async () => {
  await withFixture(async ({ agent, local, base }) => {
    const at = Date.now() + 3_000;
    const race = (): Promise<string> =>
      new Promise((done, fail) => {
        const child = spawn(process.execPath, [RACER, agent, base, String(at)], { stdio: ["ignore", "pipe", "inherit"] });
        let out = "";
        child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
        child.on("error", fail);
        child.on("close", () => done(out));
      });
    const outcomes = (await Promise.all([race(), race(), race(), race()])).map((line) => JSON.parse(line) as HeadBuild);
    const heads = outcomes.map(builtHead);
    assert.equal(new Set(heads).size, 1, JSON.stringify(outcomes));
    assert.deepEqual(indexCopies(local), []);
  });
});

test("a build that fails leaves no index copy behind", async () => {
  await withFixture(async ({ agent, local, base }) => {
    const unreadable = join(agent, "unreadable.txt");
    await writeFile(unreadable, "secret\n");
    chmodSync(unreadable, 0o000);
    try {
      const build = buildHead(agent, base, deadlineIn(30_000));
      assert.equal(build.outcome, "failed");
      assert.match(build.outcome === "failed" ? build.reason : "", /unreadable\.txt|Permission denied/u);
      assert.ok(existsSync(local), "the build never reached the copy");
      assert.deepEqual(indexCopies(local), []);
    } finally {
      chmodSync(unreadable, 0o644);
    }
  });
});

test("a copy an earlier build left under this process's name changes nothing, even where the worktree has no index", async () => {
  await withFixture(async ({ agent, local, base }) => {
    // With no index to copy, the build starts from none, so a leftover is all
    // there would be to start from.
    await unlink(git(agent, ["rev-parse", "--path-format=absolute", "--git-path", "index"]).trim());
    const first = builtHead(buildHead(agent, base, deadlineIn(30_000)));
    await writeFile(join(local, `index.${process.pid}`), "not an index");
    assert.equal(builtHead(buildHead(agent, base, deadlineIn(30_000))), first);
    assert.deepEqual(indexCopies(local), []);
  });
});

test("a build with no time left runs nothing, and fails", async () => {
  await withFixture(({ agent, local, base }) => {
    const build = buildHead(agent, base, deadlineIn(0));
    assert.equal(build.outcome, "failed");
    assert.equal(existsSync(local), false);
  });
});
