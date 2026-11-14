import assert from "node:assert/strict";
import { test } from "node:test";

import type { ReviewThread } from "../venues/venue.ts";
import { followUpFor } from "../venues/github/venue.ts";
import type { Owner, StateRecord } from "../loop/state-record.ts";
import { ownerNote } from "./owner-note.ts";

const HEAD = "3f9c2e07b1d4a8c6e5f0923b7a1d6c4e8b2f5a90";
const OWNER: Owner = { sessionId: "60517e1f-e1dc-49b1-8e39-6fcbe686f3fb" };
const PR_41 = { key: "41", name: "PR #41", rerun: "squiz review 41" };
const WORKING_TREE = { key: "local", name: "the working tree", rerun: "(cd '/work/squiz-a' && squiz review)" };

function reviewed(exitStatus: 2 | 3, openThreads: readonly string[]): StateRecord {
  return {
    head: HEAD,
    activity: null,
    owner: OWNER,
    status: "reviewed",
    result: "exited",
    exitStatus,
    openThreads,
    round: { number: 1, startedAt: 1, endedAt: 2, reviewer: { backend: "detached" } },
    newFindings: openThreads.length,
  };
}

function thread(id: string, line: number, headline: string, isResolved = false): ReviewThread {
  return {
    id,
    isResolved,
    isOutdated: false,
    path: "src/sync/queue.ts",
    anchor: { at: "line", line },
    comments: [
      {
        id: `PRRC_${id}`,
        databaseId: 1,
        author: "squiz",
        body: `**Squiz reviewer · high — ${headline}**\n\n- It is reached on every enqueue.\n\n**Suggested fix:** Reset it once.`,
        createdAt: "2026-10-05T07:13:05Z",
      },
    ],
  };
}

function textOf(note: ReturnType<typeof ownerNote>): string {
  assert.ok(note !== undefined, "no note was written");
  return note.fields["text"] ?? "";
}

test("a note for open threads carries each one as squiz review prints it, and what to do with them", () => {
  const threads = [thread("PRRT_a", 134, "Retry backoff resets"), thread("PRRT_b", 57, "Clock skew is read as expiry")];

  const text = textOf(ownerNote(PR_41, reviewed(2, ["PRRT_a", "PRRT_b"]), "3f9c2e0", followUpFor(41, "/work/squiz"), undefined, threads));

  assert.equal(
    text,
    [
      "Squiz reviewed PR #41 at 3f9c2e0: 2 threads are open:",
      "",
      "PRRT_a src/sync/queue.ts:134 high — Retry backoff resets",
      "  - It is reached on every enqueue.",
      "",
      "  **Suggested fix:** Reset it once.",
      "",
      "PRRT_b src/sync/queue.ts:57 high — Clock skew is read as expiry",
      "  - It is reached on every enqueue.",
      "",
      "  **Suggested fix:** Reset it once.",
      "",
      "Fix what applies in /work/squiz, and reply on each thread with",
      "`(cd '/work/squiz' && squiz reply <id> <text>)` to say what you changed or why",
      "you disagree. Commit and push what you changed, then run `squiz review 41` again.",
    ].join("\n"),
  );
});

test("a note for open threads ends with the follow-up it was handed, which the change carries", () => {
  const threads = [thread("PRRT_a", 134, "Retry backoff resets")];
  const followUp = "Fix what applies in /work/squiz-a, then run `(cd '/work/squiz-a' && squiz review)` again.";

  const text = textOf(ownerNote(PR_41, reviewed(2, ["PRRT_a"]), "3f9c2e0", followUp, undefined, threads));

  assert.ok(text.endsWith(`\n\n${followUp}`), `the note does not end with the change's follow-up:\n${text}`);
});

test("a note carries only the threads the round left open that are still open, and none another reviewer's", () => {
  const threads = [
    thread("PRRT_person", 1, "Not the reviewer's"),
    thread("PRRT_a", 134, "Retry backoff resets"),
    thread("PRRT_since", 9, "Resolved since the round", true),
  ];

  const text = textOf(ownerNote(PR_41, reviewed(2, ["PRRT_a", "PRRT_since"]), "3f9c2e0", followUpFor(41, "/work/squiz"), undefined, threads));

  assert.match(text, /^Squiz reviewed PR #41 at 3f9c2e0: 1 thread is open:\n\nPRRT_a /u);
  assert.doesNotMatch(text, /PRRT_person|PRRT_since/u);
});

test("a note for more than 10 open threads carries the first 10, and ends saying how many more and how to print them", () => {
  const ids = Array.from({ length: 12 }, (_, index) => `PRRT_${index + 1}`);
  const threads = ids.map((id, index) => thread(id, index + 1, `Finding ${index + 1}`));

  const text = textOf(ownerNote(PR_41, reviewed(2, ids), "3f9c2e0", followUpFor(41, "/work/squiz"), undefined, threads));

  assert.match(text, /^Squiz reviewed PR #41 at 3f9c2e0: 12 threads are open:\n/u);
  assert.match(text, /PRRT_10 src/u);
  assert.doesNotMatch(text, /PRRT_11|PRRT_12/u);
  assert.ok(
    text.endsWith("\n\n2 more threads are open. `squiz review 41` prints them all."),
    `the note does not end with the count of the rest:\n${text}`,
  );
});

test("a note for a review closed with threads open says it closed, and carries the threads left for a person", () => {
  const threads = [thread("PRRT_a", 134, "Retry backoff resets")];

  const text = textOf(ownerNote(PR_41, reviewed(3, ["PRRT_a"]), "3f9c2e0", followUpFor(41, "/work/squiz"), undefined, threads));

  assert.equal(
    text,
    [
      "Squiz reviewed PR #41 at 3f9c2e0: the episode has closed with 1 thread open:",
      "",
      "PRRT_a src/sync/queue.ts:134 high — Retry backoff resets",
      "  - It is reached on every enqueue.",
      "",
      "  **Suggested fix:** Reset it once.",
    ].join("\n"),
  );
});

test("a note whose listing holds none of the threads the round left open counts them and points to squiz review", () => {
  const listed = [thread("PRRT_person", 1, "Not the reviewer's"), thread("PRRT_a", 134, "Resolved since the round", true)];

  const text = textOf(ownerNote(PR_41, reviewed(2, ["PRRT_a", "PRRT_b"]), "3f9c2e0", followUpFor(41, "/work/squiz"), undefined, listed));

  assert.equal(text, "Squiz reviewed PR #41 at 3f9c2e0: 2 threads are open. Run `squiz review 41` to read them.");
});

test("#820: a note on the working tree calls it the working tree, whatever its state came to", () => {
  const records: readonly StateRecord[] = [
    reviewed(2, ["PRRT_a"]),
    { head: HEAD, activity: null, owner: OWNER, status: "failed", reason: "the reviewer stopped", ownerNoted: false },
    { head: HEAD, activity: null, owner: OWNER, status: "not reviewed", reason: "superseded by 8d21a4f" },
  ];

  for (const record of records) {
    const text = textOf(ownerNote(WORKING_TREE, record, "3f9c2e0", "Fix it."));
    assert.ok(text.startsWith("Squiz "), text);
    assert.doesNotMatch(text, /PR #/u, `the ${record.status} note names a pull request:\n${text}`);
    assert.match(text, /the working tree at 3f9c2e0/u, `the ${record.status} note does not name the working tree:\n${text}`);
  }
});

test("#823: a note on the working tree gives its rerun, never squiz review local", () => {
  const records: readonly StateRecord[] = [
    reviewed(2, ["PRRT_a"]),
    reviewed(3, []),
    { head: HEAD, activity: null, owner: OWNER, status: "failed", reason: "the reviewer stopped", ownerNoted: false },
  ];

  for (const record of records) {
    const text = textOf(ownerNote(WORKING_TREE, record, "3f9c2e0", "Fix it."));
    assert.doesNotMatch(text, /squiz review local/u, `the ${record.status} note names the key as an argument:\n${text}`);
    assert.ok(text.includes(`\`${WORKING_TREE.rerun}\``), `the ${record.status} note does not give the change's rerun:\n${text}`);
  }
});
