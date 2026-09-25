/**
 * A round's findings are posted as a batch, and asserted as one. The failure
 * this module exists to prevent is a finding that reaches neither a thread nor
 * the summary, and a test that posts one finding at a time cannot see it.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type {
  ChangeFinding,
  FileFinding,
  Finding,
  LineFinding,
  Severity,
} from "../findings/finding.ts";
import {
  type FindingOutcome,
  type NewFindings,
  postFindings,
  type PostedFindings,
} from "./post-findings.ts";

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
 * A fake binary rather than an injected poster: one thread that posts is a
 * create and then a read-back, so how many calls a round makes and the order it
 * makes them in are part of what this module does, and an injected poster would
 * stand where that evidence is.
 */
async function withFakeGh<T>(
  replies: readonly Reply[],
  body: (gh: Fake) => Promise<T> | T,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "squiz-post-findings-"));
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
  const directory = await mkdtemp(join(tmpdir(), "squiz-post-findings-empty-"));
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

/** What `gh api --include` prints: a bare newline after the status, CRLF after the headers. */
function response(httpStatus: number, body: unknown): string {
  return `HTTP/2.0 ${httpStatus} X\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`;
}

/** A `gh` that exited on an HTTP error, which is how a 422 and a 500 arrive. */
function errored(httpStatus: number, body: unknown, said: string): Reply {
  return {
    status: 1,
    stdout: response(httpStatus, body),
    stderr: `gh: ${said} (HTTP ${httpStatus})\n`,
  };
}

const HEAD_SHA = "3a1937e729dbab0f618ef761c833a7e2d3675b80";
const PULL_REQUEST = 80;
const COMMENTS = `repos/{owner}/{repo}/pulls/${PULL_REQUEST}/comments`;

/**
 * `git diff` of one changed line in a hundred-line file and one changed binary
 * file.
 *
 * Line 88 of `card.ts` is the only line anything can be anchored to. `logo.png`
 * has no hunk at all, so it is a file a thread can hang on and no line of it is.
 * `src/sync/queue.ts` is in neither, so the fixture carries every placement and
 * both ways of missing one.
 */
const diff = `
diff --git a/src/ui/card.ts b/src/ui/card.ts
index d3d0cb2..6db135b 100644
--- a/src/ui/card.ts
+++ b/src/ui/card.ts
@@ -85,7 +85,7 @@
 // line 85
 // line 86
 // line 87
-// line 88
+// line 88 CHANGED
 // line 89
 // line 90
 // line 91
diff --git a/src/ui/logo.png b/src/ui/logo.png
index c06048b..2247581 100644
Binary files a/src/ui/logo.png and b/src/ui/logo.png differ
`.slice(1);

// The same diff cut off inside its hunk, which is what one truncated in transit
// looks like: the header declares seven new lines and the body delivers three.
const unreadableDiff = diff.split("\n").slice(0, 9).join("\n");

function lineFinding(
  headline: string,
  file: string,
  line: number,
  severity: Severity = "high",
): LineFinding {
  return {
    scope: "line",
    file,
    line,
    severity,
    headline,
    reasoning: ["The one point beneath the headline."],
    suggestedFix: "Do the other thing.",
  };
}

function fileFinding(headline: string, file: string): FileFinding {
  return {
    scope: "file",
    file,
    severity: "high",
    headline,
    reasoning: ["The file as a whole, which no single line of it owns."],
    suggestedFix: "Split it.",
  };
}

function changeFinding(headline: string): ChangeFinding {
  return {
    scope: "change",
    severity: "high",
    headline,
    reasoning: ["The change as a whole, which no single line owns."],
    suggestedFix: "Take the other approach.",
  };
}

const onAChangedLine = lineFinding("on a changed line", "src/ui/card.ts", 88);
const onAnUnchangedLine = lineFinding("on an unchanged line", "src/ui/card.ts", 12);
const inABinaryFile = lineFinding("in a binary file", "src/ui/logo.png", 1);
const inAnUntouchedFile = lineFinding("in an untouched file", "src/sync/queue.ts", 134);
const aboutAChangedFile = fileFinding("about a changed file", "src/ui/card.ts");
const aboutAnUntouchedFile = fileFinding("about an untouched file", "src/sync/queue.ts");
const aboutTheChange = changeFinding("about the change as a whole");

/** The comment each fixture renders to, written out rather than rendered again. */
const ON_A_CHANGED_LINE = [
  "**Squiz reviewer · high — on a changed line**",
  "",
  "- The one point beneath the headline.",
  "",
  "**Suggested fix:** Do the other thing.",
].join("\n");

const ABOUT_A_CHANGED_FILE = [
  "**Squiz reviewer · high — about a changed file**",
  "",
  "- The file as a whole, which no single line of it owns.",
  "",
  "**Suggested fix:** Split it.",
].join("\n");

const ON_AN_UNCHANGED_LINE = [
  "**Squiz reviewer · high — on an unchanged line**",
  "",
  "- The one point beneath the headline.",
  "",
  "**Suggested fix:** Do the other thing.",
  "",
  "**Where:** `src/ui/card.ts:12` — the diff carries no such line to anchor a comment to.",
].join("\n");

function post(findings: readonly Finding[], against = diff): PostedFindings {
  const round: NewFindings = {
    findings,
    diff: against,
    pullRequest: PULL_REQUEST,
    headSha: HEAD_SHA,
  };
  return postFindings(round, { directory: tmpdir() });
}

/** A create response, which carries no `in_reply_to_id` at all when it opened a thread. */
function createdComment(commentId: number): Reply {
  return {
    stdout: response(201, {
      id: commentId,
      node_id: `PRRC_${commentId}`,
      html_url: `https://github.com/jacygao/squiz/pull/80#discussion_r${commentId}`,
    }),
  };
}

/** The read-back, which finds a thread by the database id of the comment that opened it. */
function threadFound(commentId: number, threadId: string): Reply {
  return {
    stdout: response(200, {
      data: {
        node: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: "Y3Vyc29yOnYy" },
              nodes: [{ id: threadId, comments: { nodes: [{ databaseId: commentId }] } }],
            },
          },
        },
      },
    }),
  };
}

/** The two calls one thread that posts takes: the create, then the read-back. */
function posts(commentId: number): readonly Reply[] {
  return [createdComment(commentId), threadFound(commentId, `PRRT_${commentId}`)];
}

/** A 422 refusing one named field, in the shape GitHub returns. */
function validationFailed(field: string, message: string): unknown {
  return {
    message: "Validation Failed",
    errors: [{ resource: "PullRequestReviewComment", code: "custom", field, message }],
    status: "422",
  };
}

/** How GitHub refuses an anchor it will not place a comment on. */
function anchorRefused(field: "path" | "line"): Reply {
  return errored(
    422,
    validationFailed(`pull_request_review_thread.${field}`, "could not be resolved"),
    "Validation Failed",
  );
}

const SERVER_ERROR: Reply = errored(500, { message: "Server Error" }, "Server Error");

/** The request body of the `n`th call, whatever endpoint it went to. */
function sentBy(gh: Fake, n: number): Readonly<Record<string, unknown>> {
  return JSON.parse(gh.stdinOf(n)) as Readonly<Record<string, unknown>>;
}

/** The comment bodies `gh` was asked to create, in the order it was asked. */
function bodiesCreated(gh: Fake): string[] {
  const bodies: string[] = [];
  for (let n = 1; n <= gh.calls(); n += 1) {
    if (!gh.argumentsOf(n).includes(COMMENTS)) continue;
    bodies.push(String(sentBy(gh, n)["body"]));
  }
  return bodies;
}

/** The headline a comment names, which is how a batch of them reads as names. */
function headlinesCreated(gh: Fake): string[] {
  return bodiesCreated(gh).map((body) =>
    (body.split("\n")[0] ?? "").replace(/^\*\*Squiz reviewer · \w+ — /u, "").replace(/\*\*$/u, ""),
  );
}

/** What each finding came to, named by its headline, in the order they came back. */
function accountOf(posted: PostedFindings): string[] {
  return posted.outcomes.map((outcome) => `${outcome.finding.headline}: ${outcome.outcome}`);
}

function only(posted: PostedFindings): FindingOutcome {
  assert.equal(posted.outcomes.length, 1, "one finding in must be one outcome out");
  const [outcome] = posted.outcomes;
  assert.ok(outcome !== undefined);
  return outcome;
}

test("a finding on a changed line becomes a thread anchored to that line", async () => {
  await withFakeGh(posts(101), (gh) => {
    const outcome = only(post([onAChangedLine]));

    // The exact key set, not a superset: an extra reply key turns a new thread
    // into a comment inside someone else's.
    assert.deepEqual(sentBy(gh, 1), {
      body: ON_A_CHANGED_LINE,
      commit_id: HEAD_SHA,
      path: "src/ui/card.ts",
      line: 88,
      side: "RIGHT",
    });
    assert.deepEqual(outcome, {
      outcome: "threaded",
      finding: onAChangedLine,
      placement: "inline",
      threadId: "PRRT_101",
      url: "https://github.com/jacygao/squiz/pull/80#discussion_r101",
    });
  });
});

test("a finding about a changed file becomes a thread on the file, carrying no line", async () => {
  await withFakeGh(posts(102), (gh) => {
    const outcome = only(post([aboutAChangedFile]));

    // No line and no side beside the subject type: a request carrying both is
    // refused outright.
    assert.deepEqual(sentBy(gh, 1), {
      body: ABOUT_A_CHANGED_FILE,
      commit_id: HEAD_SHA,
      path: "src/ui/card.ts",
      subject_type: "file",
    });
    assert.deepEqual(outcome, {
      outcome: "threaded",
      finding: aboutAChangedFile,
      placement: "file",
      threadId: "PRRT_102",
      url: "https://github.com/jacygao/squiz/pull/80#discussion_r102",
    });
  });
});

test("a finding whose line the diff does not carry hangs on the file, naming the line", async () => {
  await withFakeGh(posts(103), (gh) => {
    const outcome = only(post([onAnUnchangedLine]));

    assert.deepEqual(sentBy(gh, 1), {
      body: ON_AN_UNCHANGED_LINE,
      commit_id: HEAD_SHA,
      path: "src/ui/card.ts",
      subject_type: "file",
    });
    assert.equal(outcome.outcome, "threaded");
  });
});

test("a finding on a line of a binary file hangs on the file", async () => {
  await withFakeGh(posts(104), (gh) => {
    const outcome = only(post([inABinaryFile]));

    assert.equal(sentBy(gh, 1)["path"], "src/ui/logo.png");
    assert.equal(sentBy(gh, 1)["subject_type"], "file");
    assert.equal(outcome.outcome, "threaded");
  });
});

test("a finding about the change as a whole is noted for the summary and posts nothing", async () => {
  await withFakeGh([], (gh) => {
    const outcome = only(post([aboutTheChange]));

    assert.equal(gh.calls(), 0, "a general finding is a line of the summary, not a thread");
    assert.deepEqual(outcome, { outcome: "noted", finding: aboutTheChange, location: undefined });
  });
});

test("a finding the diff places nowhere is noted with where it said the defect is", async () => {
  await withFakeGh([], (gh) => {
    const posted = post([inAnUntouchedFile, aboutAnUntouchedFile]);

    assert.equal(gh.calls(), 0);
    assert.deepEqual(posted.outcomes, [
      { outcome: "noted", finding: inAnUntouchedFile, location: "src/sync/queue.ts:134" },
      { outcome: "noted", finding: aboutAnUntouchedFile, location: "src/sync/queue.ts" },
    ]);
  });
});

test("an anchor GitHub refuses is noted rather than failed, and nothing is posted again", async () => {
  await withFakeGh([anchorRefused("line")], (gh) => {
    const outcome = only(post([onAChangedLine]));

    assert.equal(gh.calls(), 1, "a refused anchor is not tried again anywhere else");
    assert.deepEqual(outcome, {
      outcome: "noted",
      finding: onAChangedLine,
      location: "src/ui/card.ts:88",
    });
  });
});

test("a file thread GitHub refuses is noted with the file alone", async () => {
  await withFakeGh([anchorRefused("path")], () => {
    const outcome = only(post([aboutAChangedFile]));

    assert.deepEqual(outcome, {
      outcome: "noted",
      finding: aboutAChangedFile,
      location: "src/ui/card.ts",
    });
  });
});

test("a refused file thread for a line finding is noted with that line", async () => {
  await withFakeGh([anchorRefused("path")], () => {
    const outcome = only(post([onAnUnchangedLine]));

    assert.deepEqual(outcome, {
      outcome: "noted",
      finding: onAnUnchangedLine,
      location: "src/ui/card.ts:12",
    });
  });
});

/**
 * The same 422 prefix carries refusals that are real failures. Routing one of
 * those as an anchor that did not fit reports a malformed comment as a finding
 * that could not be placed, and nobody is told the comment was malformed.
 */
test("a 422 that is not about the anchor fails rather than routing the finding", async () => {
  const malformed = validationFailed(
    "pull_request_review_thread.body",
    "required when requesting changes",
  );
  await withFakeGh([errored(422, malformed, "Validation Failed")], () => {
    const outcome = only(post([onAChangedLine]));

    assert.equal(outcome.outcome, "failed");
  });
});

test("a comment that landed without its thread id is threaded, saying nothing can rule on it", async () => {
  await withFakeGh([createdComment(105), threadFound(999, "PRRT_somebodyElses")], () => {
    const outcome = only(post([onAChangedLine]));

    assert.ok(outcome.outcome === "threaded");
    assert.equal(outcome.threadId, null, "the comment is up and no later round can rule on it");
    assert.match(outcome.unknownThread ?? "", /no thread/u);
    assert.equal(outcome.url, "https://github.com/jacygao/squiz/pull/80#discussion_r105");
  });
});

test("the findings are posted high severity first, holding the reviewer's order within one", async () => {
  const findings = [
    lineFinding("low first", "src/ui/card.ts", 88, "low"),
    lineFinding("high first", "src/ui/card.ts", 88),
    lineFinding("medium", "src/ui/card.ts", 88, "medium"),
    lineFinding("high second", "src/ui/card.ts", 88),
  ];
  await withFakeGh([...posts(111), ...posts(112), ...posts(113), ...posts(114)], (gh) => {
    const posted = post(findings);

    assert.deepEqual(headlinesCreated(gh), ["high first", "high second", "medium", "low first"]);
    assert.deepEqual(
      posted.outcomes.map((outcome) => outcome.finding.headline),
      ["high first", "high second", "medium", "low first"],
      "the outcomes come back in the order the findings were posted in",
    );
  });
});

test("the threads that landed stay where another fails, and the round is told which did not", async () => {
  const first = lineFinding("first", "src/ui/card.ts", 88);
  const second = lineFinding("second", "src/ui/card.ts", 88);
  const third = lineFinding("third", "src/ui/card.ts", 88);
  await withFakeGh([...posts(121), SERVER_ERROR, ...posts(123)], (gh) => {
    const posted = post([first, second, third]);

    assert.deepEqual(accountOf(posted), ["first: threaded", "second: failed", "third: threaded"]);
    assert.equal(gh.calls(), 5, "the failed create is not tried again, and the third still runs");
    const failed = posted.outcomes[1];
    assert.ok(failed?.outcome === "failed");
    assert.match(failed.reason, /500/u, "the round reports what GitHub did instead");
  });
});

/**
 * The assertion the module exists for. A finding that falls through a branch is
 * a defect the pull request never carries, and a round that dropped one reads
 * exactly like a round that had nothing more to say.
 */
test("every finding in produces exactly one outcome out", async () => {
  const findings: readonly Finding[] = [
    onAChangedLine,
    onAnUnchangedLine,
    inABinaryFile,
    inAnUntouchedFile,
    aboutAChangedFile,
    aboutAnUntouchedFile,
    aboutTheChange,
  ];
  // Every way a create can answer, one per finding a thread is attempted for:
  // posted, posted without its thread id, refused, failed.
  const replies = [
    ...posts(131),
    createdComment(132),
    threadFound(999, "PRRT_somebodyElses"),
    anchorRefused("path"),
    SERVER_ERROR,
  ];
  await withFakeGh(replies, () => {
    const posted = post(findings);

    assert.equal(posted.outcomes.length, findings.length);
    assert.deepEqual(
      posted.outcomes.map((outcome) => outcome.finding).toSorted(byHeadline),
      [...findings].toSorted(byHeadline),
      "each finding handed in comes back exactly once",
    );
    assert.deepEqual(accountOf(posted), [
      "on a changed line: threaded",
      "on an unchanged line: threaded",
      "in a binary file: noted",
      "in an untouched file: noted",
      "about a changed file: failed",
      "about an untouched file: noted",
      "about the change as a whole: noted",
    ]);
  });
});

test("a diff that cannot be read notes every finding and posts nothing", async () => {
  await withFakeGh([], (gh) => {
    const posted = post([onAChangedLine, aboutAChangedFile, aboutTheChange], unreadableDiff);

    assert.equal(gh.calls(), 0);
    assert.deepEqual(posted.outcomes, [
      { outcome: "noted", finding: onAChangedLine, location: "src/ui/card.ts:88" },
      { outcome: "noted", finding: aboutAChangedFile, location: "src/ui/card.ts" },
      { outcome: "noted", finding: aboutTheChange, location: undefined },
    ]);
    assert.ok(
      posted.unreadableDiff instanceof Error,
      "a diff that was read and carried nothing is a different fact",
    );
  });
});

test("a round with no findings posts nothing and accounts for nothing", async () => {
  await withFakeGh([], (gh) => {
    const posted = post([]);

    assert.equal(gh.calls(), 0);
    assert.deepEqual(posted, { outcomes: [] });
  });
});

test("a gh that cannot be run fails every finding a thread was to hold", async () => {
  await withNoGh(() => {
    const posted = post([onAChangedLine, aboutAChangedFile, aboutTheChange]);

    assert.deepEqual(accountOf(posted), [
      "on a changed line: failed",
      "about a changed file: failed",
      "about the change as a whole: noted",
    ]);
  });
});

function byHeadline(a: Finding, b: Finding): number {
  return a.headline.localeCompare(b.headline);
}
