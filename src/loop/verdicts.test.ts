import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ThreadVerdict } from "../reviewers/adapter.ts";
import { applyVerdicts, type HandedOverThread } from "./verdicts.ts";

/** One answer of the fake `gh`, given to any request whose body holds `when`. */
type Rule = { readonly when: string; readonly answer: string };

/** What the fake `gh` recorded of how it was called. */
type Fake = {
  /** The JSON body of each invocation, one entry per invocation, in order. */
  readonly requests: () => readonly string[];
};

/**
 * Run `body` with a `gh` on `PATH` that answers each request by the first rule
 * its body matches, and records every request it was sent.
 *
 * A fake binary rather than an injected runner: the harness reaches GitHub by
 * spawning `gh`, and which thread got which mutation is what these tests are
 * about. A request no rule matches gets a `gh` that exits 1, so a test whose
 * fixture does not cover a call fails on that call rather than on a mutation
 * standing in for another.
 */
async function withFakeGh<T>(
  rules: readonly Rule[],
  body: (gh: Fake) => Promise<T> | T,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "squiz-verdicts-"));
  const requestLog = join(directory, "requests");
  const script = [
    "#!/bin/sh",
    "request=$(cat)",
    // One line per invocation: the request is JSON, which carries no newline.
    `printf '%s\\n' "$request" >> ${quote(requestLog)}`,
    'case "$request" in',
    ...rules.map((rule) => `  *${quote(rule.when)}*) printf '%s' ${quote(rule.answer)}; exit 0 ;;`),
    "esac",
    "exit 1",
    "",
  ].join("\n");

  const previous = process.env["PATH"];
  try {
    await writeFile(join(directory, "gh"), script, "utf8");
    await chmod(join(directory, "gh"), 0o755);
    process.env["PATH"] = `${directory}:${previous ?? ""}`;
    return await body({ requests: () => lines(requestLog) });
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

/** The whole answer to an id GitHub does not know: a `NOT_FOUND` inside an HTTP 200. */
function notFound(id: string): string {
  return included(
    "200 OK",
    JSON.stringify({
      data: null,
      errors: [
        {
          type: "NOT_FOUND",
          message: `Could not resolve to PullRequestReviewThread node with the global id of '${id}'.`,
        },
      ],
    }),
  );
}

/**
 * A GitHub that does what either mutation asks.
 *
 * The re-open rule comes first because `unresolveReviewThread` holds the other
 * mutation's name inside its own, so the resolve rule matches both.
 */
const healthy: readonly Rule[] = [
  { when: "unresolveReviewThread", answer: reported("unresolveReviewThread", false) },
  { when: "resolveReviewThread", answer: reported("resolveReviewThread", true) },
];

/** A GitHub that refuses every mutation naming `thread`, and serves the rest. */
function refusing(thread: string): readonly Rule[] {
  return [{ when: thread, answer: notFound(thread) }, ...healthy];
}

const anywhere = { directory: tmpdir() };

function open(id: string): HandedOverThread {
  return { id, isResolved: false };
}

function closed(id: string): HandedOverThread {
  return { id, isResolved: true };
}

/** One mutation the fake `gh` was sent: which thread, and which of the two. */
type Sent = { readonly thread: string; readonly mutation: "close" | "reopen" };

/** Every mutation `gh` was sent, in order, read back out of its log. */
function sent(gh: Fake): readonly Sent[] {
  return gh.requests().map((line) => {
    const request = JSON.parse(line) as { query: string; variables: { threadId: string } };
    return {
      thread: request.variables.threadId,
      // `unresolveReviewThread` holds the other name, so it is tested first.
      mutation: request.query.includes("unresolveReviewThread") ? "reopen" : "close",
    };
  });
}

test("fixed and withdrawn close the thread each names", async () => {
  await withFakeGh(healthy, (gh) => {
    const applied = applyVerdicts(
      [open("PRRT_one"), open("PRRT_two")],
      [
        { thread: "PRRT_one", verdict: "fixed" },
        { thread: "PRRT_two", verdict: "withdrawn" },
      ],
      anywhere,
    );

    assert.deepEqual(applied.threads, [
      { thread: "PRRT_one", ruled: "fixed", outcome: "closed" },
      { thread: "PRRT_two", ruled: "withdrawn", outcome: "closed" },
    ]);
    assert.deepEqual(sent(gh), [
      { thread: "PRRT_one", mutation: "close" },
      { thread: "PRRT_two", mutation: "close" },
    ]);
    assert.equal(applied.reopened, 0);
  });
});

test("open re-opens a thread that was closed and counts it as re-opened", async () => {
  await withFakeGh(healthy, (gh) => {
    const applied = applyVerdicts(
      [closed("PRRT_reopen"), open("PRRT_close")],
      [
        { thread: "PRRT_reopen", verdict: "open" },
        { thread: "PRRT_close", verdict: "fixed" },
      ],
      anywhere,
    );

    assert.deepEqual(applied.threads, [
      { thread: "PRRT_reopen", ruled: "open", outcome: "reopened" },
      { thread: "PRRT_close", ruled: "fixed", outcome: "closed" },
    ]);
    assert.deepEqual(sent(gh), [
      { thread: "PRRT_reopen", mutation: "reopen" },
      { thread: "PRRT_close", mutation: "close" },
    ]);
    assert.equal(applied.reopened, 1, "only the thread that was closed and is open again counts");
  });
});

test("open leaves a thread that is already open alone", async () => {
  await withFakeGh(healthy, (gh) => {
    const applied = applyVerdicts(
      [open("PRRT_still")],
      [{ thread: "PRRT_still", verdict: "open" }],
      anywhere,
    );

    assert.deepEqual(applied.threads, [
      { thread: "PRRT_still", ruled: "open", outcome: "left-open" },
    ]);
    assert.deepEqual(sent(gh), [], "a thread in the state the verdict asks for takes no mutation");
    assert.equal(applied.reopened, 0, "a thread that was never closed was not re-opened");
  });
});

test("a thread the reviewer returned no verdict for takes the path an open verdict takes", async () => {
  // The case that decides what becomes of a thread the reviewer forgot. Both
  // halves are asserted against a thread it did rule open rather than against
  // the word `open`, so the default is read from the findings module and not
  // written here a second time.
  await withFakeGh(healthy, (gh) => {
    const applied = applyVerdicts(
      [closed("PRRT_forgotten"), closed("PRRT_ruled"), open("PRRT_untouched")],
      [{ thread: "PRRT_ruled", verdict: "open" }],
      anywhere,
    );

    const [forgotten, ruled, untouched] = applied.threads;
    assert.deepEqual(forgotten, {
      thread: "PRRT_forgotten",
      ruled: null,
      outcome: ruled?.outcome,
    });
    assert.deepEqual(untouched, { thread: "PRRT_untouched", ruled: null, outcome: "left-open" });
    assert.deepEqual(
      sent(gh),
      [
        { thread: "PRRT_forgotten", mutation: "reopen" },
        { thread: "PRRT_ruled", mutation: "reopen" },
      ],
      "a thread nobody ruled on must not be closed by the forgetting",
    );
  });
});

test("a verdict reaches the thread it names and not the one in its place", async () => {
  // The verdicts arrive in an order of their own, and each names a thread whose
  // neighbour is ruled the other way. Applied by position, every one of the
  // three lands on the wrong thread.
  await withFakeGh(healthy, (gh) => {
    const handedOver = [open("PRRT_first"), closed("PRRT_second"), open("PRRT_third")];
    const verdicts: readonly ThreadVerdict[] = [
      { thread: "PRRT_third", verdict: "fixed" },
      { thread: "PRRT_first", verdict: "open" },
      { thread: "PRRT_second", verdict: "open" },
    ];

    const applied = applyVerdicts(handedOver, verdicts, anywhere);

    assert.deepEqual(applied.threads, [
      { thread: "PRRT_first", ruled: "open", outcome: "left-open" },
      { thread: "PRRT_second", ruled: "open", outcome: "reopened" },
      { thread: "PRRT_third", ruled: "fixed", outcome: "closed" },
    ]);
    assert.deepEqual(sent(gh), [
      { thread: "PRRT_second", mutation: "reopen" },
      { thread: "PRRT_third", mutation: "close" },
    ]);
  });
});

test("a verdict naming a thread that was not handed over is reported, not applied", async () => {
  await withFakeGh(healthy, (gh) => {
    const applied = applyVerdicts(
      [open("PRRT_handed")],
      [
        { thread: "PRRT_handed", verdict: "fixed" },
        { thread: "PRRT_invented", verdict: "fixed" },
      ],
      anywhere,
    );

    assert.deepEqual(applied.threads, [
      { thread: "PRRT_handed", ruled: "fixed", outcome: "closed" },
    ]);
    assert.equal(applied.unapplied.length, 1);
    assert.deepEqual(applied.unapplied[0]?.thread, "PRRT_invented");
    assert.match(applied.unapplied[0]?.reason ?? "", /was handed to the reviewer/u);
    assert.deepEqual(
      sent(gh),
      [{ thread: "PRRT_handed", mutation: "close" }],
      "nothing is resolved on an identifier the round did not send",
    );
  });
});

test("a thread ruled twice takes the first ruling, and the second is reported", async () => {
  await withFakeGh(healthy, (gh) => {
    const applied = applyVerdicts(
      [open("PRRT_twice")],
      [
        { thread: "PRRT_twice", verdict: "open" },
        { thread: "PRRT_twice", verdict: "fixed" },
      ],
      anywhere,
    );

    assert.deepEqual(applied.threads, [
      { thread: "PRRT_twice", ruled: "open", outcome: "left-open" },
    ]);
    assert.deepEqual(applied.unapplied[0]?.verdict, "fixed");
    assert.deepEqual(sent(gh), [], "the later ruling must not decide the thread");
  });
});

test("a thread already closed and ruled fixed is closed again rather than assumed closed", async () => {
  // The resolved state was read before the coding agent's turn, and the
  // mutation's report is the round's only evidence the thread is closed.
  await withFakeGh(healthy, (gh) => {
    const applied = applyVerdicts(
      [closed("PRRT_already")],
      [{ thread: "PRRT_already", verdict: "fixed" }],
      anywhere,
    );

    assert.deepEqual(applied.threads, [
      { thread: "PRRT_already", ruled: "fixed", outcome: "closed" },
    ]);
    assert.deepEqual(sent(gh), [{ thread: "PRRT_already", mutation: "close" }]);
  });
});

test("a resolve GitHub refused inside an HTTP 200 is not read as a thread closed", async () => {
  // The failure this file exists to catch. GitHub answers 200 with the refusal
  // in the `errors` array, and a round reading the status reports a thread
  // closed that is still open.
  await withFakeGh(refusing("PRRT_refused"), () => {
    const applied = applyVerdicts(
      [open("PRRT_refused"), open("PRRT_fine")],
      [
        { thread: "PRRT_refused", verdict: "fixed" },
        { thread: "PRRT_fine", verdict: "withdrawn" },
      ],
      anywhere,
    );

    const refused = applied.threads[0];
    assert.equal(refused?.outcome, "failed");
    assert.match(
      refused?.outcome === "failed" ? refused.reason : "",
      /Could not resolve to PullRequestReviewThread node/u,
    );
    assert.deepEqual(
      applied.threads[1],
      { thread: "PRRT_fine", ruled: "withdrawn", outcome: "closed" },
      "one thread GitHub refused must not stop the others being applied",
    );
  });
});

test("a re-open GitHub refused is not counted as a thread re-opened", async () => {
  await withFakeGh(refusing("PRRT_refused"), () => {
    const applied = applyVerdicts(
      [closed("PRRT_refused")],
      [{ thread: "PRRT_refused", verdict: "open" }],
      anywhere,
    );

    assert.equal(applied.threads[0]?.outcome, "failed");
    assert.equal(applied.reopened, 0);
  });
});

test("a mutation that answered without doing the work is a failure", async () => {
  // A resolve reporting the thread still open. Read as a success it would have
  // the round report a finding settled that nobody has addressed.
  const lying: readonly Rule[] = [
    { when: "resolveReviewThread", answer: reported("resolveReviewThread", false) },
  ];
  await withFakeGh(lying, () => {
    const applied = applyVerdicts(
      [open("PRRT_lied")],
      [{ thread: "PRRT_lied", verdict: "fixed" }],
      anywhere,
    );

    assert.equal(applied.threads[0]?.outcome, "failed");
  });
});

test("a gh that is not installed fails every thread and throws nothing", async () => {
  await withNoGh(() => {
    const applied = applyVerdicts(
      [open("PRRT_one"), closed("PRRT_two"), open("PRRT_three")],
      [
        { thread: "PRRT_one", verdict: "fixed" },
        { thread: "PRRT_two", verdict: "open" },
        { thread: "PRRT_three", verdict: "open" },
      ],
      anywhere,
    );

    assert.deepEqual(
      applied.threads.map((thread) => thread.outcome),
      // The third asked for nothing, so there was no call for gh to fail.
      ["failed", "failed", "left-open"],
    );
    assert.equal(applied.reopened, 0);
  });
});

test("no thread handed over is no work and no failure", async () => {
  await withFakeGh(healthy, (gh) => {
    const applied = applyVerdicts([], [], anywhere);

    assert.deepEqual(applied, { threads: [], unapplied: [], reopened: 0 });
    assert.deepEqual(sent(gh), []);
  });
});
