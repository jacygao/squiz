import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));

type Run = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

/**
 * Fire the hook in `directory` with `path` as its `PATH`.
 *
 * As a process, because the exit code and the stream a line landed on are what
 * the gate is judged by, and neither is observable from inside this one.
 */
function hook(directory: string, path: string): Run {
  const result = spawnSync(process.execPath, [cli, "hook"], {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, PATH: path },
  });
  assert.equal(result.error, undefined, `the hook could not be run: ${String(result.error)}`);
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

type FakeGh = {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly status?: number;
};

type Fake = {
  /** A `PATH` that finds this `gh` before any other. */
  readonly path: string;
  readonly wasRun: () => boolean;
  readonly arguments: () => readonly string[];
};

/** A `gh` in `directory` that answers as `fake` says and records its arguments. */
async function fakeGh(directory: string, fake: FakeGh): Promise<Fake> {
  const argumentLog = join(directory, "gh-arguments");
  const binary = join(directory, "gh");
  await writeFile(
    binary,
    [
      "#!/bin/sh",
      'for argument in "$@"; do',
      `  printf '%s\\n' "$argument" >> ${quote(argumentLog)}`,
      "done",
      `printf '%s' ${quote(fake.stdout ?? "")}`,
      `printf '%s' ${quote(fake.stderr ?? "")} >&2`,
      `exit ${fake.status ?? 0}`,
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(binary, 0o755);
  return {
    path: `${directory}${delimiter}${process.env["PATH"] ?? ""}`,
    wasRun: () => existsSync(argumentLog),
    arguments: () =>
      existsSync(argumentLog)
        ? readFileSync(argumentLog, "utf8").split("\n").filter((line) => line !== "")
        : [],
  };
}

/** A `PATH` holding git and nothing else, so `gh` cannot be found on it. */
function gitOnlyPath(directory: string): string {
  const path = join(directory, "one-tool");
  mkdirSync(path);
  symlinkSync(whichGit(), join(path, "git"));
  return path;
}

function whichGit(): string {
  for (const entry of (process.env["PATH"] ?? "").split(delimiter)) {
    if (entry === "") continue;
    const candidate = join(entry, "git");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not this entry. The next one, or none at all.
    }
  }
  return assert.fail("git is not on PATH, and every fixture here needs it");
}

function quote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

async function withTemporaryDirectory<T>(body: (directory: string) => Promise<T> | T): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "squiz-hook-"));
  try {
    return await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function git(directory: string, ...args: readonly string[]): void {
  const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
}

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

/** The pointer is one line, whatever it had to say. */
function assertOneLine(stderr: string): void {
  assert.equal(stderr.split("\n").length, 2, `the pointer is not one line: ${stderr}`);
}

test("a branch with a pull request is asked about, and nothing is said", async () => {
  // The test that fails if the gate is taken out: with no gate the hook exits 0
  // in silence, which is exactly what a branch with no pull request looks like.
  // Asking gh is the only thing the found case leaves behind.
  await withTemporaryDirectory(async (directory) => {
    commitOn(directory, "review/the-gate");
    const gh = await fakeGh(directory, { stdout: '[{"number":142}]\n' });

    const result = hook(directory, gh.path);

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "", "a round that got as far as a pull request has nothing to say");
    assert.deepEqual(gh.arguments().slice(-2), ["--head", "review/the-gate"]);
  });
});

test("a branch with no pull request posts nothing, runs nothing and says nothing", async () => {
  await withTemporaryDirectory(async (directory) => {
    commitOn(directory, "review/the-gate");
    const gh = await fakeGh(directory, { stdout: "[]\n" });

    const result = hook(directory, gh.path);

    assert.equal(result.code, 0, "only exit 2 blocks a turn, and no round ran");
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "", "silence is what a branch with no pull request looks like");
    assert.ok(gh.wasRun(), "the branch was never asked about");
  });
});

test("a gh that failed says so, where a branch with no pull request would say nothing", async () => {
  await withTemporaryDirectory(async (directory) => {
    commitOn(directory, "review/the-gate");
    // It prints an empty list as well as failing, so nothing but the exit
    // status stands between a broken install and a silent round.
    const gh = await fakeGh(directory, {
      status: 1,
      stdout: "[]\n",
      stderr: "HTTP 401: Bad credentials\nTry authenticating with: gh auth login\n",
    });

    const result = hook(directory, gh.path);

    assert.equal(result.code, 0, "a broken gh must not stop the coding agent finishing its turn");
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      'squiz: no review ran: the pull request for "review/the-gate" could not be looked up: ' +
        "gh exited 1: HTTP 401: Bad credentials\n",
    );
  });
});

test("a gh that is not installed says so", async () => {
  await withTemporaryDirectory((directory) => {
    commitOn(directory, "review/the-gate");

    const result = hook(directory, gitOnlyPath(directory));

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^squiz: no review ran: .*gh could not be run/u);
    assertOneLine(result.stderr);
  });
});

test("a detached HEAD asks gh nothing and says nothing", async () => {
  await withTemporaryDirectory(async (directory) => {
    commitOn(directory, "main");
    git(directory, "checkout", "--quiet", "--detach");
    const gh = await fakeGh(directory, { stdout: '[{"number":142}]\n' });

    const result = hook(directory, gh.path);

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.equal(gh.wasRun(), false, "a detached HEAD is not a branch to ask GitHub about");
  });
});

test("a directory that is no repository says so, and asks gh nothing", async () => {
  await withTemporaryDirectory(async (directory) => {
    const gh = await fakeGh(directory, { stdout: '[{"number":142}]\n' });

    const result = hook(directory, gh.path);

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      /^squiz: no review ran: the current branch could not be resolved: git exited 128: fatal: not a git repository/u,
    );
    assertOneLine(result.stderr);
    assert.equal(gh.wasRun(), false);
  });
});

test("nothing in a branch name reaches a shell", async () => {
  // `>pwned` writes a file if any of this is ever parsed by one, and the whole
  // name arriving as one argument is what says it was not.
  await withTemporaryDirectory(async (directory) => {
    const branch = "evil/$(id);>pwned";
    commitOn(directory, branch);
    const gh = await fakeGh(directory, { stdout: "[]\n" });

    const result = hook(directory, gh.path);

    assert.equal(result.code, 0);
    assert.deepEqual(gh.arguments().slice(-2), ["--head", branch]);
    assert.equal(existsSync(join(directory, "pwned")), false, "the branch name reached a shell");
    assert.equal(result.stderr, "");
  });
});
