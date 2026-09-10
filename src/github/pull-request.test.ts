import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { findPullRequestForBranch } from "./pull-request.ts";

type FakeGh = {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly status?: number;
};

type Fake = {
  /** Every argument `gh` was given, one per entry, exactly as it arrived. */
  readonly arguments: () => readonly string[];
  /** Where `gh` ran, or `null` where it was never run at all. */
  readonly workingDirectory: () => string | null;
};

/**
 * Run `body` with a `gh` on `PATH` that answers as `fake` says and records how
 * it was called.
 *
 * A fake binary rather than an injected runner: what reaches the subprocess —
 * the argument boundaries above all — is the thing being tested here, and an
 * injected runner would stand exactly where the evidence is.
 */
async function withFakeGh<T>(fake: FakeGh, body: (gh: Fake) => Promise<T> | T): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "squiz-gh-"));
  const argumentLog = join(directory, "arguments");
  const cwdLog = join(directory, "cwd");
  const script = [
    "#!/bin/sh",
    'for argument in "$@"; do',
    `  printf '%s\\n' "$argument" >> ${quote(argumentLog)}`,
    "done",
    `pwd -P > ${quote(cwdLog)}`,
    `printf '%s' ${quote(fake.stdout ?? "")}`,
    `printf '%s' ${quote(fake.stderr ?? "")} >&2`,
    `exit ${fake.status ?? 0}`,
    "",
  ].join("\n");

  const previous = process.env["PATH"];
  try {
    await writeFile(join(directory, "gh"), script, "utf8");
    await chmod(join(directory, "gh"), 0o755);
    process.env["PATH"] = `${directory}:${previous ?? ""}`;
    return await body({
      arguments: () => lines(argumentLog),
      workingDirectory: () => (existsSync(cwdLog) ? readFileSync(cwdLog, "utf8").trim() : null),
    });
  } finally {
    restorePath(previous);
    await rm(directory, { recursive: true, force: true });
  }
}

/** Run `body` with a `PATH` that holds nothing, so no `gh` can be found. */
async function withNoGh<T>(body: () => Promise<T> | T): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "squiz-empty-"));
  const previous = process.env["PATH"];
  try {
    process.env["PATH"] = directory;
    return await body();
  } finally {
    restorePath(previous);
    await rm(directory, { recursive: true, force: true });
  }
}

function restorePath(previous: string | undefined): void {
  if (previous === undefined) delete process.env["PATH"];
  else process.env["PATH"] = previous;
}

function lines(path: string): readonly string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((line) => line !== "");
}

/** `text` as one shell word, so a fixture can hold whatever it needs to. */
function quote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

test("a branch with an open pull request comes back with its number", async () => {
  await withFakeGh({ stdout: '[{"number":142}]\n' }, () => {
    const result = findPullRequestForBranch("feature", tmpdir());

    assert.deepEqual(result, { outcome: "found", number: 142 });
  });
});

test("an empty list is an answer of none", async () => {
  await withFakeGh({ stdout: "[]\n" }, () => {
    const result = findPullRequestForBranch("feature", tmpdir());

    assert.deepEqual(result, { outcome: "none" });
  });
});

test("a gh that exits non-zero is a failure, never an answer of none", async () => {
  // The case the three outcomes exist for, and the fixture is the cruel one: a
  // gh that failed and printed an empty list anyway. Only the exit status tells
  // a permanently broken install from a branch with no pull request, and the
  // two must never collapse into one answer.
  await withFakeGh(
    {
      status: 1,
      stdout: "[]\n",
      stderr: "HTTP 401: Bad credentials (https://api.github.com/graphql)\n",
    },
    () => {
      const result = findPullRequestForBranch("feature", tmpdir());

      assert.deepEqual(result, {
        outcome: "failed",
        reason: "gh exited 1: HTTP 401: Bad credentials (https://api.github.com/graphql)",
      });
    },
  );
});

test("a gh that is not installed is a failure", async () => {
  await withNoGh(() => {
    const result = findPullRequestForBranch("feature", tmpdir());

    assert.equal(result.outcome, "failed");
    assert.match(
      result.outcome === "failed" ? result.reason : "",
      /gh could not be run/u,
      "a gh that is not there must not read as a branch with no pull request",
    );
  });
});

test("a zero exit with no output at all is a failure", async () => {
  // `gh` said nothing and succeeded. There is no pull request in that, but
  // there is no "none" in it either.
  await withFakeGh({ stdout: "" }, () => {
    const result = findPullRequestForBranch("feature", tmpdir());

    assert.equal(result.outcome, "failed");
  });
});

test("an answer that is not JSON is a failure", async () => {
  await withFakeGh({ stdout: "gh: something went sideways\n" }, () => {
    const result = findPullRequestForBranch("feature", tmpdir());

    assert.deepEqual(result, {
      outcome: "failed",
      reason: "gh answered with what is not JSON: gh: something went sideways",
    });
  });
});

test("a row carrying no usable number is a failure", async () => {
  await withFakeGh({ stdout: '[{"number":"142"}]' }, () => {
    const result = findPullRequestForBranch("feature", tmpdir());

    assert.equal(result.outcome, "failed");
  });
});

test("the branch reaches gh as one argument, whatever git let into it", async () => {
  // git accepts `$( )`, backticks and `;` in a branch name, and a branch name
  // is attacker-influenced. Passed as an array it is a value and nothing else.
  const branch = "evil/$(id);rm-rf&`x`";
  await withFakeGh({ stdout: "[]" }, (gh) => {
    findPullRequestForBranch(branch, tmpdir());

    assert.deepEqual(gh.arguments(), [
      "pr",
      "list",
      "--state",
      "open",
      "--json",
      "number",
      "--limit",
      "1",
      "--head",
      branch,
    ]);
  });
});

test("gh is asked from the directory it was given", async () => {
  // Which repository gh answers about is decided by where it runs.
  const directory = await realpath(await mkdtemp(join(tmpdir(), "squiz-where-")));
  try {
    await withFakeGh({ stdout: "[]" }, (gh) => {
      findPullRequestForBranch("feature", directory);

      assert.equal(gh.workingDirectory(), directory);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
