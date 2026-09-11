import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { listReviewThreads, type ReviewThread, type ThreadListing } from "./threads.ts";

const pullRequest = { owner: "jacygao", repo: "squiz", number: 80 } as const;

/** One answer from `gh`, in the order the calls are made. */
type Answer = {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly status?: number;
};

type Fake = {
  /** How many times `gh` ran. */
  readonly calls: () => number;
  /** The JSON body the nth call was given on stdin, counting from one. */
  readonly sentAt: (nth: number) => { readonly query: string; readonly variables: unknown };
};

/**
 * Run `body` with a `gh` on `PATH` that answers `answers` in order, one per
 * call, and records what each call was given.
 *
 * A fake binary rather than an injected runner, as the rest of `src/github/`
 * tests do. A call the fixture has no answer for fails loudly: reading one page
 * too many is the thing being tested, so it must not quietly repeat the last.
 */
async function withFakeGh<T>(
  answers: readonly Answer[],
  body: (gh: Fake) => Promise<T> | T,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "squiz-threads-"));
  const previous = process.env["PATH"];
  try {
    for (const [index, answer] of answers.entries()) {
      const nth = index + 1;
      await writeFile(join(directory, `response.${nth}`), answer.stdout ?? "", "utf8");
      if (answer.stderr !== undefined) {
        await writeFile(join(directory, `stderr.${nth}`), answer.stderr, "utf8");
      }
      if (answer.status !== undefined) {
        await writeFile(join(directory, `status.${nth}`), String(answer.status), "utf8");
      }
    }
    await writeFile(join(directory, "gh"), script(directory), "utf8");
    await chmod(join(directory, "gh"), 0o755);
    process.env["PATH"] = `${directory}:${previous ?? ""}`;
    return await body({
      calls: () => Number.parseInt(read(join(directory, "count")) || "0", 10),
      sentAt: (nth) => JSON.parse(read(join(directory, `stdin.${nth}`))),
    });
  } finally {
    restorePath(previous);
    await rm(directory, { recursive: true, force: true });
  }
}

function script(directory: string): string {
  const at = quote(directory);
  return [
    "#!/bin/sh",
    `count=$(cat ${at}/count 2>/dev/null || echo 0)`,
    "count=$((count + 1))",
    `printf '%s' "$count" > ${at}/count`,
    `cat > ${at}/stdin.$count`,
    `if [ -f ${at}/response.$count ]; then`,
    `  cat ${at}/response.$count`,
    `  if [ -f ${at}/stderr.$count ]; then cat ${at}/stderr.$count >&2; fi`,
    `  if [ -f ${at}/status.$count ]; then exit "$(cat ${at}/status.$count)"; fi`,
    "  exit 0",
    "fi",
    `printf 'gh ran %s times, which the fixture has no answer for\\n' "$count" >&2`,
    "exit 9",
    "",
  ].join("\n");
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

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** `text` as one shell word, so a fixture can hold whatever it needs to. */
function quote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * A response as `gh api --include` writes one.
 *
 * The status line ends in a bare newline and the headers in CRLF, which is what
 * the boundary reads the body out of.
 */
function answered(value: unknown): Answer {
  const body = JSON.stringify(value);
  return {
    stdout: `HTTP/2.0 200 OK\nContent-Type: application/json; charset=utf-8\r\n\r\n${body}`,
  };
}

type Page = { readonly hasNextPage: boolean; readonly endCursor?: string | null };

const lastPage: Page = { hasNextPage: false, endCursor: null };

function threadsPage(nodes: readonly unknown[], pageInfo: Page = lastPage): Answer {
  return answered({
    data: { repository: { pullRequest: { reviewThreads: { pageInfo, nodes } } } },
  });
}

function commentsPage(nodes: readonly unknown[], pageInfo: Page = lastPage): Answer {
  return answered({ data: { node: { comments: { pageInfo, nodes } } } });
}

function comment(login: string, body: string, databaseId: number): unknown {
  return { databaseId, author: { login }, body };
}

/**
 * A thread node as the query asks for one. `fields` overrides any part of it,
 * which is how a fixture carries a null line or a second page of comments.
 */
function threadNode(fields: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    id: "PRRT_kwDOUEd2qM6fnpx6",
    isResolved: false,
    isOutdated: false,
    path: "scratch/target.txt",
    line: 4,
    originalLine: 4,
    comments: {
      pageInfo: lastPage,
      nodes: [comment("jacygao", "the finding", 3942350907)],
    },
    ...fields,
  };
}

/** The threads of a listing, failing the test with the reason where there are none. */
function listed(result: ThreadListing): readonly ReviewThread[] {
  if (result.outcome === "listed") return result.threads;
  assert.fail(`the threads could not be listed: ${result.reason}`);
}

/** The one thread of a listing that is supposed to hold exactly one. */
function onlyThread(result: ThreadListing): ReviewThread {
  const threads = listed(result);
  assert.equal(threads.length, 1);
  const thread = threads[0];
  if (thread === undefined) assert.fail("the listing held no thread");
  return thread;
}

test("a thread comes back with its node id, its state, its anchor and its comments", async () => {
  await withFakeGh(
    [
      threadsPage([
        threadNode({
          comments: {
            pageInfo: lastPage,
            nodes: [
              comment("jacygao", "**Squiz reviewer · high** the finding", 3942350907),
              comment("jacygao", "**Squiz coding agent** fixed", 3942350908),
            ],
          },
        }),
      ]),
    ],
    () => {
      const result = listReviewThreads(pullRequest, { directory: tmpdir() });

      assert.deepEqual(onlyThread(result), {
        id: "PRRT_kwDOUEd2qM6fnpx6",
        isResolved: false,
        isOutdated: false,
        path: "scratch/target.txt",
        line: 4,
        comments: [
          {
            databaseId: 3942350907,
            author: "jacygao",
            body: "**Squiz reviewer · high** the finding",
          },
          { databaseId: 3942350908, author: "jacygao", body: "**Squiz coding agent** fixed" },
        ],
      });
    },
  );
});

test("the identifier carried out is the thread's, never the root comment's", async () => {
  // The two identifier spaces: only the thread's `PRRT_` node id is accepted by
  // reply, resolve and re-open, and a comment's REST id is refused inside an
  // HTTP 200. A reader that carried the comment id out would look correct here
  // and fail at every mutation.
  await withFakeGh([threadsPage([threadNode()])], () => {
    const thread = onlyThread(listReviewThreads(pullRequest, { directory: tmpdir() }));

    assert.equal(thread.id, "PRRT_kwDOUEd2qM6fnpx6");
    assert.equal(thread.comments[0]?.databaseId, 3942350907);
  });
});

test("replies are the comments after the first, in the order GitHub returned them", async () => {
  await withFakeGh(
    [
      threadsPage([
        threadNode({
          comments: {
            pageInfo: lastPage,
            nodes: [
              comment("jacygao", "first", 1),
              comment("jacygao", "second", 2),
              comment("jacygao", "third", 3),
            ],
          },
        }),
      ]),
    ],
    () => {
      const thread = onlyThread(listReviewThreads(pullRequest, { directory: tmpdir() }));

      assert.deepEqual(
        thread.comments.map((entry) => entry.body),
        ["first", "second", "third"],
      );
    },
  );
});

test("the repository and the number go as variables, and the first page has no cursor", async () => {
  await withFakeGh([threadsPage([])], (gh) => {
    listReviewThreads(pullRequest, { directory: tmpdir() });

    assert.deepEqual(gh.sentAt(1).variables, {
      owner: "jacygao",
      repo: "squiz",
      number: 80,
      cursor: null,
    });
  });
});

test("a second page of threads is read, and its threads come back with the first", async () => {
  // The quiet failure this reader exists to avoid: a pull request carrying more
  // than one page of threads reads as quieter than it is, and the round posts
  // again on a line that already has a thread.
  await withFakeGh(
    [
      threadsPage([threadNode({ id: "PRRT_one" })], { hasNextPage: true, endCursor: "cursor-1" }),
      threadsPage([threadNode({ id: "PRRT_two" })]),
    ],
    (gh) => {
      const result = listReviewThreads(pullRequest, { directory: tmpdir() });

      assert.deepEqual(
        listed(result).map((thread) => thread.id),
        ["PRRT_one", "PRRT_two"],
      );
      assert.equal(gh.calls(), 2);
      assert.deepEqual(gh.sentAt(2).variables, {
        owner: "jacygao",
        repo: "squiz",
        number: 80,
        cursor: "cursor-1",
      });
    },
  );
});

test("comments past the first page are followed to the end, by the thread's node id", async () => {
  await withFakeGh(
    [
      threadsPage([
        threadNode({
          comments: {
            pageInfo: { hasNextPage: true, endCursor: "comment-1" },
            nodes: [comment("jacygao", "first", 1)],
          },
        }),
      ]),
      commentsPage([comment("jacygao", "second", 2)], {
        hasNextPage: true,
        endCursor: "comment-2",
      }),
      commentsPage([comment("jacygao", "third", 3)]),
    ],
    (gh) => {
      const thread = onlyThread(listReviewThreads(pullRequest, { directory: tmpdir() }));

      assert.deepEqual(
        thread.comments.map((entry) => entry.body),
        ["first", "second", "third"],
      );
      assert.deepEqual(gh.sentAt(2).variables, {
        thread: "PRRT_kwDOUEd2qM6fnpx6",
        cursor: "comment-1",
      });
      assert.deepEqual(gh.sentAt(3).variables, {
        thread: "PRRT_kwDOUEd2qM6fnpx6",
        cursor: "comment-2",
      });
    },
  );
});

test("an outdated thread reports the line it was anchored to", async () => {
  // `line` goes null the moment the anchored line is edited, and those are the
  // threads a person most wants to look at. Anything printing `file:line` off
  // this would print `file:null` for exactly them.
  await withFakeGh(
    [threadsPage([threadNode({ isOutdated: true, line: null, originalLine: 12 })])],
    () => {
      const thread = onlyThread(listReviewThreads(pullRequest, { directory: tmpdir() }));

      assert.equal(thread.line, 12);
      assert.equal(thread.isOutdated, true);
    },
  );
});

test("a thread anchored to no line at all reports no line", async () => {
  await withFakeGh([threadsPage([threadNode({ line: null, originalLine: null })])], () => {
    const thread = onlyThread(listReviewThreads(pullRequest, { directory: tmpdir() }));

    assert.equal(thread.line, null);
  });
});

test("a resolved thread is listed alongside an open one", async () => {
  await withFakeGh(
    [
      threadsPage([
        threadNode({ id: "PRRT_open" }),
        threadNode({ id: "PRRT_done", isResolved: true }),
      ]),
    ],
    () => {
      const result = listReviewThreads(pullRequest, { directory: tmpdir() });

      assert.deepEqual(
        listed(result).map((thread) => thread.isResolved),
        [false, true],
      );
    },
  );
});

test("a comment whose account is gone reads as having no author", async () => {
  await withFakeGh(
    [
      threadsPage([
        threadNode({
          comments: { pageInfo: lastPage, nodes: [{ databaseId: 7, author: null, body: "gone" }] },
        }),
      ]),
    ],
    () => {
      const thread = onlyThread(listReviewThreads(pullRequest, { directory: tmpdir() }));

      assert.deepEqual(thread.comments, [{ databaseId: 7, author: null, body: "gone" }]);
    },
  );
});

test("a page claiming another page without a cursor to reach it is unreadable", async () => {
  await withFakeGh([threadsPage([threadNode()], { hasNextPage: true, endCursor: null })], () => {
    const result = listReviewThreads(pullRequest, { directory: tmpdir() });

    assert.equal(
      result.outcome,
      "unreadable",
      "a page that cannot be followed is not the last page",
    );
  });
});

test("a cursor that does not advance fails rather than being followed forever", async () => {
  const stuck: Page = { hasNextPage: true, endCursor: "cursor-1" };
  await withFakeGh([threadsPage([threadNode()], stuck), threadsPage([threadNode()], stuck)], () => {
    const result = listReviewThreads(pullRequest, { directory: tmpdir() });

    assert.equal(result.outcome, "unreadable");
  });
});

test("a null pull request is not a pull request carrying no threads", async () => {
  await withFakeGh([answered({ data: { repository: { pullRequest: null } } })], () => {
    const result = listReviewThreads(pullRequest, { directory: tmpdir() });

    assert.equal(result.outcome, "unreadable");
    assert.match(
      result.outcome === "unreadable" ? result.reason : "",
      /no pull request jacygao\/squiz#80/u,
    );
  });
});

test("a thread that cannot be read fails the listing rather than dropping out of it", async () => {
  // Reporting the threads that did parse would be the quiet failure: the round
  // would believe a line is free and post a second thread on it.
  await withFakeGh([threadsPage([threadNode(), { path: "scratch/target.txt", line: 4 }])], () => {
    const result = listReviewThreads(pullRequest, { directory: tmpdir() });

    assert.equal(result.outcome, "unreadable");
  });
});

test("an answer that is not a list of threads is unreadable", async () => {
  const page = answered({ data: { repository: { pullRequest: { reviewThreads: {} } } } });
  await withFakeGh([page], () => {
    const result = listReviewThreads(pullRequest, { directory: tmpdir() });

    assert.equal(result.outcome, "unreadable");
  });
});

test("a GraphQL error inside an HTTP 200 is a failure", async () => {
  // The quiet one: the status line says 200 and the failure is in the errors
  // array, so a reader checking the status reports a pull request with no
  // threads on it.
  await withFakeGh(
    [
      answered({
        data: { repository: null },
        errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }],
      }),
    ],
    () => {
      const result = listReviewThreads(pullRequest, { directory: tmpdir() });

      assert.equal(result.outcome, "graphql-errors");
    },
  );
});

test("a gh that exits non-zero is a failure", async () => {
  await withFakeGh(
    [{ stdout: "", stderr: "HTTP 401: Bad credentials\n", status: 1 }],
    () => {
      const result = listReviewThreads(pullRequest, { directory: tmpdir() });

      assert.equal(result.outcome, "exited");
    },
  );
});

test("a gh that is not installed is a failure", async () => {
  await withNoGh(() => {
    const result = listReviewThreads(pullRequest, { directory: tmpdir() });

    assert.equal(result.outcome, "not-run");
  });
});

test("a failure on a later page is a failure for the whole listing", async () => {
  await withFakeGh(
    [
      threadsPage([threadNode()], { hasNextPage: true, endCursor: "cursor-1" }),
      { stdout: "", stderr: "HTTP 502: Bad gateway\n", status: 1 },
    ],
    () => {
      const result = listReviewThreads(pullRequest, { directory: tmpdir() });

      assert.equal(result.outcome, "exited", "a half-read pull request is never a listing");
    },
  );
});
