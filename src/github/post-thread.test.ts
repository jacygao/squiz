import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  postFileThread,
  postThread,
  type FileThreadRequest,
  type ThreadRequest,
} from "./post-thread.ts";

/** One `gh` invocation's answer, in the order the fake serves them. */
type Reply = {
  /** All `gh api --include` writes: the status line, the headers, a blank line, the body. */
  readonly stdout?: string;
  readonly stderr?: string;
  readonly status?: number;
};

type Fake = {
  readonly calls: () => number;
  /** The arguments the `n`th `gh` was given, counting from one. */
  readonly argumentsOf: (n: number) => readonly string[];
  /** What was written to the `n`th `gh`'s stdin, counting from one. */
  readonly stdinOf: (n: number) => string;
};

/**
 * Run `body` with a `gh` on `PATH` that answers `replies` in order and records
 * how each call was made.
 *
 * A fake binary rather than an injected runner: what reaches the subprocess is
 * the thing under test, and an injected runner would stand where the evidence
 * is. A reply per call, because posting a thread is a create followed by a
 * read-back and the two must be told apart.
 */
async function withFakeGh<T>(
  replies: readonly Reply[],
  body: (gh: Fake) => Promise<T> | T,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "squiz-post-thread-"));
  const script = [
    "#!/bin/sh",
    `dir=${quote(directory)}`,
    'n=$(cat "$dir/count" 2>/dev/null || echo 0)',
    "n=$((n + 1))",
    'printf %s "$n" > "$dir/count"',
    'for argument in "$@"; do printf \'%s\\n\' "$argument" >> "$dir/arguments-$n"; done',
    // Read stdin only when gh was told to, or a call that sends no body hangs.
    'case " $* " in *" --input "*) cat > "$dir/stdin-$n" ;; *) : > "$dir/stdin-$n" ;; esac',
    'if [ -f "$dir/stdout-$n" ]; then cat "$dir/stdout-$n"; fi',
    'if [ -f "$dir/stderr-$n" ]; then cat "$dir/stderr-$n" >&2; fi',
    'exit "$(cat "$dir/status-$n" 2>/dev/null || echo 0)"',
    "",
  ].join("\n");

  const previous = process.env["PATH"];
  try {
    await writeFile(join(directory, "gh"), script, "utf8");
    await chmod(join(directory, "gh"), 0o755);
    for (const [index, reply] of replies.entries()) {
      const n = index + 1;
      await writeFile(join(directory, `stdout-${n}`), reply.stdout ?? "", "utf8");
      await writeFile(join(directory, `stderr-${n}`), reply.stderr ?? "", "utf8");
      await writeFile(join(directory, `status-${n}`), String(reply.status ?? 0), "utf8");
    }
    process.env["PATH"] = `${directory}:${previous ?? ""}`;
    return await body({
      calls: () => Number(read(join(directory, "count")) || "0"),
      argumentsOf: (n) =>
        read(join(directory, `arguments-${n}`))
          .split("\n")
          .filter((line) => line !== ""),
      stdinOf: (n) => read(join(directory, `stdin-${n}`)),
    });
  } finally {
    restorePath(previous);
    await rm(directory, { recursive: true, force: true });
  }
}

/** Run `body` with a `PATH` that holds nothing, so no `gh` can be found. */
async function withNoGh<T>(body: () => Promise<T> | T): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "squiz-post-thread-empty-"));
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
 * What `gh api --include` prints. The status line ends in a bare newline and
 * the headers in CRLF, which is what the real one does and what the reader
 * beneath this has to cope with.
 */
function response(httpStatus: number, body: unknown): string {
  return `HTTP/2.0 ${httpStatus} X\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`;
}

/** A `gh` that exited on an HTTP error, which is how a 422 and a 404 arrive. */
function errored(httpStatus: number, body: unknown, said: string): Reply {
  return {
    status: 1,
    stdout: response(httpStatus, body),
    stderr: `gh: ${said} (HTTP ${httpStatus})\n`,
  };
}

const HEAD_SHA = "3a1937e729dbab0f618ef761c833a7e2d3675b80";

const request: ThreadRequest = {
  pullRequest: 80,
  headSha: HEAD_SHA,
  anchor: { path: "scratch/target.txt", line: 7, side: "RIGHT" },
  body: "**Squiz reviewer · low — the line is wrong**",
};

const fileRequest: FileThreadRequest = {
  pullRequest: 80,
  headSha: HEAD_SHA,
  path: "scratch/target.txt",
  body: "**Squiz reviewer · low — the file has no tests**",
};

/**
 * The REST create response, as GitHub sent it. It carries no `in_reply_to_id`:
 * a comment that opened a thread has no such field, and a fixture that adds one
 * would be the only place the field is ever null.
 */
const CREATED = {
  id: 3993908108,
  node_id: "PRRC_kwDOUEd2qM7uDjOM",
  path: "scratch/target.txt",
  line: 7,
  side: "RIGHT",
  subject_type: "line",
  commit_id: HEAD_SHA,
  html_url: "https://github.com/jacygao/squiz/pull/80#discussion_r3993908108",
};

/**
 * The response to a file-scoped create, as GitHub sent it.
 *
 * It carries `line: 1` and `side: "RIGHT"` though neither was asked for, and
 * `subject_type` is the only field that tells it from a comment on the first
 * line of the file.
 */
const CREATED_ON_FILE = {
  id: 3994572932,
  node_id: "PRRC_kwDOUEd2qM7uGFiE",
  path: "scratch/target.txt",
  line: 1,
  original_line: 1,
  side: "RIGHT",
  start_line: null,
  diff_hunk: "",
  subject_type: "file",
  commit_id: HEAD_SHA,
  html_url: "https://github.com/jacygao/squiz/pull/80#discussion_r3994572932",
};

/** One page of `reviewThreads`, each entry a thread id under its opening comment's database id. */
function threadPage(
  threads: readonly (readonly [number, string])[],
  nextCursor: string | null,
): unknown {
  return {
    data: {
      node: {
        pullRequest: {
          reviewThreads: {
            pageInfo: {
              hasNextPage: nextCursor !== null,
              endCursor: nextCursor ?? "Y3Vyc29yOnYy",
            },
            nodes: threads.map(([databaseId, id]) => ({
              id,
              comments: { nodes: [{ databaseId }] },
            })),
          },
        },
      },
    },
  };
}

/** A 422 refusing one named field, in the shape GitHub returns. */
function validationFailed(field: string, message: string): unknown {
  return {
    message: "Validation Failed",
    errors: [{ resource: "PullRequestReviewComment", code: "custom", field, message }],
    documentation_url: "https://docs.github.com/rest/pulls/comments",
    status: "422",
  };
}

const CREATED_OK: Reply = { stdout: response(201, CREATED) };
const THREAD_FOUND: Reply = {
  stdout: response(200, threadPage([[3993908108, "PRRT_kwDOUEd2qM6hqHeq"]], null)),
};

test("the thread is created over REST, carrying the anchor and the head sha", async () => {
  await withFakeGh([CREATED_OK, THREAD_FOUND], (gh) => {
    postThread(request, { directory: tmpdir() });

    assert.deepEqual(gh.argumentsOf(1), [
      "api",
      "--include",
      "--method",
      "POST",
      "repos/{owner}/{repo}/pulls/80/comments",
      "--input",
      "-",
    ]);
    // The exact key set, not a superset: an extra reply key turns a new thread
    // into a comment inside someone else's, and a missing one is a 422.
    assert.deepEqual(JSON.parse(gh.stdinOf(1)), {
      body: "**Squiz reviewer · low — the line is wrong**",
      commit_id: HEAD_SHA,
      path: "scratch/target.txt",
      line: 7,
      side: "RIGHT",
    });
  });
});

test("the thread's node id is the one whose opening comment is the created one", async () => {
  const page = threadPage(
    [
      [3993900000, "PRRT_somebodyElses"],
      [3993908108, "PRRT_kwDOUEd2qM6hqHeq"],
    ],
    null,
  );
  await withFakeGh([CREATED_OK, { stdout: response(200, page) }], () => {
    const posting = postThread(request, { directory: tmpdir() });

    assert.deepEqual(posting, {
      outcome: "posted",
      threadId: "PRRT_kwDOUEd2qM6hqHeq",
      commentId: 3993908108,
      url: "https://github.com/jacygao/squiz/pull/80#discussion_r3993908108",
    });
  });
});

test("an anchor GitHub refuses is routed rather than reported as a failure", async () => {
  const refusal = validationFailed("pull_request_review_thread.line", "could not be resolved");
  await withFakeGh([errored(422, refusal, "Validation Failed")], (gh) => {
    const posting = postThread(request, { directory: tmpdir() });

    assert.equal(posting.outcome, "anchor-refused");
    assert.match(
      posting.outcome === "anchor-refused" ? posting.reason : "",
      /scratch\/target\.txt:7/u,
      "the caller writes the anchor into the summary, so the reason has to name it",
    );
    assert.equal(gh.calls(), 1, "there is no thread to read back for");
  });
});

test("a 422 that refused something other than the anchor is a failure", async () => {
  // GitHub refuses an empty comment body under the same prefix as a refused
  // anchor. Routing it would report a malformed finding as one that did not fit.
  const refusal = validationFailed(
    "pull_request_review_thread.body",
    "required when requesting changes",
  );
  await withFakeGh([errored(422, refusal, "Validation Failed")], () => {
    const posting = postThread(request, { directory: tmpdir() });

    assert.equal(
      posting.outcome,
      "failed",
      "only the path, the line and the side of a refusal mean the anchor would not fit",
    );
  });
});

test("a 422 carrying no errors at all is a failure", async () => {
  const body = {
    message: 'Invalid request.\n\nNo subschema in "oneOf" matched.\n"commit_id" wasn\'t supplied.',
    status: "422",
  };
  await withFakeGh([errored(422, body, "Invalid request.")], () => {
    const posting = postThread(request, { directory: tmpdir() });

    assert.equal(posting.outcome, "failed");
  });
});

test("a status that is not 422 is a failure whatever it says", async () => {
  const body = { message: "Not Found", status: "404" };
  await withFakeGh([errored(404, body, "Not Found")], () => {
    const posting = postThread(request, { directory: tmpdir() });

    assert.deepEqual(posting, {
      outcome: "failed",
      reason: "gh exited 1 on HTTP 404: gh: Not Found (HTTP 404)",
    });
  });
});

test("a comment that joined an existing thread is never reported as posted", async () => {
  // The response is a 201 on the right file and the right line either way.
  // `in_reply_to_id` is the only field that tells a new thread from a reply.
  const reply = { ...CREATED, in_reply_to_id: 3993900000 };
  await withFakeGh([{ stdout: response(201, reply) }, THREAD_FOUND], () => {
    const posting = postThread(request, { directory: tmpdir() });

    assert.equal(posting.outcome, "failed");
  });
});

test("an in_reply_to_id that is there and null opened a thread all the same", async () => {
  // The field's presence is the tell, not its value. A reader that took the
  // value would reject every real create, which carries no such field.
  const created = { ...CREATED, in_reply_to_id: null };
  await withFakeGh([{ stdout: response(201, created) }, THREAD_FOUND], () => {
    const posting = postThread(request, { directory: tmpdir() });

    assert.equal(posting.outcome, "posted");
  });
});

test("a comment posted whose thread is not found is neither a success nor a failure", async () => {
  await withFakeGh(
    [CREATED_OK, errored(502, { message: "Bad gateway" }, "Bad gateway")],
    () => {
      const posting = postThread(request, { directory: tmpdir() });

      assert.equal(posting.outcome, "posted-without-thread-id");
      assert.equal(
        posting.outcome === "posted-without-thread-id" ? posting.commentId : 0,
        3993908108,
        "the comment is up, so the caller has to be able to say where",
      );
    },
  );
});

test("a GraphQL error inside an HTTP 200 is not a thread id", async () => {
  // The read-back fails in the body rather than in the status. A caller reading
  // the status alone would report a thread id that is not there.
  const errors = { data: { node: null }, errors: [{ message: "Could not resolve to a node" }] };
  await withFakeGh([CREATED_OK, { stdout: response(200, errors) }], () => {
    const posting = postThread(request, { directory: tmpdir() });

    assert.equal(posting.outcome, "posted-without-thread-id");
  });
});

test("the read-back walks past the first page of threads", async () => {
  const first = threadPage([[111, "PRRT_other"]], "Y3Vyc29yOnYyOnAx");
  const second = threadPage([[3993908108, "PRRT_kwDOUEd2qM6hqHeq"]], null);
  await withFakeGh(
    [CREATED_OK, { stdout: response(200, first) }, { stdout: response(200, second) }],
    (gh) => {
      const posting = postThread(request, { directory: tmpdir() });

      assert.equal(posting.outcome, "posted");
      const sent: unknown = JSON.parse(gh.stdinOf(3));
      assert.deepEqual(
        (sent as { variables: unknown }).variables,
        { comment: "PRRC_kwDOUEd2qM7uDjOM", cursor: "Y3Vyc29yOnYyOnAx" },
        "a page that is not honoured drops the thread id for every busy pull request",
      );
    },
  );
});

test("a gh that is not installed is a failure rather than a throw", async () => {
  await withNoGh(() => {
    const posting = postThread(request, { directory: tmpdir() });

    assert.equal(posting.outcome, "failed");
    assert.match(posting.outcome === "failed" ? posting.reason : "", /gh could not be run/u);
  });
});

test("the comment and its path reach gh unchanged, whatever the reviewer wrote", async () => {
  // A comment body is written by a model and a path comes from the diff. Both
  // travel as JSON on stdin, so neither is ever parsed by a shell.
  const awkward: ThreadRequest = {
    pullRequest: 80,
    headSha: HEAD_SHA,
    anchor: { path: "scratch/ünïcödé and a $(id) `x`.txt", line: 1, side: "RIGHT" },
    body: "**Squiz reviewer · high — `rm -rf $HOME`**\n\n- A 'quoted' \"line\";\n- ünïcödé.",
  };
  await withFakeGh([CREATED_OK, THREAD_FOUND], (gh) => {
    postThread(awkward, { directory: tmpdir() });

    const sent: unknown = JSON.parse(gh.stdinOf(1));
    assert.deepEqual(sent, {
      body: awkward.body,
      commit_id: HEAD_SHA,
      path: awkward.anchor.path,
      line: 1,
      side: "RIGHT",
    });
  });
});

const CREATED_ON_FILE_OK: Reply = { stdout: response(201, CREATED_ON_FILE) };
const FILE_THREAD_FOUND: Reply = {
  stdout: response(200, threadPage([[3994572932, "PRRT_kwDOUEd2qM6hrybE"]], null)),
};

test("a file-scoped thread is created over REST, carrying no line and no side", async () => {
  await withFakeGh([CREATED_ON_FILE_OK, FILE_THREAD_FOUND], (gh) => {
    postFileThread(fileRequest, { directory: tmpdir() });

    assert.deepEqual(gh.argumentsOf(1), [
      "api",
      "--include",
      "--method",
      "POST",
      "repos/{owner}/{repo}/pulls/80/comments",
      "--input",
      "-",
    ]);
    // The exact key set, not a superset: a line beside `subject_type` is
    // refused outright, and a reply key would put the comment in someone
    // else's thread.
    assert.deepEqual(JSON.parse(gh.stdinOf(1)), {
      body: "**Squiz reviewer · low — the file has no tests**",
      commit_id: HEAD_SHA,
      path: "scratch/target.txt",
      subject_type: "file",
    });
  });
});

test("a file-scoped thread's node id is read back the way a line-anchored one's is", async () => {
  await withFakeGh([CREATED_ON_FILE_OK, FILE_THREAD_FOUND], (gh) => {
    const posting = postFileThread(fileRequest, { directory: tmpdir() });

    assert.deepEqual(posting, {
      outcome: "posted",
      threadId: "PRRT_kwDOUEd2qM6hrybE",
      commentId: 3994572932,
      url: "https://github.com/jacygao/squiz/pull/80#discussion_r3994572932",
    });
    const sent: unknown = JSON.parse(gh.stdinOf(2));
    assert.deepEqual(
      (sent as { variables: unknown }).variables,
      { comment: "PRRC_kwDOUEd2qM7uGFiE", cursor: null },
      "no REST response carries the thread id, so the created comment is what it is reached from",
    );
  });
});

test("a file GitHub refuses is routed rather than reported as a failure", async () => {
  const refusal = validationFailed("pull_request_review_thread.path", "could not be resolved");
  await withFakeGh([errored(422, refusal, "Validation Failed")], (gh) => {
    const posting = postFileThread(fileRequest, { directory: tmpdir() });

    assert.equal(posting.outcome, "anchor-refused");
    const reason = posting.outcome === "anchor-refused" ? posting.reason : "";
    assert.match(reason, /scratch\/target\.txt/u);
    assert.doesNotMatch(
      reason,
      /scratch\/target\.txt:\d/u,
      "there is no line to report, and a refusal naming one sends the reader to a line",
    );
    assert.equal(gh.calls(), 1, "there is no thread to read back for");
  });
});

test("a 422 refusing a file-scoped comment's body is a failure", async () => {
  // The same prefix as a refused file, and it means a malformed comment rather
  // than a file the diff does not carry.
  const refusal = validationFailed(
    "pull_request_review_thread.body",
    "required when requesting changes",
  );
  await withFakeGh([errored(422, refusal, "Validation Failed")], () => {
    const posting = postFileThread(fileRequest, { directory: tmpdir() });

    assert.equal(posting.outcome, "failed");
  });
});

test("a file-scoped comment that joined an existing thread is never reported as posted", async () => {
  const reply = { ...CREATED_ON_FILE, in_reply_to_id: 3993937859 };
  await withFakeGh([{ stdout: response(201, reply) }, FILE_THREAD_FOUND], () => {
    const posting = postFileThread(fileRequest, { directory: tmpdir() });

    assert.equal(posting.outcome, "failed");
  });
});

test("a gh that is not installed fails a file-scoped post rather than throwing", async () => {
  await withNoGh(() => {
    const posting = postFileThread(fileRequest, { directory: tmpdir() });

    assert.equal(posting.outcome, "failed");
  });
});
