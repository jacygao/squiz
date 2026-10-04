import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type StateKey,
  type StateRecord,
  putRecord,
  recordFor,
  recordFrom,
  sameState,
} from "./state-record.ts";

const head = "3f9c2e07b1d4a8c6e5f0923b7a1d6c4e8b2f5a90";
const laterHead = "8d21a4f0c3b2e1d4a5f6b7c8d9e0f1a2b3c4d5e6";
const reply = "PRRC_kwDOL7tYbc6OmQx7a";

const owner = {
  sessionId: "60517e1f-e1dc-49b1-8e39-6fcbe686f3fb",
  subagent: "a402ef8f56c1b2ed1",
  messagingSocket: "/tmp/claude-501/messaging-60517e1f.sock",
};

/** One record in each of the five states, each carrying all § 3 gives it. */
const everyState: readonly StateRecord[] = [
  { head, activity: null, status: "queued", owner },
  { head, activity: reply, status: "reviewing", host: { pid: 4012, startedAt: 1_791_000_000 } },
  {
    head,
    activity: reply,
    status: "reviewing",
    host: { pid: 4012, startedAt: 1_791_000_000 },
    reviewer: {
      backend: "tmux",
      pane: "@14",
      process: { pid: 4100, startedAt: 1_791_000_003 },
      boundEndsAt: 1_791_000_483,
      snapshot: "/work/squiz/.squiz/41/rounds/3/tree",
    },
  },
  {
    head,
    activity: null,
    status: "reviewing",
    host: { pid: 4012, startedAt: 1_791_000_000 },
    reviewer: {
      backend: "detached",
      process: { pid: 4101, startedAt: 1_791_000_004 },
      boundEndsAt: 1_791_000_484,
      snapshot: "/work/squiz/.squiz/41/rounds/3/tree",
    },
  },
  {
    head,
    activity: null,
    status: "reviewed",
    result: "exited",
    exitStatus: 2,
    openThreads: ["PRRT_kwDOL7tYbc5abcd2"],
    owner: { sessionId: owner.sessionId },
  },
  { head, activity: null, status: "reviewed", result: "clean, episode open" },
  { head, activity: null, status: "failed", reason: "the round host died", ownerNoted: false },
  {
    head: laterHead,
    activity: reply,
    status: "not reviewed",
    reason: "the episode closed at the round cap, after reviewing 3f9c2e0",
  },
];

for (const record of everyState) {
  const shape =
    record.status === "reviewing" && record.reviewer !== undefined
      ? `reviewing by a ${record.reviewer.backend} reviewer`
      : record.status === "reviewed"
        ? `reviewed (${record.result})`
        : record.status;
  test(`a ${shape} record reads back as it was written`, () => {
    assert.deepEqual(recordFrom(JSON.parse(JSON.stringify(record))), { record });
  });
}

/**
 * Records that must not read. Each one dropped instead would be a state with no
 * record, which a trigger queues again, or a queued state no host ever takes.
 */
const malformed: readonly [string, unknown][] = [
  ["a record that is not an object", "queued"],
  ["an unknown status", { head, activity: null, status: "postponed" }],
  ["no status", { head, activity: null }],
  ["no head", { activity: null, status: "queued" }],
  ["an empty head", { head: "", activity: null, status: "queued" }],
  // Absent is not none. A writer that dropped the field would turn a reply's
  // state into the state with no activity.
  ["no activity at all", { head, status: "queued" }],
  ["an empty activity", { head, activity: "", status: "queued" }],
  ["a numeric activity", { head, activity: 7, status: "queued" }],
  ["an owner that is not an object", { head, activity: null, status: "queued", owner: "me" }],
  ["an owner with no session", { head, activity: null, status: "queued", owner: { subagent: "a1" } }],
  ["an owner whose socket is not a string", { head, activity: null, status: "queued", owner: { sessionId: "s", messagingSocket: 3 } }],
  ["a reviewing record with no host", { head, activity: null, status: "reviewing" }],
  ["a host with no start time", { head, activity: null, status: "reviewing", host: { pid: 4012 } }],
  ["a host whose pid is zero", { head, activity: null, status: "reviewing", host: { pid: 0, startedAt: 1 } }],
  [
    "a reviewer on an unknown backend",
    { head, activity: null, status: "reviewing", host: { pid: 1, startedAt: 1 }, reviewer: { backend: "screen", pane: "1", process: { pid: 2, startedAt: 2 }, boundEndsAt: 3, snapshot: "/t" } },
  ],
  [
    "a tmux reviewer with no window",
    { head, activity: null, status: "reviewing", host: { pid: 1, startedAt: 1 }, reviewer: { backend: "tmux", process: { pid: 2, startedAt: 2 }, boundEndsAt: 3, snapshot: "/t" } },
  ],
  [
    "a detached reviewer naming a pane",
    { head, activity: null, status: "reviewing", host: { pid: 1, startedAt: 1 }, reviewer: { backend: "detached", pane: "1", process: { pid: 2, startedAt: 2 }, boundEndsAt: 3, snapshot: "/t" } },
  ],
  [
    "a reviewer with no time bound",
    { head, activity: null, status: "reviewing", host: { pid: 1, startedAt: 1 }, reviewer: { backend: "detached", process: { pid: 2, startedAt: 2 }, snapshot: "/t" } },
  ],
  [
    "a reviewer with no snapshot",
    { head, activity: null, status: "reviewing", host: { pid: 1, startedAt: 1 }, reviewer: { backend: "detached", process: { pid: 2, startedAt: 2 }, boundEndsAt: 3 } },
  ],
  ["a reviewed record with no result", { head, activity: null, status: "reviewed" }],
  ["a reviewed record exiting 1", { head, activity: null, status: "reviewed", result: "exited", exitStatus: 1, openThreads: [] }],
  ["a reviewed record with no open threads listed", { head, activity: null, status: "reviewed", result: "exited", exitStatus: 0 }],
  ["open threads that are not strings", { head, activity: null, status: "reviewed", result: "exited", exitStatus: 2, openThreads: [3] }],
  // Clean, episode open has no exit status. One carrying it is a writer that
  // meant something else.
  ["a clean, episode open record with an exit status", { head, activity: null, status: "reviewed", result: "clean, episode open", exitStatus: 0 }],
  ["a failed record with no reason", { head, activity: null, status: "failed", ownerNoted: true }],
  // Read as no, the owner gets a second note. Read as yes, a first note is never sent.
  ["a failed record not saying whether its owner was noted", { head, activity: null, status: "failed", reason: "r" }],
  ["a not reviewed record with no reason", { head, activity: null, status: "not reviewed" }],
];

for (const [what, entry] of malformed) {
  test(`${what} does not read as a record`, () => {
    const read = recordFrom(entry);
    if (!("problem" in read)) {
      assert.fail(`${JSON.stringify(entry)} read as a record, and a state file holding it would be read as if it held something else`);
    }
    assert.notEqual(read.problem, "");
  });
}

test("an unknown status is named in the reason it does not read", () => {
  const read = recordFrom({ head, activity: null, status: "postponed" });
  assert.match("problem" in read ? read.problem : "", /"postponed"/u);
});

// A file a later version wrote is still the episode's own.
test("a field this reader has no name for is ignored", () => {
  assert.deepEqual(recordFrom({ head, activity: null, status: "queued", postingSeconds: 3.2 }), {
    record: { head, activity: null, status: "queued" },
  });
});

test("the same head and the same activity are the same state", () => {
  assert.equal(sameState({ head, activity: reply }, { head, activity: reply }), true);
  assert.equal(sameState({ head, activity: null }, { head, activity: null }), true);
});

test("a state with no activity and one whose activity is a reply are never the same", () => {
  assert.equal(sameState({ head, activity: null }, { head, activity: reply }), false);
  assert.equal(sameState({ head, activity: reply }, { head, activity: null }), false);
  // Neither the string "null" nor an empty string is no activity.
  assert.equal(sameState({ head, activity: null }, { head, activity: "null" }), false);
  assert.equal(sameState({ head, activity: null }, { head, activity: "" }), false);
});

test("a new commit is a new state, whatever the activity", () => {
  assert.equal(sameState({ head, activity: reply }, { head: laterHead, activity: reply }), false);
  assert.equal(sameState({ head, activity: null }, { head: laterHead, activity: null }), false);
});

test("the record for a state is found by its head and its activity together", () => {
  const records: StateRecord[] = [
    { head, activity: null, status: "reviewed", result: "clean, episode open" },
    { head, activity: reply, status: "queued" },
  ];
  const key: StateKey = { head, activity: reply };

  assert.deepEqual(recordFor(records, key), { head, activity: reply, status: "queued" });
  assert.equal(recordFor(records, { head: laterHead, activity: null }), undefined);
});

test("putting a record replaces the one for its state, in place, and leaves the rest", () => {
  const first: StateRecord = { head, activity: null, status: "reviewed", result: "clean, episode open" };
  const queued: StateRecord = { head, activity: reply, status: "queued" };
  const records = [first, queued];
  const reviewing: StateRecord = { head, activity: reply, status: "reviewing", host: { pid: 9, startedAt: 9 } };

  assert.deepEqual(putRecord(records, reviewing), [first, reviewing]);
  assert.deepEqual(records, [first, queued], "the records it was given must not change");
});

test("putting a record for a state with none appends it", () => {
  const first: StateRecord = { head, activity: null, status: "queued" };
  const later: StateRecord = { head: laterHead, activity: null, status: "queued" };
  assert.deepEqual(putRecord([first], later), [first, later]);
});
