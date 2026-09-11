import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { reopenThread, replyInThread, resolveThread } from "./thread-actions.ts";

type FakeGh = {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly status?: number;
};

type Fake = {
  /** Every argument `gh` was given, one per entry, exactly as it arrived. */
  readonly arguments: () => readonly string[];
  /** What each invocation was sent on stdin, one entry per invocation. */
  readonly calls: () => readonly string[];
};

/**
 * Run `body` with a `gh` on `PATH` that answers as `fake` says and records how
 * it was called.
 *
 * A fake binary rather than an injected runner: a mutation reaches GitHub as a
 * JSON body on stdin, and that body is what these tests are about.
 */
async function withFakeGh<T>(fake: FakeGh, body: (gh: Fake) => Promise<T> | T): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "squiz-thread-actions-"));
  const argumentLog = join(directory, "arguments");
  const stdinLog = join(directory, "stdin");
  const script = [
    "#!/bin/sh",
    'for argument in "$@"; do',
    `  printf '%s\\n' "$argument" >> ${quote(argumentLog)}`,
    "done",
    // One line per invocation: the request is JSON, which carries no newline.
    `cat >> ${quote(stdinLog)}`,
    `printf '\\n' >> ${quote(stdinLog)}`,
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
    return await body({ arguments: () => lines(argumentLog), calls: () => lines(stdinLog) });
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
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

/** `text` as one shell word, so a fixture can hold whatever it needs to. */
function quote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * A response as `gh api --include` writes one.
 *
 * The status line ends in a bare newline and the headers in CRLF, so the blank
 * line before the body is `\r\n\r\n`.
 */
function included(status: string, body: string): string {
  return `HTTP/2.0 ${status}\nContent-Type: application/json; charset=utf-8\r\n\r\n${body}`;
}

/** What a resolution mutation answers: the state it left the thread in. */
function reported(field: string, isResolved: boolean): string {
  return included("200 OK", JSON.stringify({ data: { [field]: { thread: { isResolved } } } }));
}

/** The whole answer to a wrong id: a GraphQL `NOT_FOUND` inside an HTTP 200. */
function notFound(id: string): string {
  return included(
    "200 OK",
    JSON.stringify({
      data: null,
      errors: [
        {
          type: "NOT_FOUND",
          path: ["resolveReviewThread"],
          message: `Could not resolve to PullRequestReviewThread node with the global id of '${id}'.`,
        },
      ],
    }),
  );
}

/** What the reply mutation answers: the comment it published. */
const replyAnswer = included(
  "200 OK",
  '{"data":{"addPullRequestReviewThreadReply":{"comment":{"databaseId":1}}}}',
);

const anywhere = { directory: tmpdir() };
const thread = "PRRT_kwDOUEd2qM6hqJCZ";

/** The request `gh` was sent on its `nth` invocation, read back as JSON. */
function requestOf(gh: Fake, nth: number): { query: string; variables: Record<string, unknown> } {
  const sent = gh.calls()[nth];
  assert.ok(sent !== undefined, `gh was invoked fewer than ${nth + 1} times`);
  return JSON.parse(sent) as { query: string; variables: Record<string, unknown> };
}

test("a reply names the thread by its node id and carries the body as a variable", async () => {
  const body = "**Squiz coding agent: done, and here is why.";
  await withFakeGh({ stdout: replyAnswer }, (gh) => {
    const result = replyInThread(thread, body, anywhere);

    assert.deepEqual(result, { outcome: "acted" });
    assert.deepEqual(gh.arguments(), ["api", "graphql", "--include", "--input", "-"]);
    const request = requestOf(gh, 0);
    assert.match(request.query, /addPullRequestReviewThreadReply/u);
    assert.deepEqual(request.variables, { threadId: thread, body });
  });
});

test("a reply body reaches GitHub as a value, whatever a model wrote into it", async () => {
  // A finding's body is written by a model and can hold anything. It travels in
  // the JSON request, so no argument and no shell ever sees it.
  const body = "`rm -rf /` $(id) --method DELETE\n@file 'quoted'";
  await withFakeGh({ stdout: replyAnswer }, (gh) => {
    replyInThread(thread, body, anywhere);

    assert.equal(requestOf(gh, 0).variables["body"], body);
    assert.equal(gh.arguments().includes(body), false, "the body must not reach gh as an argument");
  });
});

test("resolving sends the mutation and nothing else", async () => {
  // Resolve is idempotent, so a verdict is applied without reading the thread
  // first. A read here would also be a read of `viewerCanResolve`, which reads
  // false on a thread that is already resolved.
  await withFakeGh({ stdout: reported("resolveReviewThread", true) }, (gh) => {
    const result = resolveThread(thread, anywhere);

    assert.deepEqual(result, { outcome: "acted" });
    assert.equal(gh.calls().length, 1, "resolving must not read the thread first");
    const request = requestOf(gh, 0);
    assert.match(request.query, /resolveReviewThread/u);
    assert.doesNotMatch(request.query, /viewerCanResolve/u);
    assert.deepEqual(request.variables, { threadId: thread });
  });
});

test("re-opening sends the unresolve mutation and nothing else", async () => {
  await withFakeGh({ stdout: reported("unresolveReviewThread", false) }, (gh) => {
    const result = reopenThread(thread, anywhere);

    assert.deepEqual(result, { outcome: "acted" });
    assert.equal(gh.calls().length, 1, "re-opening must not read the thread first");
    const request = requestOf(gh, 0);
    assert.match(request.query, /unresolveReviewThread/u);
    assert.doesNotMatch(request.query, /viewerCanUnresolve/u);
    assert.deepEqual(request.variables, { threadId: thread });
  });
});

test("a wrong id is a failure, though GitHub answered HTTP 200", async () => {
  // The failure this file exists to catch. The status line says 200 and the
  // fixture exits 0, so only the `errors` array tells a resolve that did
  // nothing from one that closed the thread.
  await withFakeGh({ stdout: notFound("PRRC_kwDOUEd2qM7uDllc"), status: 0 }, () => {
    const result = resolveThread("PRRC_kwDOUEd2qM7uDllc", anywhere);

    assert.equal(result.outcome, "failed");
    assert.match(
      result.outcome === "failed" ? result.reason : "",
      /Could not resolve to PullRequestReviewThread node/u,
      "a comment node id must not read as a resolved thread",
    );
  });
});

test("a wrong id fails a reply too", async () => {
  await withFakeGh({ stdout: notFound("3993917788"), status: 1 }, () => {
    const result = replyInThread("3993917788", "nothing must land", anywhere);

    assert.equal(result.outcome, "failed");
  });
});

test("a resolve that GitHub did not report resolved is a failure", async () => {
  // A mutation that answered without doing the work. Reported as a success it
  // would have the round report a thread closed that is still open.
  await withFakeGh({ stdout: reported("resolveReviewThread", false) }, () => {
    const result = resolveThread(thread, anywhere);

    assert.equal(result.outcome, "failed");
    const reason = result.outcome === "failed" ? result.reason : "";
    assert.match(reason, /did not report the thread resolved/u);
  });
});

test("a re-open that GitHub still reports resolved is a failure", async () => {
  await withFakeGh({ stdout: reported("unresolveReviewThread", true) }, () => {
    const result = reopenThread(thread, anywhere);

    assert.equal(result.outcome, "failed");
    const reason = result.outcome === "failed" ? result.reason : "";
    assert.match(reason, /did not report the thread open/u);
  });
});

test("an answer carrying no thread at all is a failure", async () => {
  await withFakeGh({ stdout: included("200 OK", '{"data":{"resolveReviewThread":null}}') }, () => {
    const result = resolveThread(thread, anywhere);

    assert.equal(result.outcome, "failed");
  });
});

test("a gh that is not installed is a failure", async () => {
  await withNoGh(() => {
    assert.equal(resolveThread(thread, anywhere).outcome, "failed");
    assert.equal(replyInThread(thread, "a reply", anywhere).outcome, "failed");
    assert.equal(reopenThread(thread, anywhere).outcome, "failed");
  });
});

test("a gh that exited on an HTTP error is a failure carrying what it said", async () => {
  await withFakeGh(
    {
      status: 1,
      stdout: included("401 Unauthorized", '{"message":"Bad credentials"}'),
      stderr: "gh: Bad credentials (HTTP 401)\n",
    },
    () => {
      const result = resolveThread(thread, anywhere);

      assert.deepEqual(result, {
        outcome: "failed",
        reason: "gh exited 1 on HTTP 401: gh: Bad credentials (HTTP 401)",
      });
    },
  );
});
