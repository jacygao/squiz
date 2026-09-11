import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseDiff } from "../findings/diff.ts";
import { fetchDiff, findPullRequestForBranch } from "./pull-request.ts";

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
 *
 * What the fake prints comes from a file it reads, because a diff fixture runs
 * to megabytes and no shell holds that as an argument.
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

/** A row of `gh pr list --json`, with every field the lookup asks for. */
const row = {
  number: 142,
  id: "PR_kwDOUEd2qM8AAAABDNPXSA",
  baseRefName: "main",
  headRefName: "feature",
  headRefOid: "3a1937e729dbab0f618ef761c833a7e2d3675b80",
  body: "## Intent\n\nWhat this is for.",
};

/** The row as `gh` prints it: a list holding it, one line. */
function listing(fields: Readonly<Record<string, unknown>>): string {
  return `${JSON.stringify([fields])}\n`;
}

/**
 * The bytes GitHub serves as the diff of a pull request adding three files.
 *
 * Two of the names are quoted, and both shapes are here because they are the
 * ones a hand-written fixture gets wrong: a name holding a space carries a
 * trailing tab, and a name with a byte above ASCII is quoted whole, one octal
 * escape per byte. Written line by line so that the trailing tab survives an
 * editor.
 */
const diffFromGitHub = `${[
  "diff --git a/scratch/a file with spaces.txt b/scratch/a file with spaces.txt",
  "new file mode 100644",
  "index 0000000..80efb77",
  "--- /dev/null",
  "+++ b/scratch/a file with spaces.txt\t",
  "@@ -0,0 +1 @@",
  "+a path whose name carries spaces",
  "diff --git a/scratch/target.txt b/scratch/target.txt",
  "new file mode 100644",
  "index 0000000..7650e76",
  "--- /dev/null",
  "+++ b/scratch/target.txt",
  "@@ -0,0 +1,3 @@",
  "+line 1",
  "+line 2",
  "+line 3",
  String.raw`diff --git "a/scratch/\303\274n\303\257c\303\266d\303\251.txt" "b/scratch/\303\274n\303\257c\303\266d\303\251.txt"`,
  "new file mode 100644",
  "index 0000000..7ea1967",
  "--- /dev/null",
  String.raw`+++ "b/scratch/\303\274n\303\257c\303\266d\303\251.txt"`,
  "@@ -0,0 +1 @@",
  "+a path outside ASCII",
].join("\n")}\n`;

/** A diff of `count` added lines, for the sizes a real change reaches. */
function diffOfSize(count: number): string {
  const body = Array.from({ length: count }, (_, at) => `+line ${at + 1}`).join("\n");
  return `diff --git a/big.txt b/big.txt\n--- /dev/null\n+++ b/big.txt\n@@ -0,0 +1,${count} @@\n${body}\n`;
}

test("a branch with an open pull request comes back with everything the round needs", async () => {
  await withFakeGh({ stdout: listing(row) }, () => {
    const result = findPullRequestForBranch("feature", tmpdir());

    assert.deepEqual(result, {
      outcome: "found",
      number: 142,
      nodeId: "PR_kwDOUEd2qM8AAAABDNPXSA",
      baseRef: "main",
      headRef: "feature",
      headSha: "3a1937e729dbab0f618ef761c833a7e2d3675b80",
      description: "## Intent\n\nWhat this is for.",
    });
  });
});

test("the sha that comes back is the head's, never the base's", async () => {
  // Posting an anchored comment takes the head sha, and the base sha in its
  // place is refused as a path error that never names the commit. A round that
  // carried the wrong one would be told its anchors were wrong.
  const both = { ...row, baseRefOid: "dd5609879f5cdef406c312f7398d387a85459139" };
  await withFakeGh({ stdout: listing(both) }, () => {
    const result = findPullRequestForBranch("feature", tmpdir());

    assert.equal(
      result.outcome === "found" ? result.headSha : null,
      "3a1937e729dbab0f618ef761c833a7e2d3675b80",
      "the head sha is the one an anchored comment is posted against",
    );
  });
});

test("a pull request with no description is found, with an empty one", async () => {
  await withFakeGh({ stdout: listing({ ...row, body: "" }) }, () => {
    const result = findPullRequestForBranch("feature", tmpdir());

    assert.equal(result.outcome, "found");
    assert.equal(result.outcome === "found" ? result.description : null, "");
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

test("a row missing any field the round needs is a failure", async () => {
  for (const field of ["id", "baseRefName", "headRefName", "headRefOid", "body"]) {
    const missing: Record<string, unknown> = { ...row };
    delete missing[field];

    await withFakeGh({ stdout: listing(missing) }, () => {
      const result = findPullRequestForBranch("feature", tmpdir());

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
    findPullRequestForBranch(branch, tmpdir());

    assert.deepEqual(gh.arguments(), [
      "pr",
      "list",
      "--state",
      "open",
      "--json",
      "number,id,baseRefName,headRefName,headRefOid,body",
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

test("the diff comes back byte for byte as it arrived", async () => {
  await withFakeGh({ stdout: diffFromGitHub }, () => {
    const result = fetchDiff(142, tmpdir());

    assert.deepEqual(result, { outcome: "fetched", diff: diffFromGitHub });
  });
});

test("the diff GitHub serves names the files a finding names", async () => {
  // The quiet failure this rules out: a quoting the parser reads differently
  // keys every file under a name no finding matches, and each one routes to the
  // summary with nothing reporting why.
  await withFakeGh({ stdout: diffFromGitHub }, () => {
    const result = fetchDiff(142, tmpdir());
    const changed = parseDiff(result.outcome === "fetched" ? result.diff : "");

    assert.deepEqual(
      [...changed.keys()].sort(),
      ["scratch/a file with spaces.txt", "scratch/target.txt", "scratch/ünïcödé.txt"],
      "a path a finding names is repository-relative, unquoted and decoded",
    );
  });
});

test("a diff larger than a mebibyte arrives whole", async () => {
  // Nothing local bounds the answer, so a diff is only ever as short as GitHub
  // served it. One arriving cut off at a file boundary would read as a whole
  // diff with the last files simply absent.
  const diff = diffOfSize(150_000);
  assert.ok(diff.length > 1024 * 1024, "the fixture has to be past the ceiling it is testing");

  await withFakeGh({ stdout: diff }, () => {
    const result = fetchDiff(142, tmpdir());

    assert.equal(result.outcome, "fetched");
    assert.equal(
      result.outcome === "fetched" ? result.diff.length : 0,
      diff.length,
      "a diff that arrived short would still parse, and would be missing files",
    );
  });
});

test("a diff GitHub refused is a failure carrying what gh said", async () => {
  await withFakeGh({ status: 1, stderr: "gh: Not Found (HTTP 404)\n" }, () => {
    const result = fetchDiff(142, tmpdir());

    assert.deepEqual(result, {
      outcome: "failed",
      reason: "gh exited 1: gh: Not Found (HTTP 404)",
    });
  });
});

test("a gh that printed no diff at all is a failure", async () => {
  await withFakeGh({ stdout: "" }, () => {
    const result = fetchDiff(142, tmpdir());

    assert.deepEqual(result, { outcome: "failed", reason: "gh answered with an empty diff" });
  });
});

test("a gh that is not installed fails the diff rather than throwing", async () => {
  await withNoGh(() => {
    const result = fetchDiff(142, tmpdir());

    assert.equal(result.outcome, "failed");
  });
});

test("the diff is asked for as a diff, for the number given, where gh was pointed", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "squiz-diff-")));
  try {
    await withFakeGh({ stdout: diffFromGitHub }, (gh) => {
      fetchDiff(80, directory);

      assert.deepEqual(gh.arguments(), [
        "api",
        "repos/{owner}/{repo}/pulls/80",
        "--header",
        "Accept: application/vnd.github.v3.diff",
      ]);
      assert.equal(gh.workingDirectory(), directory);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
