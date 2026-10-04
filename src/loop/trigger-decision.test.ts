import assert from "node:assert/strict";
import { test } from "node:test";

import type { Presence } from "../sessions/process.ts";
import type { StateRecord } from "./state-record.ts";
import { decideTrigger, type TriggerDecision, type TriggerKind } from "./trigger-decision.ts";

const kinds: readonly TriggerKind[] = ["hook", "review"];

const running: Presence = { outcome: "running" };
const gone: Presence = { outcome: "gone" };
const unknown: Presence = { outcome: "unknown", reason: "ps did not answer within 2000ms" };
const presences: readonly Presence[] = [running, gone, unknown];

const key = { head: "3f9c2e0", activity: null };
const host = { pid: 4242, startedAt: 1_791_000_000 };

const queued: StateRecord = { ...key, status: "queued" };
const reviewing: StateRecord = { ...key, status: "reviewing", host };
const reviewed: StateRecord = { ...key, status: "reviewed", result: "exited", exitStatus: 2, openThreads: ["PRRT_1"] };
const reviewedClean: StateRecord = { ...key, status: "reviewed", result: "clean, episode open" };
const failed: StateRecord = { ...key, status: "failed", reason: "the round host died", ownerNoted: true };
const notReviewed: StateRecord = { ...key, status: "not reviewed", reason: "the episode closed at the round cap" };

const withResults: readonly StateRecord[] = [reviewed, reviewedClean, notReviewed];

const everyRecord: readonly (StateRecord | undefined)[] = [
  undefined,
  queued,
  reviewing,
  reviewed,
  reviewedClean,
  failed,
  notReviewed,
];

function decide(record: StateRecord | undefined, presence: Presence, trigger: TriggerKind): TriggerDecision {
  return decideTrigger({ closed: false, record, host: presence, trigger });
}

test("a state with no record is queued, with a host started where none is running", () => {
  for (const trigger of kinds) {
    assert.deepEqual(decide(undefined, gone, trigger), { outcome: "queue", startHost: true }, trigger);
    assert.deepEqual(decide(undefined, running, trigger), { outcome: "queue", startHost: false }, trigger);
  }
});

test("a host that cannot be told running is started anyway, since a second host exits on the lock", () => {
  for (const trigger of kinds) {
    assert.deepEqual(decide(undefined, unknown, trigger), { outcome: "queue", startHost: true }, trigger);
    assert.deepEqual(decide(queued, unknown, trigger), { outcome: "start-host" }, trigger);
  }
});

test("a hook on a failed state queues nothing, so a failure does not bring itself back", () => {
  for (const presence of presences) {
    assert.deepEqual(decide(failed, presence, "hook"), { outcome: "left-failed" }, presence.outcome);
  }
});

test("squiz review on a failed state queues it again", () => {
  assert.deepEqual(decide(failed, gone, "review"), { outcome: "queue", startHost: true });
  assert.deepEqual(decide(failed, running, "review"), { outcome: "queue", startHost: false });
});

test("a reviewing record whose host has gone is recovered, and then treated as failed", () => {
  assert.deepEqual(decide(reviewing, gone, "hook"), {
    outcome: "recover",
    afterwards: { outcome: "left-failed" },
  });
  assert.deepEqual(decide(reviewing, gone, "review"), {
    outcome: "recover",
    afterwards: { outcome: "queue", startHost: true },
  });
});

test("a queued state with no live host starts one, or it is never reviewed", () => {
  for (const trigger of kinds) {
    assert.deepEqual(decide(queued, gone, trigger), { outcome: "start-host" }, trigger);
  }
});

test("a queued state with a live host queues nothing", () => {
  for (const trigger of kinds) {
    assert.deepEqual(decide(queued, running, trigger), { outcome: "in-hand" }, trigger);
  }
});

test("a reviewing record whose host is running queues nothing", () => {
  for (const trigger of kinds) {
    assert.deepEqual(decide(reviewing, running, trigger), { outcome: "in-hand" }, trigger);
  }
});

test("a reviewing record whose host cannot be told is neither recovered nor queued again", () => {
  for (const trigger of kinds) {
    assert.deepEqual(
      decide(reviewing, unknown, trigger),
      { outcome: "host-unknown", reason: "ps did not answer within 2000ms" },
      trigger,
    );
  }
});

test("a reviewed or not reviewed state queues nothing and returns its result", () => {
  for (const trigger of kinds) {
    for (const record of withResults) {
      for (const presence of presences) {
        assert.deepEqual(decide(record, presence, trigger), { outcome: "result" }, `${trigger} ${record.status}`);
      }
    }
  }
});

test("a closed episode queues nothing for any state, and returns its close", () => {
  for (const trigger of kinds) {
    for (const record of everyRecord) {
      for (const presence of presences) {
        assert.deepEqual(
          decideTrigger({ closed: true, record, host: presence, trigger }),
          { outcome: "closed" },
          `${trigger}, ${record?.status ?? "no record"}, host ${presence.outcome}`,
        );
      }
    }
  }
});
