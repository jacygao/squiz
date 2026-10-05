import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { renderComment, renderReply } from "../findings/comment.ts";
import type { LineFinding } from "../findings/finding.ts";
import type { ReviewThread, ThreadComment } from "../github/threads.ts";
import { composeReview, printReview, reviewOutputPath, type ReviewResult } from "./output.ts";

// Every expected output below is written out whole, so any change of wording
// shows here as a failure.
const PATH = "/work/squiz/.squiz/41/review.txt";

function thread(overrides: Partial<ReviewThread>): ReviewThread {
  return {
    id: "PRRT_kwDOL7tYbc5abcd0",
    isResolved: false,
    isOutdated: false,
    path: "packages/sync/src/queue.ts",
    anchor: { at: "line", line: 1 },
    comments: [],
    ...overrides,
  };
}

function comment(body: string): ThreadComment {
  return {
    id: "PRRC_fixture",
    createdAt: "2026-09-06T07:13:05Z",
    databaseId: null,
    author: "squiz",
    body,
  };
}

function raised(id: string, finding: LineFinding, ...replies: string[]): ReviewThread {
  return thread({
    id,
    path: finding.file,
    anchor: { at: "line", line: finding.line },
    comments: [comment(renderComment(finding)), ...replies.map(comment)],
  });
}

const backoff: LineFinding = {
  scope: "line",
  file: "packages/sync/src/queue.ts",
  line: 134,
  severity: "high",
  headline: "Retry backoff resets on every enqueue",
  reasoning: [
    "`enqueue()` calls `resetBackoff()` on every call, so a busy queue never backs off.",
    "Reachable whenever a retry is pending and a new item arrives.",
  ],
  suggestedFix: "reset the backoff only when the queue was empty.",
};

const skew: LineFinding = {
  scope: "line",
  file: "packages/sync/src/session.ts",
  line: 57,
  severity: "medium",
  headline: "Clock skew is read as token expiry",
  reasoning: ["`isExpired()` compares the server's `exp` against the local clock with no margin."],
  suggestedFix: "allow the skew the server documents before reading a token as expired.",
};

const backoffThread = raised("PRRT_kwDOL7tYbc5abcd1", backoff);
const skewThread = raised(
  "PRRT_kwDOL7tYbc5abcd2",
  skew,
  renderReply("The server bounds skew at two seconds, and `clock.ts:12` already allows for it."),
);

/** A result of a round, `overrides` naming what the case is about. */
function reviewed(overrides: Partial<ReviewResult> & { exit: 0 | 2 | 3 }): ReviewResult {
  return {
    outcome: "reviewed",
    pullRequest: 41,
    commit: "3f9c2e0",
    round: 1,
    cap: 3,
    newFindings: 0,
    threads: [],
    recorded: false,
    ...(overrides.exit === 3 ? { closedAt: "round cap" } : {}),
    ...overrides,
  } as ReviewResult;
}

const MOVED =
  "from a detached HEAD at 3f9c2e07b1d4a8c6e5f0923b7a1d6c4e8b2f5a90 to a detached HEAD at 8d21a4f6c3b9e0d7a5f2c8b1e4d9a6c3f7b0e258";

const MOVED_PARAGRAPH =
  "`HEAD` moved while the reviewer ran: from a detached HEAD at 3f9c2e07b1d4a8c6e5f0923b7a1d6c4e8b2f5a90 to a detached HEAD at 8d21a4f6c3b9e0d7a5f2c8b1e4d9a6c3f7b0e258. The move was in the reviewer's snapshot, which is removed after the round, and the coding agent's worktree is as it was.";

test("the output file is .squiz/<number>/review.txt under the worktree, as an absolute path", () => {
  assert.equal(reviewOutputPath("/work/squiz", 41), PATH);
});

test("threads open, exit 2, prints each thread under its squiz threads line", () => {
  const printed = composeReview(
    reviewed({ exit: 2, newFindings: 2, threads: [backoffThread, skewThread] }),
    PATH,
  );

  assert.equal(printed.exit, 2);
  assert.equal(printed.stderr, "");
  assert.equal(
    printed.stdout,
    `Full output: /work/squiz/.squiz/41/review.txt
Squiz reviewed PR #41 at 3f9c2e0: round 1 of 3, 2 new findings.

2 threads are open:

PRRT_kwDOL7tYbc5abcd1 packages/sync/src/queue.ts:134 high — Retry backoff resets on every enqueue
  - \`enqueue()\` calls \`resetBackoff()\` on every call, so a busy queue never backs off.
  - Reachable whenever a retry is pending and a new item arrives.

  **Suggested fix:** reset the backoff only when the queue was empty.

PRRT_kwDOL7tYbc5abcd2 packages/sync/src/session.ts:57 medium — Clock skew is read as token expiry
  - \`isExpired()\` compares the server's \`exp\` against the local clock with no margin.

  **Suggested fix:** allow the skew the server documents before reading a token as expired.

  **Squiz coding agent**

  The server bounds skew at two seconds, and \`clock.ts:12\` already allows for it.

Fix what applies, and reply on each thread with \`squiz reply <id> <text>\` to say
what you changed or why you disagree. Commit and push what you changed, then run
\`squiz review 41\` again.
`,
  );
});

test("a result the run did not produce says it was already reviewed", () => {
  const printed = composeReview(
    reviewed({ exit: 2, newFindings: 2, threads: [backoffThread, skewThread], recorded: true }),
    PATH,
  );

  assert.ok(
    printed.stdout.startsWith(`Full output: /work/squiz/.squiz/41/review.txt
Squiz already reviewed PR #41 at 3f9c2e0: round 1 of 3, 2 new findings.
`),
    printed.stdout,
  );
});

test("nothing open, exit 0", () => {
  const printed = composeReview(reviewed({ exit: 0, commit: "8d21a4f", round: 2 }), PATH);

  assert.equal(printed.exit, 0);
  assert.equal(
    printed.stdout,
    `Full output: /work/squiz/.squiz/41/review.txt
Squiz reviewed PR #41 at 8d21a4f: round 2 of 3, no new findings.

Nothing is open. The review is closed, and its summary is on the pull request.
`,
  );
});

test("closed at the round cap with threads open, exit 3, prints them", () => {
  const printed = composeReview(
    reviewed({ exit: 3, commit: "77e0f19", round: 3, threads: [skewThread] }),
    PATH,
  );

  assert.equal(printed.exit, 3);
  assert.ok(
    printed.stdout.startsWith(`Full output: /work/squiz/.squiz/41/review.txt
Squiz reviewed PR #41 at 77e0f19: round 3 of 3, no new findings.

The round cap is reached. The review is closed with 1 thread open, and its summary
is on the pull request. A person takes it from here.

PRRT_kwDOL7tYbc5abcd2 packages/sync/src/session.ts:57 medium — Clock skew is read as token expiry
  - `),
    printed.stdout,
  );
  assert.ok(printed.stdout.endsWith("already allows for it.\n"), printed.stdout);
});

test("closed at the token bound, the second paragraph says so instead", () => {
  const printed = composeReview(
    reviewed({ exit: 3, closedAt: "token bound", threads: [skewThread] }),
    PATH,
  );

  assert.match(printed.stdout, /\n\nThe token bound is reached\. The review is closed with 1 thread open/u);
});

test("the open threads are counted in the words the count needs", () => {
  const one = composeReview(reviewed({ exit: 2, newFindings: 1, threads: [backoffThread] }), PATH);
  const two = composeReview(
    reviewed({ exit: 2, newFindings: 2, threads: [backoffThread, skewThread] }),
    PATH,
  );
  const closedTwo = composeReview(reviewed({ exit: 3, threads: [backoffThread, skewThread] }), PATH);

  assert.match(one.stdout, /: round 1 of 3, 1 new finding\.\n\n1 thread is open:\n/u);
  assert.match(two.stdout, /: round 1 of 3, 2 new findings\.\n\n2 threads are open:\n/u);
  assert.match(closedTwo.stdout, /The review is closed with 2 threads open, and its summary\n/u);
});

test("a resolved thread is not printed, nor counted as open", () => {
  const resolved = { ...skewThread, isResolved: true };
  const printed = composeReview(
    reviewed({ exit: 2, newFindings: 1, threads: [backoffThread, resolved] }),
    PATH,
  );

  assert.match(printed.stdout, /\n1 thread is open:\n/u);
  assert.doesNotMatch(printed.stdout, /PRRT_kwDOL7tYbc5abcd2/u);
});

test("every line of a comment is indented, and a code block in it keeps its shape", () => {
  const body = [
    "**Squiz reviewer · low — Parse once**",
    "",
    "Before:",
    "",
    "```ts",
    "if (a) {",
    "  parse(a);",
    "",
    "  parse(a);",
    "}",
    "```",
  ].join("\n");
  const printed = composeReview(
    reviewed({
      exit: 2,
      newFindings: 1,
      threads: [thread({ id: "PRRT_code", path: "src/a.ts", anchor: { at: "line", line: 3 }, comments: [comment(body)] })],
    }),
    PATH,
  );

  assert.match(
    printed.stdout,
    /\nPRRT_code src\/a\.ts:3 low — Parse once\n {2}Before:\n\n {2}```ts\n {2}if \(a\) \{\n {4}parse\(a\);\n\n {4}parse\(a\);\n {2}\}\n {2}```\n\nFix what applies/u,
  );
});

test("a comment written with CRLF line ends prints as lines, with no carriage return", () => {
  const body = "**Squiz reviewer · low — Parse once**\r\n\r\n- first\r\n- second";
  const printed = composeReview(
    reviewed({
      exit: 2,
      newFindings: 1,
      threads: [thread({ id: "PRRT_crlf", comments: [comment(body)] })],
    }),
    PATH,
  );

  assert.doesNotMatch(printed.stdout, /\r/u);
  assert.match(printed.stdout, /low — Parse once\n {2}- first\n {2}- second\n/u);
});

test("a thread whose only comment is its first line prints as the line alone", () => {
  const printed = composeReview(
    reviewed({
      exit: 2,
      newFindings: 1,
      threads: [thread({ id: "PRRT_bare", comments: [comment("**Squiz reviewer · low — Bare**")] })],
    }),
    PATH,
  );

  assert.match(printed.stdout, /\n\nPRRT_bare packages\/sync\/src\/queue\.ts:1 low — Bare\n\nFix what applies/u);
});

test("a HEAD that moved in the snapshot ends an exit 2 or 3 output with the paragraph naming both ends", () => {
  const two = composeReview(
    reviewed({ exit: 2, newFindings: 1, threads: [backoffThread], moved: MOVED }),
    PATH,
  );
  const three = composeReview(reviewed({ exit: 3, threads: [skewThread], moved: MOVED }), PATH);

  assert.ok(two.stdout.endsWith(`\`squiz review 41\` again.\n\n${MOVED_PARAGRAPH}\n`), two.stdout);
  assert.ok(three.stdout.endsWith(`already allows for it.\n\n${MOVED_PARAGRAPH}\n`), three.stdout);
});

test("still reviewing, exit 4: the run's own state is under review", () => {
  const printed = composeReview(
    { outcome: "reviewing", pullRequest: 41, wait: "under review", commit: "3f9c2e0" },
    PATH,
  );

  assert.equal(printed.exit, 4);
  assert.equal(
    printed.stdout,
    `Full output: /work/squiz/.squiz/41/review.txt
Squiz is still reviewing PR #41 at 3f9c2e0. Run \`squiz review 41\` again to wait for it.
`,
  );
});

test("still reviewing, exit 4: the run's state is queued behind the round of an older one", () => {
  const printed = composeReview(
    { outcome: "reviewing", pullRequest: 41, wait: "queued", commit: "8d21a4f", reviewing: "3f9c2e0" },
    PATH,
  );

  assert.equal(printed.exit, 4);
  assert.equal(
    printed.stdout,
    `Full output: /work/squiz/.squiz/41/review.txt
Squiz is reviewing PR #41 at 3f9c2e0 first, and 8d21a4f is next. Run \`squiz review 41\` again to wait for it.
`,
  );
});

test("still reviewing, exit 4: the run's state was clean and a later one is under review", () => {
  const printed = composeReview(
    { outcome: "reviewing", pullRequest: 41, wait: "clean", commit: "3f9c2e0", reviewing: "8d21a4f" },
    PATH,
  );

  assert.equal(printed.exit, 4);
  assert.equal(
    printed.stdout,
    `Full output: /work/squiz/.squiz/41/review.txt
Squiz found nothing open in PR #41 at 3f9c2e0, and is reviewing 8d21a4f before it closes the review. Run \`squiz review 41\` again to wait for it.
`,
  );
});

test("an episode already closed prints its close, exiting as the close did", () => {
  const printed = composeReview(
    { outcome: "closed", pullRequest: 41, exit: 0, rounds: 2, threads: [] },
    PATH,
  );

  assert.equal(printed.exit, 0);
  assert.equal(
    printed.stdout,
    `Full output: /work/squiz/.squiz/41/review.txt
Squiz's review of PR #41 closed after 2 rounds, with nothing open. No round runs again in this worktree.
`,
  );
});

test("an episode closed after one round, with threads open, counts both in the words they need", () => {
  const one = composeReview(
    { outcome: "closed", pullRequest: 41, exit: 3, rounds: 1, threads: [skewThread] },
    PATH,
  );
  const two = composeReview(
    { outcome: "closed", pullRequest: 41, exit: 3, rounds: 3, threads: [backoffThread, skewThread] },
    PATH,
  );

  assert.equal(one.exit, 3);
  assert.ok(
    one.stdout.startsWith(`Full output: /work/squiz/.squiz/41/review.txt
Squiz's review of PR #41 closed after 1 round, with 1 thread open. No round runs again in this worktree.

PRRT_kwDOL7tYbc5abcd2 packages/sync/src/session.ts:57 medium — Clock skew is read as token expiry
`),
    one.stdout,
  );
  assert.match(two.stdout, /closed after 3 rounds, with 2 threads open\./u);
});

test("a state the close left unreviewed adds the line saying why", () => {
  const atCap = composeReview(
    reviewed({ exit: 3, commit: "3f9c2e0", round: 3, threads: [skewThread], notReviewed: { state: "8d21a4f" } }),
    PATH,
  );
  const clean = composeReview(
    reviewed({
      exit: 0,
      commit: "3f9c2e0",
      round: 3,
      notReviewed: { state: "8d21a4f", closedAt: "round cap" },
    }),
    PATH,
  );

  const line =
    "Squiz did not review PR #41 at 8d21a4f: the episode closed at the round cap, after reviewing 3f9c2e0.";
  for (const printed of [atCap, clean]) {
    assert.equal(printed.stdout.split("\n")[2], line, printed.stdout);
  }
});

test("a state the close left unreviewed is printed as it was named, its different replies included", () => {
  const printed = composeReview(
    reviewed({
      exit: 0,
      commit: "3f9c2e0",
      round: 3,
      notReviewed: { state: "3f9c2e0 with different replies", closedAt: "round cap" },
    }),
    PATH,
  );
  assert.equal(
    printed.stdout.split("\n")[2],
    "Squiz did not review PR #41 at 3f9c2e0 with different replies: the episode closed at the round cap, after reviewing 3f9c2e0.",
    printed.stdout,
  );
});

test("exit 1 for a failed round prints nothing on stdout, and on stderr its reason, each item, and where the comment went", () => {
  const printed = composeReview(
    {
      outcome: "failed",
      pullRequest: 41,
      reason: "the reviewer was stopped at the time bound of 900 seconds, after reporting 2 findings",
      items: [`\`HEAD\` moved while the reviewer ran: ${MOVED}`],
      comment: { posted: true },
    },
    PATH,
  );

  assert.equal(printed.exit, 1);
  assert.equal(printed.stdout, "");
  assert.equal(
    printed.stderr,
    `squiz: review failed: the reviewer was stopped at the time bound of 900 seconds, after reporting 2 findings
squiz: \`HEAD\` moved while the reviewer ran: from a detached HEAD at 3f9c2e07b1d4a8c6e5f0923b7a1d6c4e8b2f5a90 to a detached HEAD at 8d21a4f6c3b9e0d7a5f2c8b1e4d9a6c3f7b0e258
squiz: the failure is posted on PR #41
`,
  );
});

test("exit 1 for a failed round whose comment could not be posted says why in its last line", () => {
  const printed = composeReview(
    {
      outcome: "failed",
      pullRequest: 142,
      reason: "the reviewer's output could not be read",
      items: [],
      comment: { posted: false, reason: "GitHub answered 502" },
    },
    PATH,
  );

  assert.equal(printed.stdout, "");
  assert.equal(
    printed.stderr,
    `squiz: review failed: the reviewer's output could not be read
squiz: the failure could not be posted on PR #142: GitHub answered 502
`,
  );
});

test("exit 1 for a failed round with no comment named prints its reason and its items alone", () => {
  const printed = composeReview(
    {
      outcome: "failed",
      pullRequest: 41,
      reason: "the round host 4242 for PR #41 stopped before its round ended",
      items: [],
    },
    PATH,
  );

  assert.equal(printed.stderr, "squiz: review failed: the round host 4242 for PR #41 stopped before its round ended\n");
});

test("exit 1 before any round, or with findings it could not post, prints one line", () => {
  const notRun = composeReview(
    {
      outcome: "not run",
      pullRequest: 41,
      reason: 'PR #41\'s head is "feature-a", and "/work/squiz" has "main" checked out',
    },
    PATH,
  );
  const closed = composeReview(
    { outcome: "not run", pullRequest: 41, reason: "PR #41 is closed" },
    PATH,
  );
  const unposted = composeReview({ outcome: "unposted", pullRequest: 41, round: 2, findings: 3 }, PATH);
  const unpostedOne = composeReview({ outcome: "unposted", pullRequest: 41, round: 1, findings: 1 }, PATH);

  for (const printed of [notRun, closed, unposted, unpostedOne]) {
    assert.equal(printed.exit, 1);
    assert.equal(printed.stdout, "");
  }
  assert.equal(
    notRun.stderr,
    'squiz: no review ran: PR #41\'s head is "feature-a", and "/work/squiz" has "main" checked out\n',
  );
  assert.equal(closed.stderr, "squiz: no review ran: PR #41 is closed\n");
  assert.equal(unposted.stderr, "squiz: round 2 found 3 findings and could not post them to PR #41\n");
  assert.equal(unpostedOne.stderr, "squiz: round 1 found 1 finding and could not post it to PR #41\n");
});

test("a failure that leaves the outcome standing is a stderr line, and the outcome keeps its status", () => {
  const printed = composeReview(
    reviewed({
      exit: 0,
      problems: ["the review of PR #41 closed without its summary: GitHub answered 502"],
    }),
    PATH,
  );

  assert.equal(printed.exit, 0);
  assert.match(printed.stdout, /^Nothing is open\./mu);
  assert.equal(
    printed.stderr,
    "squiz: the review of PR #41 closed without its summary: GitHub answered 502\n",
  );
});

test("review.txt holds exactly what was printed on stdout, path line included, and is replaced on every run", async () => {
  const worktree = await mkdtemp(join(tmpdir(), "squiz-review-output-"));
  try {
    const path = join(worktree, ".squiz", "41", "review.txt");
    const first = printReview(
      reviewed({ exit: 2, newFindings: 2, threads: [backoffThread, skewThread] }),
      worktree,
    );
    assert.equal(first.stdout.split("\n")[0], `Full output: ${path}`);
    assert.equal(await readFile(path, "utf8"), first.stdout, "the file drifted from stdout");

    const second = printReview(
      { outcome: "reviewing", pullRequest: 41, wait: "under review", commit: "8d21a4f" },
      worktree,
    );
    assert.equal(await readFile(path, "utf8"), second.stdout, "the file kept an earlier run's output");
    assert.equal(second.stderr, "");
  } finally {
    await rm(worktree, { recursive: true, force: true });
  }
});

test("exit 1 writes no review.txt", async () => {
  const worktree = await mkdtemp(join(tmpdir(), "squiz-review-output-"));
  try {
    printReview({ outcome: "not run", pullRequest: 41, reason: "PR #41 is closed" }, worktree);
    await assert.rejects(readFile(join(worktree, ".squiz", "41", "review.txt")), { code: "ENOENT" });
  } finally {
    await rm(worktree, { recursive: true, force: true });
  }
});

test("a review.txt that cannot be written is a stderr line, and changes neither stdout nor the status", async () => {
  const worktree = await mkdtemp(join(tmpdir(), "squiz-review-output-"));
  try {
    // A file where the directory must go is a write that fails on any platform.
    await writeFile(join(worktree, ".squiz"), "");
    const result = reviewed({ exit: 3, threads: [skewThread] });

    const printed = printReview(result, worktree);

    assert.equal(printed.exit, 3);
    assert.equal(printed.stdout, composeReview(result, reviewOutputPath(worktree, 41)).stdout);
    assert.match(
      printed.stderr,
      new RegExp(`^squiz: the output could not be written to ${escaped(join(worktree, ".squiz", "41", "review.txt"))}: .+\n$`, "u"),
    );
  } finally {
    await rm(worktree, { recursive: true, force: true });
  }
});

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
