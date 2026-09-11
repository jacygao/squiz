import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { postSummary } from "./summary.ts";

type FakeGh = {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly status?: number;
};

type Fake = {
  /** Every argument `gh` was given, one per entry, exactly as it arrived. */
  readonly arguments: () => readonly string[];
  /** Everything written to `gh`'s stdin, as one string. */
  readonly stdin: () => string;
};

/**
 * Run `body` with a `gh` on `PATH` that answers as `fake` says and records how
 * it was called.
 *
 * A fake binary rather than an injected runner: what a comment body survives on
 * its way to the subprocess is the thing being tested, and an injected runner
 * would stand exactly where the evidence is.
 */
async function withFakeGh<T>(fake: FakeGh, body: (gh: Fake) => Promise<T> | T): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "squiz-summary-"));
  const argumentLog = join(directory, "arguments");
  const stdinLog = join(directory, "stdin");
  const script = [
    "#!/bin/sh",
    'for argument in "$@"; do',
    `  printf '%s\\n' "$argument" >> ${quote(argumentLog)}`,
    "done",
    `cat > ${quote(stdinLog)}`,
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
      stdin: () => (existsSync(stdinLog) ? readFileSync(stdinLog, "utf8") : ""),
    });
  } finally {
    restorePath(previous);
    await rm(directory, { recursive: true, force: true });
  }
}

/** Run `body` with a `PATH` that holds nothing, so no `gh` can be found. */
async function withNoGh<T>(body: () => Promise<T> | T): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "squiz-summary-empty-"));
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
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

/** `text` as one shell word, so a fixture can hold whatever it needs to. */
function quote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * A response as `gh api --include` writes one: the status line ends in a bare
 * newline and the headers in CRLF, so the blank line before the body is
 * `\r\n\r\n`.
 */
function included(status: string, body: string): string {
  return `HTTP/2.0 ${status}\nContent-Type: application/json; charset=utf-8\r\n\r\n${body}`;
}

const anywhere = { directory: tmpdir() };

/** An issue comment as GitHub returns one: no `path`, no `line`, an `IC_` node id. */
const created = included(
  "201 Created",
  '{"id":2140876531,"node_id":"IC_kwDOUEd2qM7q-4A7","body":"**Squiz review — 3 rounds, 6 findings**"}',
);

/** What the stdin `gh` was handed parses to, or a failure naming what arrived. */
function sent(stdin: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdin);
  } catch {
    return assert.fail(`gh was handed what is not JSON: ${stdin}`);
  }
  assert.ok(typeof parsed === "object" && parsed !== null, "gh was handed what is not an object");
  return parsed as Record<string, unknown>;
}

test("the summary is posted to the issues endpoint for the pull request's number", async () => {
  await withFakeGh({ stdout: created }, (gh) => {
    const result = postSummary(142, "**Squiz review — 3 rounds, 6 findings**", anywhere);

    assert.deepEqual(result, { outcome: "posted" });
    assert.deepEqual(
      gh.arguments(),
      [
        "api",
        "--include",
        "--method",
        "POST",
        "repos/{owner}/{repo}/issues/142/comments",
        "--input",
        "-",
      ],
      "the pulls path posts a review comment, which is a different object on a line of the diff",
    );
  });
});

test("the request carries a body and nothing else", async () => {
  // A `path` or a `line` alongside the body is what makes a request a review
  // comment, and that request would answer 201 too.
  await withFakeGh({ stdout: created }, (gh) => {
    postSummary(142, "the summary", anywhere);

    assert.deepEqual(sent(gh.stdin()), { body: "the summary" });
  });
});

test("a body reaches gh verbatim, whatever a summary puts in it", async () => {
  // Everything here has a second meaning somewhere on the way to GitHub:
  // backticks and `$( )` to a shell, a leading `@` to gh's own -F, which reads
  // it as a filename, and a bare numeral, which -F converts to a number.
  const body = [
    "@octocat `git rm -rf /` $(id)",
    "",
    "**Squiz review — 3 rounds, 6 findings**",
    "Cost $0.0134 · 48,200 tokens",
    "- `packages/sync/src/queue.ts:134` — Retry backoff resets on every enqueue (open)",
    "0755",
    "",
  ].join("\n");

  await withFakeGh({ stdout: created }, (gh) => {
    postSummary(142, body, anywhere);

    assert.equal(sent(gh.stdin())["body"], body, "the summary is never edited, so this is permanent");
  });
});

test("a gh that exits non-zero is a failure", async () => {
  await withFakeGh(
    {
      status: 1,
      stdout: included("404 Not Found", '{"message":"Not Found"}'),
      stderr: "gh: Not Found (HTTP 404)\n",
    },
    () => {
      const result = postSummary(142, "the summary", anywhere);

      assert.deepEqual(result, {
        outcome: "failed",
        reason: "gh exited 1 on HTTP 404: gh: Not Found (HTTP 404)",
      });
    },
  );
});

test("an error status gh did not fail on is a failure", async () => {
  // Nothing posts the summary a second time, so a comment that did not land
  // must never read as one that did.
  await withFakeGh({ stdout: included("404 Not Found", '{"message":"Not Found"}') }, () => {
    const result = postSummary(142, "the summary", anywhere);

    assert.deepEqual(result, {
      outcome: "failed",
      reason: "gh answered HTTP 404 without posting the summary",
    });
  });
});

test("a gh that is not installed is a failure", async () => {
  await withNoGh(() => {
    const result = postSummary(142, "the summary", anywhere);

    assert.equal(result.outcome, "failed");
    assert.match(
      result.outcome === "failed" ? result.reason : "",
      /gh could not be run/u,
      "a gh that is not there must not read as a summary that posted",
    );
  });
});

test("an answer that is not JSON is a failure", async () => {
  await withFakeGh({ stdout: "gh: something went sideways\n" }, () => {
    const result = postSummary(142, "the summary", anywhere);

    assert.equal(result.outcome, "failed");
  });
});
