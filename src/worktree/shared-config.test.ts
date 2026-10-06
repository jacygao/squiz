/**
 * Every fixture is a real repository with the snapshot added by `git worktree
 * add`, as a round adds it. A write made through the snapshot then lands where it
 * lands for a round, in the directory the snapshot shares, and a test that wrote
 * to a repository of its own would pass whether or not that directory is read.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, realpathSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { deadlineIn } from "../reviewers/deadline.ts";
import {
  compareSharedConfig,
  readSharedConfig,
  type SharedConfigComparison,
} from "./shared-config.ts";

function git(directory: string, ...args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** The coding agent's worktree, the snapshot inside it, and the directory both share. */
type Repository = { readonly worktree: string; readonly snapshot: string; readonly common: string };

async function withSnapshot<T>(body: (repository: Repository) => Promise<T> | T): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "squiz-shared-"));
  try {
    const worktree = realpathSync(directory);
    git(worktree, "init", "--quiet", "--initial-branch", "review-me");
    await writeFile(join(worktree, ".gitignore"), ".squiz/\n", "utf8");
    git(worktree, "add", ".");
    git(
      worktree,
      "-c",
      "user.email=squiz@example.invalid",
      "-c",
      "user.name=Squiz",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "--message",
      "the change under review",
    );
    const snapshot = join(worktree, ".squiz", "41", "rounds", "1", "tree");
    git(worktree, "-c", "core.hooksPath=/dev/null", "worktree", "add", "--quiet", "--detach", snapshot, "HEAD");
    const common = join(worktree, ".git");
    // The fixture is worth nothing unless the snapshot has a git directory of its
    // own and shares this one, which is the arrangement a round's write crosses.
    assert.notEqual(git(snapshot, "rev-parse", "--path-format=absolute", "--git-dir"), common);
    assert.equal(git(snapshot, "rev-parse", "--path-format=absolute", "--git-common-dir"), common);
    return await body({ worktree, snapshot, common });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Both readings, with `between` standing for the test command. */
async function around(
  repository: Repository,
  between: () => Promise<void> | void,
): Promise<SharedConfigComparison> {
  const before = readSharedConfig(repository.snapshot, repository.worktree, deadlineIn(60_000));
  await between();
  const after = readSharedConfig(repository.snapshot, repository.worktree, deadlineIn(60_000));
  return compareSharedConfig(before, after);
}

test("a key the test command set from the snapshot is named, with the file it is in", async () => {
  await withSnapshot(async (repository) => {
    const comparison = await around(repository, () => {
      // What `husky` does as a `prepare` script, run where `run_tests` runs.
      git(repository.snapshot, "config", "core.hooksPath", ".husky/_");
    });

    assert.equal(git(repository.worktree, "config", "--get", "core.hooksPath"), ".husky/_");
    assert.deepEqual(comparison, {
      outcome: "changed",
      changes: [{ file: "config", key: "core.hookspath" }],
    });
  });
});

test("a test command that wrote nothing leaves the shared files unchanged", async () => {
  await withSnapshot(async (repository) => {
    assert.deepEqual(await around(repository, () => {}), { outcome: "unchanged" });
  });
});

test("a key whose value changed is named, and a key removed is named", async () => {
  await withSnapshot(async (repository) => {
    git(repository.worktree, "config", "squiz.kept", "one");
    git(repository.worktree, "config", "squiz.gone", "two");
    const comparison = await around(repository, () => {
      git(repository.snapshot, "config", "squiz.kept", "three");
      git(repository.snapshot, "config", "--unset", "squiz.gone");
    });

    assert.deepEqual(comparison, {
      outcome: "changed",
      changes: [
        { file: "config", key: "squiz.gone" },
        { file: "config", key: "squiz.kept" },
      ],
    });
  });
});

// A change git does not read as a key, such as a comment, is still a change to
// the file, and the file is named where no key can be.
test("a config changed without a key changing names the file", async () => {
  await withSnapshot(async (repository) => {
    const comparison = await around(repository, () =>
      appendFile(join(repository.common, "config"), "# a comment\n", "utf8"),
    );
    assert.deepEqual(comparison, { outcome: "changed", changes: [{ file: "config" }] });
  });
});

test("a hook written into the shared hooks directory is named", async () => {
  await withSnapshot(async (repository) => {
    const comparison = await around(repository, () =>
      writeFile(join(repository.common, "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n", "utf8"),
    );
    assert.deepEqual(comparison, { outcome: "changed", changes: [{ file: "hooks/pre-commit" }] });
  });
});

test("a line added to the shared exclude file is named", async () => {
  await withSnapshot(async (repository) => {
    const comparison = await around(repository, () =>
      appendFile(join(repository.common, "info", "exclude"), "dist/\n", "utf8"),
    );
    assert.deepEqual(comparison, { outcome: "changed", changes: [{ file: "info/exclude" }] });
  });
});

test("a key set in the main worktree's own config is named", async () => {
  await withSnapshot(async (repository) => {
    git(repository.worktree, "config", "extensions.worktreeConfig", "true");
    const comparison = await around(repository, () => {
      git(repository.worktree, "config", "--worktree", "core.hooksPath", ".husky/_");
    });
    assert.deepEqual(comparison, {
      outcome: "changed",
      changes: [{ file: "config.worktree", key: "core.hookspath" }],
    });
  });
});

// The coding agent may work in a linked worktree, whose own config sits in the
// shared directory under that worktree's name rather than in the snapshot's.
test("a key set in the coding agent's linked worktree config is named", async () => {
  await withSnapshot(async (repository) => {
    const agent = join(repository.worktree, ".squiz", "agent");
    git(repository.worktree, "worktree", "add", "--quiet", "--detach", agent, "HEAD");
    const snapshot = join(agent, ".squiz", "41", "rounds", "1", "tree");
    git(agent, "worktree", "add", "--quiet", "--detach", snapshot, "HEAD");
    git(agent, "config", "extensions.worktreeConfig", "true");

    const before = readSharedConfig(snapshot, agent, deadlineIn(60_000));
    git(agent, "config", "--worktree", "core.hooksPath", ".husky/_");
    const after = readSharedConfig(snapshot, agent, deadlineIn(60_000));

    assert.deepEqual(compareSharedConfig(before, after), {
      outcome: "changed",
      changes: [{ file: "worktrees/agent/config.worktree", key: "core.hookspath" }],
    });
  });
});

// A missing file is an answer, as a deleted tracked file is: the config that
// was there and is not is named, rather than the reading failing.
test("a config that appeared or went away is named rather than a reading that failed", async () => {
  await withSnapshot(async (repository) => {
    const before = readSharedConfig(repository.snapshot, repository.worktree, deadlineIn(60_000));
    await writeFile(join(repository.common, "config.worktree"), "[squiz]\n\tadded = yes\n", "utf8");
    const after = readSharedConfig(repository.snapshot, repository.worktree, deadlineIn(60_000));

    assert.deepEqual(compareSharedConfig(before, after), {
      outcome: "changed",
      changes: [{ file: "config.worktree", key: "squiz.added" }],
    });
    assert.deepEqual(compareSharedConfig(after, before), {
      outcome: "changed",
      changes: [{ file: "config.worktree", key: "squiz.added" }],
    });
  });
});

test("a shared file that cannot be read is a reading that failed, not a config nobody changed", async () => {
  await withSnapshot(async (repository) => {
    const exclude = join(repository.common, "info", "exclude");
    const before = readSharedConfig(repository.snapshot, repository.worktree, deadlineIn(60_000));
    chmodSync(exclude, 0o000);
    try {
      const after = readSharedConfig(repository.snapshot, repository.worktree, deadlineIn(60_000));
      const comparison = compareSharedConfig(before, after);
      assert.equal(comparison.outcome, "unknown");
      assert.match(
        comparison.outcome === "unknown" ? comparison.reason : "",
        /the reading after could not be taken: info\/exclude could not be read/u,
      );
    } finally {
      chmodSync(exclude, 0o644);
    }
  });
});

test("a directory that is no repository is a reading that failed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "squiz-shared-none-"));
  try {
    await mkdir(join(directory, "tree"));
    const reading = readSharedConfig(join(directory, "tree"), directory, deadlineIn(60_000));
    assert.equal(reading.outcome, "failed");
    assert.equal(
      compareSharedConfig(reading, reading).outcome,
      "unknown",
      "no repository read as a config nobody changed would report a test command that wrote nothing",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a reading with no time left is one that failed", async () => {
  await withSnapshot((repository) => {
    const reading = readSharedConfig(repository.snapshot, repository.worktree, deadlineIn(0));
    assert.deepEqual(reading, { outcome: "failed", reason: "the reading ran out of the time it was given" });
  });
});
