import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { callGraphql, callRest, runGh } from "./gh.ts";

type FakeGh = {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly status?: number;
  /** Hangs instead of answering, so that a call can reach its bound. */
  readonly hangSeconds?: number;
  /** Kills itself, which is the null exit status with a signal. */
  readonly selfKill?: boolean;
};

type Fake = {
  /** Every argument `gh` was given, one per entry, exactly as it arrived. */
  readonly arguments: () => readonly string[];
  /** Everything written to `gh`'s stdin, as one string. */
  readonly stdin: () => string;
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
  const directory = await mkdtemp(join(tmpdir(), "squiz-gh-boundary-"));
  const argumentLog = join(directory, "arguments");
  const stdinLog = join(directory, "stdin");
  const cwdLog = join(directory, "cwd");

  const previous = process.env["PATH"];
  try {
    await writeFile(join(directory, "gh"), script(fake, argumentLog, stdinLog, cwdLog), "utf8");
    await chmod(join(directory, "gh"), 0o755);
    process.env["PATH"] = `${directory}:${previous ?? ""}`;
    return await body({
      arguments: () => lines(argumentLog),
      stdin: () => (existsSync(stdinLog) ? readFileSync(stdinLog, "utf8") : ""),
      workingDirectory: () => (existsSync(cwdLog) ? readFileSync(cwdLog, "utf8").trim() : null),
    });
  } finally {
    restorePath(previous);
    await rm(directory, { recursive: true, force: true });
  }
}

function script(fake: FakeGh, argumentLog: string, stdinLog: string, cwdLog: string): string {
  const lines = [
    "#!/bin/sh",
    'for argument in "$@"; do',
    `  printf '%s\\n' "$argument" >> ${quote(argumentLog)}`,
    "done",
    `pwd -P > ${quote(cwdLog)}`,
  ];
  if (fake.hangSeconds !== undefined) {
    // exec, so that the sleep is the process the bound kills rather than a
    // child holding the pipes open after its parent is gone.
    lines.push(`exec sleep ${fake.hangSeconds}`);
  } else {
    lines.push(`cat > ${quote(stdinLog)}`);
    if (fake.selfKill === true) lines.push("kill -9 $$");
    lines.push(`printf '%s' ${quote(fake.stdout ?? "")}`);
    lines.push(`printf '%s' ${quote(fake.stderr ?? "")} >&2`);
    lines.push(`exit ${fake.status ?? 0}`);
  }
  return `${lines.join("\n")}\n`;
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
 * The line endings are the fixture: the status line ends in a bare newline and
 * the headers in CRLF, so the blank line before the body is `\r\n\r\n`. A
 * reader splitting on `\n\n` finds no body at all.
 */
function included(status: string, body: string): string {
  return `HTTP/2.0 ${status}\nContent-Type: application/json; charset=utf-8\r\nX-Ratelimit-Remaining: 4987\r\n\r\n${body}`;
}

const anywhere = { directory: tmpdir() };

/** A path, a body and an id all admit these, and none of them may reach a shell. */
const hostile = "evil/$(id); rm -rf & `x` 'q'";

test("a REST answer carries the body and the HTTP status", async () => {
  await withFakeGh({ stdout: included("200 OK", '{"number":142,"head":{"sha":"abc"}}') }, () => {
    const result = callRest({ path: "repos/o/r/pulls/142" }, anywhere);

    assert.deepEqual(result, {
      outcome: "answered",
      httpStatus: 200,
      body: { number: 142, head: { sha: "abc" } },
    });
  });
});

test("a refused anchor reaches the caller as a 422 with its body", async () => {
  // A status available on a 200 and not on an error is a status not available
  // at all: the caller that posts a thread tells a refused anchor from a real
  // failure by reading both the status and the fields in the body.
  const body = JSON.stringify({
    message: "Validation Failed",
    errors: [{ resource: "PullRequestReviewThread", field: "pull_request_review_thread.line" }],
  });
  await withFakeGh(
    {
      status: 1,
      stdout: included("422 Unprocessable Entity", body),
      stderr: "gh: Validation Failed (HTTP 422)\n",
    },
    () => {
      const result = callRest(
        { path: "repos/o/r/pulls/142/comments", method: "POST", body: { line: 4 } },
        anywhere,
      );

      assert.equal(result.outcome, "exited");
      assert.equal(result.outcome === "exited" ? result.httpStatus : null, 422);
      assert.deepEqual(result.outcome === "exited" ? result.body : null, JSON.parse(body));
    },
  );
});

test("a failure's reason carries the HTTP status and what gh said", async () => {
  await withFakeGh(
    {
      status: 1,
      stdout: included("404 Not Found", '{"message":"Not Found"}'),
      stderr: "gh: Not Found (HTTP 404)\n",
    },
    () => {
      const result = callRest({ path: "repos/o/r/pulls/999999" }, anywhere);

      assert.equal(
        result.outcome === "exited" ? result.reason : "",
        "gh exited 1 on HTTP 404: gh: Not Found (HTTP 404)",
      );
    },
  );
});

test("the status line is read whatever HTTP version it names", async () => {
  // GitHub answers HTTP/2.0 today. A reader keyed to a version reads no status
  // at all the day that changes, and every call becomes unparsable.
  const stdout = `HTTP/1.1 201 Created\nContent-Type: application/json\r\n\r\n{"id":1}`;
  await withFakeGh({ stdout }, () => {
    const result = callRest({ path: "repos/o/r/pulls/1/comments", method: "POST" }, anywhere);

    assert.equal(result.outcome === "answered" ? result.httpStatus : null, 201);
  });
});

test("a GraphQL answer carries its data", async () => {
  const stdout = included("200 OK", '{"data":{"viewer":{"login":"jacygao"}}}');
  await withFakeGh({ stdout }, () => {
    const result = callGraphql({ query: "query{viewer{login}}" }, anywhere);

    assert.deepEqual(result, {
      outcome: "answered",
      httpStatus: 200,
      body: { data: { viewer: { login: "jacygao" } } },
    });
  });
});

test("a GraphQL response carrying errors is a failure, at exit 0 and HTTP 200", async () => {
  // The fixture exits 0 on purpose. Real `gh api graphql` exits 1 on a GraphQL
  // error, so a fixture that exits 1 is caught by the exit check even with the
  // errors guard deleted, and passes while proving nothing. Exit 0 with a
  // non-empty errors array is the only fixture the guard alone can answer.
  const stdout = included(
    "200 OK",
    JSON.stringify({
      data: { node: null },
      errors: [{ type: "NOT_FOUND", message: "Could not resolve to a node with the global id" }],
    }),
  );
  await withFakeGh({ status: 0, stdout }, () => {
    const result = callGraphql(
      { query: "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id}}}" },
      anywhere,
    );

    assert.equal(
      result.outcome,
      "graphql-errors",
      "a failed mutation inside an HTTP 200 must never read as a resolved thread",
    );
    assert.equal(result.outcome === "graphql-errors" ? result.errors.length : 0, 1);
    assert.match(
      result.outcome === "graphql-errors" ? result.reason : "",
      /Could not resolve to a node/u,
    );
  });
});

test("the errors array decides ahead of the exit status", async () => {
  // What real gh does: HTTP 200, exit 1, and only the errors array saying what
  // happened. The caller gets the errors rather than the exit status.
  const stdout = included(
    "200 OK",
    JSON.stringify({ data: { node: null }, errors: [{ message: "NOT_FOUND" }] }),
  );
  await withFakeGh({ status: 1, stdout, stderr: "gh: NOT_FOUND\n" }, () => {
    const result = callGraphql({ query: "query{node{id}}" }, anywhere);

    assert.equal(result.outcome, "graphql-errors");
    assert.equal(result.outcome === "graphql-errors" ? result.httpStatus : null, 200);
  });
});

test("an empty errors array is an answer", async () => {
  const stdout = included("200 OK", '{"data":{"repository":null},"errors":[]}');
  await withFakeGh({ stdout }, () => {
    const result = callGraphql({ query: "query{repository{id}}" }, anywhere);

    assert.equal(result.outcome, "answered");
  });
});

test("a gh that printed nothing never parses into an answer", async () => {
  // Exit 0 and silence. There is no answer in that, on either transport.
  await withFakeGh({ stdout: "" }, () => {
    assert.notEqual(
      callRest({ path: "repos/o/r/pulls/1" }, anywhere).outcome,
      "answered",
      "an empty stdout must not read as an empty response body",
    );
    assert.notEqual(callGraphql({ query: "query{viewer{login}}" }, anywhere).outcome, "answered");
    // runGh parses nothing, so the silence reaches its caller as silence and is
    // refused where the answer is read.
    assert.deepEqual(runGh(["pr", "diff"], anywhere), { outcome: "ran", stdout: "" });
  });
});

test("a body that is not JSON is a failure that still carries the status", async () => {
  await withFakeGh({ stdout: included("200 OK", "<html>a proxy said no</html>") }, () => {
    const result = callRest({ path: "repos/o/r/pulls/1" }, anywhere);

    assert.equal(result.outcome, "unparsable");
    assert.equal(result.outcome === "unparsable" ? result.httpStatus : null, 200);
  });
});

test("a response with headers and no body is a failure", async () => {
  await withFakeGh({ stdout: "HTTP/2.0 200 OK\nContent-Type: application/json\r\n" }, () => {
    const result = callRest({ path: "repos/o/r/pulls/1" }, anywhere);

    assert.equal(result.outcome, "unparsable");
  });
});

test("a gh that is not installed is a failure and not a throw", async () => {
  await withNoGh(() => {
    const result = callRest({ path: "repos/o/r/pulls/1" }, anywhere);

    assert.equal(result.outcome, "not-run");
  });
});

test("a gh that hangs is abandoned at the bound and GitHub is unreachable", async () => {
  // The bound exercised rather than asserted: this gh never answers, and only a
  // timeout that reaches the subprocess ends the call. A lowered bound is what
  // keeps the test short; nothing can raise the ceiling.
  const started = Date.now();
  await withFakeGh({ hangSeconds: 30 }, () => {
    const result = callRest({ path: "repos/o/r/pulls/1" }, { ...anywhere, boundMs: 250 });

    assert.equal(
      result.outcome,
      "unreachable",
      "a call that reached the bound is GitHub being unreachable, not a gh that would not run",
    );
    assert.match(result.outcome === "unreachable" ? result.reason : "", /could not be reached/u);
  });
  assert.ok(
    Date.now() - started < 10_000,
    "the call must be abandoned at its bound rather than waiting gh out",
  );
});

test("a gh killed by a signal is unreachable rather than an exit of null", async () => {
  await withFakeGh({ selfKill: true }, () => {
    const result = runGh(["pr", "list"], anywhere);

    assert.equal(result.outcome, "unreachable");
    assert.match(result.outcome === "unreachable" ? result.reason : "", /killed by SIGKILL/u);
  });
});

test("a REST body goes on stdin as JSON and never into the argument array", async () => {
  // The comment body is written by a model and the path is built from a branch.
  // Neither reaches argv, so neither can be read as a flag or by a shell.
  await withFakeGh({ stdout: included("201 Created", "{}") }, (gh) => {
    callRest(
      {
        path: `repos/o/r/pulls/1/comments?ref=${hostile}`,
        method: "POST",
        body: { body: hostile, line: 4, side: "RIGHT" },
      },
      anywhere,
    );

    assert.deepEqual(gh.arguments(), [
      "api",
      "--include",
      "--method",
      "POST",
      `repos/o/r/pulls/1/comments?ref=${hostile}`,
      "--input",
      "-",
    ]);
    assert.deepEqual(JSON.parse(gh.stdin()), { body: hostile, line: 4, side: "RIGHT" });
  });
});

test("a call with no body reads nothing from stdin", async () => {
  await withFakeGh({ stdout: included("200 OK", "{}") }, (gh) => {
    callRest({ path: "repos/o/r/pulls/1" }, anywhere);

    assert.deepEqual(gh.arguments(), ["api", "--include", "repos/o/r/pulls/1"]);
    assert.equal(gh.stdin(), "");
  });
});

test("a GraphQL query and its variables go as one JSON body", async () => {
  const query = "mutation($threadId:ID!,$body:String!){addPullRequestReviewThreadReply}";
  await withFakeGh({ stdout: included("200 OK", '{"data":{}}') }, (gh) => {
    callGraphql({ query, variables: { threadId: "PRRT_kwDOUEd2qM6fnpx6", body: hostile } }, anywhere);

    assert.deepEqual(gh.arguments(), ["api", "graphql", "--include", "--input", "-"]);
    assert.deepEqual(JSON.parse(gh.stdin()), {
      query,
      variables: { threadId: "PRRT_kwDOUEd2qM6fnpx6", body: hostile },
    });
  });
});

test("an argument array reaches gh unsplit, whatever it holds", async () => {
  await withFakeGh({ stdout: "{}" }, (gh) => {
    runGh(["pr", "list", "--head", hostile], anywhere);

    assert.deepEqual(gh.arguments(), ["pr", "list", "--head", hostile]);
  });
});

test("gh is run from the directory it was given", async () => {
  // Which repository gh answers about is decided by where it runs.
  const directory = await realpath(await mkdtemp(join(tmpdir(), "squiz-where-")));
  try {
    await withFakeGh({ stdout: included("200 OK", "{}") }, (gh) => {
      callRest({ path: "repos/{owner}/{repo}/pulls/1" }, { directory });

      assert.equal(gh.workingDirectory(), directory);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
