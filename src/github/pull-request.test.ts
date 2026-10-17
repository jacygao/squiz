import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { deadlineIn } from "../reviewers/deadline.ts";
import { standIn } from "../testing/stand-in.ts";
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
  const outFile = join(directory, "stdout");
  const errFile = join(directory, "stderr");
  const script = [
    "#!/bin/sh",
    'for argument in "$@"; do',
    `  printf '%s\\n' "$argument" >> ${quote(argumentLog)}`,
    "done",
    `pwd -P > ${quote(cwdLog)}`,
    `cat ${quote(outFile)}`,
    `cat ${quote(errFile)} >&2`,
    `exit ${fake.status ?? 0}`,
    "",
  ].join("\n");

  const previous = process.env["PATH"];
  try {
    await writeFile(outFile, fake.stdout ?? "", "utf8");
    await writeFile(errFile, fake.stderr ?? "", "utf8");
    standIn(directory, "gh", script);
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

/** A row of `gh pr list --json`, with every field the lookup asks for. */
const row = {
  number: 142,
  id: "PR_kwDOUEd2qM8AAAABDNPXSA",
  baseRefName: "main",
  headRefName: "feature",
  headRefOid: "3a1937e729dbab0f618ef761c833a7e2d3675b80",
  baseRefOid: "dd5609879f5cdef406c312f7398d387a85459139",
  body: "## Intent\n\nWhat this is for.",
  isDraft: false,
};

/** The row as `gh` prints it: a list holding it, one line. */
function listing(fields: Readonly<Record<string, unknown>>): string {
  return `${JSON.stringify([fields])}\n`;
}

test("a branch with an open pull request comes back with everything the round needs", async () => {
  await withFakeGh({ stdout: listing(row) }, () => {
    const result = findPullRequestForBranch("feature", { directory: tmpdir() });

    assert.deepEqual(result, {
      outcome: "found",
      number: 142,
      nodeId: "PR_kwDOUEd2qM8AAAABDNPXSA",
      baseRef: "main",
      headRef: "feature",
      headSha: "3a1937e729dbab0f618ef761c833a7e2d3675b80",
      baseSha: "dd5609879f5cdef406c312f7398d387a85459139",
      description: "## Intent\n\nWhat this is for.",
      draft: false,
    });
  });
});

test("a draft pull request is found, and says it is a draft (#720)", async () => {
  await withFakeGh({ stdout: listing({ ...row, isDraft: true }) }, () => {
    const result = findPullRequestForBranch("feature", { directory: tmpdir() });

    assert.equal(result.outcome, "found", JSON.stringify(result));
    assert.equal(result.outcome === "found" ? result.draft : null, true);
  });
});

test("the sha that comes back is the head's, never the base's", async () => {
  // Posting an anchored comment takes the head sha, and the base sha in its
  // place is refused as a path error that never names the commit. A round that
  // carried the wrong one would be told its anchors were wrong.
  await withFakeGh({ stdout: listing(row) }, () => {
    const result = findPullRequestForBranch("feature", { directory: tmpdir() });

    assert.equal(
      result.outcome === "found" ? result.headSha : null,
      "3a1937e729dbab0f618ef761c833a7e2d3675b80",
      "the head sha is the one an anchored comment is posted against",
    );
  });
});

test("a pull request with no description is found, with an empty one", async () => {
  await withFakeGh({ stdout: listing({ ...row, body: "" }) }, () => {
    const result = findPullRequestForBranch("feature", { directory: tmpdir() });

    assert.equal(result.outcome, "found");
    assert.equal(result.outcome === "found" ? result.description : null, "");
  });
});

test("an empty list is an answer of none", async () => {
  await withFakeGh({ stdout: "[]\n" }, () => {
    const result = findPullRequestForBranch("feature", { directory: tmpdir() });

    assert.deepEqual(result, { outcome: "none" });
  });
});

/**
 * The gate is what this protects. A round reads an answer of none as a branch
 * nobody opened a pull request for, exits 0 and posts nothing, so a lookup the
 * round's own deadline stopped must never arrive as one: every round would
 * decide in silence that there was nothing to review.
 */
test("a lookup with nothing left on the deadline is a failure, never an answer of none", async () => {
  await withFakeGh({ stdout: listing(row) }, (gh) => {
    const result = findPullRequestForBranch("feature", {
      directory: tmpdir(),
      until: deadlineIn(0),
    });

    assert.equal(result.outcome, "failed");
    assert.equal(gh.workingDirectory(), null, "a call with no time to answer in is not made");
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
      const result = findPullRequestForBranch("feature", { directory: tmpdir() });

      assert.deepEqual(result, {
        outcome: "failed",
        reason: "gh exited 1: HTTP 401: Bad credentials (https://api.github.com/graphql)",
      });
    },
  );
});

test("a gh that is not installed is a failure", async () => {
  await withNoGh(() => {
    const result = findPullRequestForBranch("feature", { directory: tmpdir() });

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
    const result = findPullRequestForBranch("feature", { directory: tmpdir() });

    assert.equal(result.outcome, "failed");
  });
});

test("an answer that is not JSON is a failure", async () => {
  await withFakeGh({ stdout: "gh: something went sideways\n" }, () => {
    const result = findPullRequestForBranch("feature", { directory: tmpdir() });

    assert.deepEqual(result, {
      outcome: "failed",
      reason: "gh answered with what is not JSON: gh: something went sideways",
    });
  });
});

test("a row carrying no usable number is a failure", async () => {
  await withFakeGh({ stdout: '[{"number":"142"}]' }, () => {
    const result = findPullRequestForBranch("feature", { directory: tmpdir() });

    assert.equal(result.outcome, "failed");
  });
});

test("a row missing any field the round needs is a failure", async () => {
  for (const field of ["id", "baseRefName", "headRefName", "headRefOid", "baseRefOid", "body", "isDraft"]) {
    const missing: Record<string, unknown> = { ...row };
    delete missing[field];

    await withFakeGh({ stdout: listing(missing) }, () => {
      const result = findPullRequestForBranch("feature", { directory: tmpdir() });

      assert.equal(
        result.outcome,
        "failed",
        `a row with no ${field} answers less than the round needs, so it is not "found"`,
      );
    });
  }
});

test("the branch reaches gh as one argument, whatever git let into it", async () => {
  // git accepts `$( )`, backticks and `;` in a branch name, and a branch name
  // is attacker-influenced. Passed as an array it is a value and nothing else.
  const branch = "evil/$(id);rm-rf&`x`";
  await withFakeGh({ stdout: "[]" }, (gh) => {
    findPullRequestForBranch(branch, { directory: tmpdir() });

    assert.deepEqual(gh.arguments(), [
      "pr",
      "list",
      "--state",
      "open",
      "--json",
      "number,id,baseRefName,headRefName,headRefOid,baseRefOid,body,isDraft",
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
      findPullRequestForBranch("feature", { directory: directory });

      assert.equal(gh.workingDirectory(), directory);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

