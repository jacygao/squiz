import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { renderOpenReason } from "../findings/comment.ts";
import type { ThreadVerdict } from "../reviewers/adapter.ts";
import { standIn } from "../testing/stand-in.ts";
import { applyVerdicts, unappliedRulings, type HandedOverThread } from "./verdicts.ts";

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
    standIn(directory, "gh", script);
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
  {
    when: "addPullRequestReviewThreadReply",
    answer: included(
      "200 OK",
      JSON.stringify({ data: { addPullRequestReviewThreadReply: { comment: { databaseId: 1 } } } }),
    ),
  },
  { when: "unresolveReviewThread", answer: reported("unresolveReviewThread", false) },
  { when: "resolveReviewThread", answer: reported("resolveReviewThread", true) },
];

/** A GitHub that refuses every mutation naming `thread`, and serves the rest. */
function refusing(thread: string): readonly Rule[] {
  return [{ when: thread, answer: notFound(thread) }, ...healthy];
}

const anywhere = { directory: tmpdir() };

// The round and commit every verdict here is ruled at, which a closing reply names.
const ruledAt = { round: 2, commit: "1b86987c4f0e2d6a9b3c5e7f8a1d2c3b4e5f6a7b" };

function open(id: string): HandedOverThread {
  return { id, isResolved: false };
}

function closed(id: string): HandedOverThread {
  return { id, isResolved: true };
}

/** One mutation the fake `gh` was sent: which thread, and which of the three. */
type Sent =
  | { readonly thread: string; readonly mutation: "close" | "reopen" }
  | { readonly thread: string; readonly mutation: "reply"; readonly body: string };

/** Every mutation `gh` was sent, in order, read back out of its log. */
function sent(gh: Fake): readonly Sent[] {
  return gh.requests().map((line): Sent => {
    const request = JSON.parse(line) as { query: string; variables: { threadId: string; body?: string } };
    const thread = request.variables.threadId;
    if (request.query.includes("addPullRequestReviewThreadReply")) {
      return { thread, mutation: "reply", body: request.variables.body ?? "" };
    }
    // `unresolveReviewThread` holds the other name, so it is tested first.
    return { thread, mutation: request.query.includes("unresolveReviewThread") ? "reopen" : "close" };
  });
}

/** The mutations `gh` was sent that set a thread's state, leaving out every reply. */
function stateChanges(gh: Fake): readonly Sent[] {
  return sent(gh).filter((each) => each.mutation !== "reply");
}

/** What a reply GitHub took comes back as. */
const acted = { outcome: "acted" } as const;

test("fixed and withdrawn close the thread each names", async () => {
  await withFakeGh(healthy, (gh) => {
    const applied = applyVerdicts(
      [open("PRRT_one"), open("PRRT_two")],
      [
        { thread: "PRRT_one", verdict: "fixed" },
        { thread: "PRRT_two", verdict: "withdrawn", reason: "The caller clamps first." },
      ],
      ruledAt,
      anywhere,
    );

    assert.deepEqual(applied.threads, [
      { thread: "PRRT_one", ruled: "fixed", outcome: "closed", reply: acted },
      { thread: "PRRT_two", ruled: "withdrawn", outcome: "closed", reply: acted },
    ]);
    assert.deepEqual(stateChanges(gh), [
      { thread: "PRRT_one", mutation: "close" },
      { thread: "PRRT_two", mutation: "close" },
    ]);
  });
});

test("a thread ruled closed is replied on before it is resolved, naming the round and the commit (#586)", async () => {
  await withFakeGh(healthy, (gh) => {
    applyVerdicts(
      [open("PRRT_fixed"), open("PRRT_withdrawn")],
      [
        { thread: "PRRT_fixed", verdict: "fixed" },
        { thread: "PRRT_withdrawn", verdict: "withdrawn", reason: "The caller clamps first." },
      ],
      ruledAt,
      anywhere,
    );

    assert.deepEqual(sent(gh), [
      {
        thread: "PRRT_fixed",
        mutation: "reply",
        body: "**Squiz reviewer · fixed**\n\nConfirmed in round 2 at 1b86987.",
      },
      { thread: "PRRT_fixed", mutation: "close" },
      {
        thread: "PRRT_withdrawn",
        mutation: "reply",
        body: "**Squiz reviewer · withdrawn**\n\nWithdrawn in round 2 at 1b86987.\n\nThe caller clamps first.",
      },
      { thread: "PRRT_withdrawn", mutation: "close" },
    ]);
  });
});

test("a closing reply from an attempt that was no round names the commit and no round (#586)", async () => {
  // A setup problem spends no round, so the next round takes the number it would have named.
  await withFakeGh(healthy, (gh) => {
    applyVerdicts(
      [open("PRRT_fixed")],
      [{ thread: "PRRT_fixed", verdict: "fixed" }],
      { round: null, commit: ruledAt.commit },
      anywhere,
    );

    assert.deepEqual(sent(gh)[0], {
      thread: "PRRT_fixed",
      mutation: "reply",
      body: "**Squiz reviewer · fixed**\n\nConfirmed at 1b86987.",
    });
  });
});

test("a closing reply GitHub refuses still closes the thread, and the verdict stands (#586)", async () => {
  const refusingReplies: readonly Rule[] = [
    { when: "addPullRequestReviewThreadReply", answer: notFound("PRRT_refused") },
    ...healthy,
  ];
  await withFakeGh(refusingReplies, (gh) => {
    const applied = applyVerdicts(
      [open("PRRT_refused")],
      [{ thread: "PRRT_refused", verdict: "withdrawn", reason: "The caller clamps first." }],
      ruledAt,
      anywhere,
    );

    const [thread] = applied.threads;
    assert.equal(thread?.ruled, "withdrawn");
    assert.equal(thread?.outcome, "closed", "a reply that failed stopped the resolve");
    assert.equal(thread?.reply?.outcome, "failed");
    assert.deepEqual(
      sent(gh).map((each) => each.mutation),
      ["reply", "close"],
    );
  });
});

test("open re-opens a thread that was closed and counts it as re-opened", async () => {
  await withFakeGh(healthy, (gh) => {
    const applied = applyVerdicts(
      [closed("PRRT_reopen"), open("PRRT_close")],
      [
        { thread: "PRRT_reopen", verdict: "open", reason: "Still wrong." },
        { thread: "PRRT_close", verdict: "fixed" },
      ],
      ruledAt,
      anywhere,
    );

    assert.deepEqual(applied.threads, [
      { thread: "PRRT_reopen", ruled: "open", outcome: "reopened", reply: acted },
      { thread: "PRRT_close", ruled: "fixed", outcome: "closed", reply: acted },
    ]);
    assert.deepEqual(stateChanges(gh), [
      { thread: "PRRT_reopen", mutation: "reopen" },
      { thread: "PRRT_close", mutation: "close" },
    ]);
  });
});

test("open leaves a thread that is already open alone", async () => {
  await withFakeGh(healthy, (gh) => {
    const applied = applyVerdicts(
      [open("PRRT_still")],
      [{ thread: "PRRT_still", verdict: "open", reason: "Still wrong." }],
      ruledAt,
      anywhere,
    );

    assert.deepEqual(applied.threads, [
      { thread: "PRRT_still", ruled: "open", outcome: "left-open", reply: acted },
    ]);
    assert.deepEqual(stateChanges(gh), [], "a thread in the state the verdict asks for takes no mutation");
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
      [{ thread: "PRRT_ruled", verdict: "open", reason: "Still wrong." }],
      ruledAt,
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
      stateChanges(gh),
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
      { thread: "PRRT_first", verdict: "open", reason: "Still wrong." },
      { thread: "PRRT_second", verdict: "open", reason: "Still wrong." },
    ];

    const applied = applyVerdicts(handedOver, verdicts, ruledAt, anywhere);

    assert.deepEqual(applied.threads, [
      { thread: "PRRT_first", ruled: "open", outcome: "left-open", reply: acted },
      { thread: "PRRT_second", ruled: "open", outcome: "reopened", reply: acted },
      { thread: "PRRT_third", ruled: "fixed", outcome: "closed", reply: acted },
    ]);
    assert.deepEqual(stateChanges(gh), [
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
      ruledAt,
      anywhere,
    );

    assert.deepEqual(applied.threads, [
      { thread: "PRRT_handed", ruled: "fixed", outcome: "closed", reply: acted },
    ]);
    assert.equal(applied.unapplied.length, 1);
    assert.deepEqual(applied.unapplied[0]?.thread, "PRRT_invented");
    assert.match(applied.unapplied[0]?.reason ?? "", /was handed to the reviewer/u);
    assert.deepEqual(
      sent(gh).map((each) => each.thread),
      ["PRRT_handed", "PRRT_handed"],
      "nothing is sent on an identifier the round did not hand over",
    );
  });
});

test("a thread ruled twice takes the first ruling, and the second is reported", async () => {
  await withFakeGh(healthy, (gh) => {
    const applied = applyVerdicts(
      [open("PRRT_twice")],
      [
        { thread: "PRRT_twice", verdict: "open", reason: "Still wrong." },
        { thread: "PRRT_twice", verdict: "fixed" },
      ],
      ruledAt,
      anywhere,
    );

    assert.deepEqual(applied.threads, [
      { thread: "PRRT_twice", ruled: "open", outcome: "left-open", reply: acted },
    ]);
    assert.deepEqual(applied.unapplied[0]?.verdict, "fixed");
    assert.deepEqual(stateChanges(gh), [], "the later ruling must not decide the thread");
  });
});

test("a thread already closed and ruled fixed is closed again, with no reply, rather than assumed closed", async () => {
  // The resolved state was read before the coding agent's turn, and the
  // mutation's report is the round's only evidence the thread is closed.
  await withFakeGh(healthy, (gh) => {
    const applied = applyVerdicts(
      [closed("PRRT_already")],
      [{ thread: "PRRT_already", verdict: "fixed" }],
      ruledAt,
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
        { thread: "PRRT_fine", verdict: "withdrawn", reason: "The caller clamps first." },
      ],
      ruledAt,
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
      { thread: "PRRT_fine", ruled: "withdrawn", outcome: "closed", reply: acted },
      "one thread GitHub refused must not stop the others being applied",
    );
  });
});

test("a re-open GitHub refused is not counted as a thread re-opened", async () => {
  await withFakeGh(refusing("PRRT_refused"), () => {
    const applied = applyVerdicts(
      [closed("PRRT_refused")],
      [{ thread: "PRRT_refused", verdict: "open", reason: "Still wrong." }],
      ruledAt,
      anywhere,
    );

    assert.equal(applied.threads[0]?.outcome, "failed");
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
      ruledAt,
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
        { thread: "PRRT_two", verdict: "open", reason: "Still wrong." },
        { thread: "PRRT_three", verdict: "open", reason: "Still wrong." },
      ],
      ruledAt,
      anywhere,
    );

    assert.deepEqual(
      applied.threads.map((thread) => thread.outcome),
      // The third asked for nothing, so there was no call for gh to fail.
      ["failed", "failed", "left-open"],
    );
  });
});

test("a thread kept open is replied on with the reviewer's reason, after it is re-opened (#511)", async () => {
  await withFakeGh(healthy, (gh) => {
    const applied = applyVerdicts(
      [open("PRRT_open"), closed("PRRT_closed")],
      [
        { thread: "PRRT_open", verdict: "open", reason: "The clamp still runs first." },
        { thread: "PRRT_closed", verdict: "open", reason: "Nothing measures the card." },
      ],
      ruledAt,
      anywhere,
    );

    assert.deepEqual(applied.threads, [
      { thread: "PRRT_open", ruled: "open", outcome: "left-open", reply: { outcome: "acted" } },
      { thread: "PRRT_closed", ruled: "open", outcome: "reopened", reply: { outcome: "acted" } },
    ]);
    assert.deepEqual(sent(gh), [
      { thread: "PRRT_open", mutation: "reply", body: renderOpenReason("The clamp still runs first.") },
      { thread: "PRRT_closed", mutation: "reopen" },
      { thread: "PRRT_closed", mutation: "reply", body: renderOpenReason("Nothing measures the card.") },
    ]);
  });
});

test("a thread closed before the round, or passed over, is not replied on (#586)", async () => {
  // A closed thread is handed over every round, and a round that confirmed it
  // again would post the same reply on it every round.
  await withFakeGh(healthy, (gh) => {
    const applied = applyVerdicts(
      [closed("PRRT_fixed"), closed("PRRT_withdrawn"), open("PRRT_forgotten")],
      [
        { thread: "PRRT_fixed", verdict: "fixed" },
        { thread: "PRRT_withdrawn", verdict: "withdrawn", reason: "The caller clamps first." },
      ],
      ruledAt,
      anywhere,
    );

    assert.deepEqual(
      applied.threads.map((thread) => thread.reply),
      [undefined, undefined, undefined],
    );
    assert.deepEqual(
      sent(gh).map((each) => each.mutation),
      ["close", "close"],
      "the default open is no ruling, and has no reason to post",
    );
  });
});

test("a reason ruled on a thread that was not handed over, or ruled twice, is not posted", async () => {
  await withFakeGh(healthy, (gh) => {
    applyVerdicts(
      [open("PRRT_handed")],
      [
        { thread: "PRRT_handed", verdict: "fixed" },
        { thread: "PRRT_handed", verdict: "open", reason: "Second thoughts." },
        { thread: "PRRT_invented", verdict: "open", reason: "Somewhere else." },
      ],
      ruledAt,
      anywhere,
    );

    assert.deepEqual(
      sent(gh).map((each) => [each.thread, each.mutation]),
      [
        ["PRRT_handed", "reply"],
        ["PRRT_handed", "close"],
      ],
    );
  });
});

test("a reason GitHub refuses leaves the verdict standing, and says why", async () => {
  const refusingReplies: readonly Rule[] = [
    { when: "addPullRequestReviewThreadReply", answer: notFound("PRRT_refused") },
    ...healthy,
  ];
  await withFakeGh(refusingReplies, () => {
    const applied = applyVerdicts(
      [closed("PRRT_refused")],
      [{ thread: "PRRT_refused", verdict: "open", reason: "Still wrong." }],
      ruledAt,
      anywhere,
    );

    const [thread] = applied.threads;
    assert.equal(thread?.outcome, "reopened", "a reply that failed undid the verdict");
    assert.equal(thread?.reply?.outcome, "failed");
    assert.match(
      thread?.reply?.outcome === "failed" ? thread.reply.reason : "",
      /Could not resolve to PullRequestReviewThread node/u,
    );
  });
});

test("no thread handed over is no work and no failure", async () => {
  await withFakeGh(healthy, (gh) => {
    const applied = applyVerdicts([], [], ruledAt, anywhere);

    assert.deepEqual(applied, { threads: [], unapplied: [] });
    assert.deepEqual(sent(gh), []);
  });
});

test("each ruling that could not be applied is named with its thread, the ruling and why (#605)", () => {
  const lines = unappliedRulings({
    threads: [
      { thread: "PRRT_resolved", ruled: "fixed", outcome: "closed" },
      { thread: "PRRT_fixed", ruled: "fixed", outcome: "failed", reason: "GitHub answered 502" },
      { thread: "PRRT_withdrawn", ruled: "withdrawn", outcome: "failed", reason: "GitHub answered 502" },
      { thread: "PRRT_open", ruled: "open", outcome: "failed", reason: "GitHub answered 403" },
      { thread: "PRRT_silent", ruled: null, outcome: "failed", reason: "GitHub answered 403" },
    ],
    unapplied: [
      { thread: "PRRT_invented", verdict: "fixed", reason: "no thread with that id was handed to the reviewer" },
    ],
  });

  assert.deepEqual(lines, [
    "the reviewer ruled thread PRRT_fixed fixed, and it could not be resolved: GitHub answered 502",
    "the reviewer ruled thread PRRT_withdrawn withdrawn, and it could not be resolved: GitHub answered 502",
    "the reviewer ruled thread PRRT_open open, and it could not be re-opened: GitHub answered 403",
    "the reviewer gave thread PRRT_silent no ruling, which keeps it open, and it could not be re-opened: GitHub answered 403",
    "the reviewer ruled thread PRRT_invented fixed, and the ruling was not applied: no thread with that id was handed to the reviewer",
  ]);
});
