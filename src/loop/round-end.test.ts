import assert from "node:assert/strict";
import { test } from "node:test";

import { renderSummary } from "../github/summary-body.ts";
import { nothingEstablished } from "./confinement.ts";
import { decideAfterRound, type EpisodeBounds } from "./round-decision.ts";
import { decideRoundEnd, lastReviewed, namedStates, type EndedRound, type QueuedRecord } from "./round-end.ts";

const reviewedHead = "3f9c2e07b1d4a8c6e5f0923b7a1d6c4e8b2f5a90";
const laterHead = "8d21a4f0c3b2e1d4a5f6b7c8d9e0f1a2b3c4d5e6";
const laterStill = "c47e19b2a0d3f5e6c7b8a9d0e1f2a3b4c5d6e7f8";
const reply = "PRRC_kwDOL7tYbc6OmQx7a";

const unspentRound = { dollars: 0, tokens: 0, messages: 0 };

/**
 * A state retried by `squiz review` keeps its place in the records, so the last
 * record reviewed need not be the last state reviewed. The round's number says.
 */
test("the last state reviewed is the one with the highest round number, wherever its record sits", () => {
  const ran = (number: number) => ({ number, startedAt: 1, endedAt: 2, reviewer: { backend: "detached" as const } });
  const retried = { head: reviewedHead, activity: null };
  const records = [
    { ...retried, status: "reviewed" as const, result: "exited" as const, exitStatus: 2 as const, openThreads: [], round: ran(3) },
    { head: laterHead, activity: null, status: "reviewed" as const, result: "exited" as const, exitStatus: 2 as const, openThreads: [], round: ran(2) },
  ];

  assert.deepEqual(lastReviewed(records), retried);
});

test("records written before rounds were numbered fall back to the last one reviewed", () => {
  const records = [
    { head: reviewedHead, activity: null, status: "reviewed" as const, result: "clean, episode open" as const },
    { head: laterHead, activity: null, status: "reviewed" as const, result: "clean, episode open" as const },
  ];

  assert.deepEqual(lastReviewed(records), { head: laterHead, activity: null });
});

const owner = { sessionId: "60517e1f-e1dc-49b1-8e39-6fcbe686f3fb" };

const bound = 400_000;
const bounds: EpisodeBounds = { rounds: 3, tokens: bound };

/** Round `roundsRun` of a cap of 3 on the reviewed state, leaving `openThreads` open. */
function roundOf(roundsRun: number, openThreads: readonly string[], tokens = 0): EndedRound {
  return { state: { head: reviewedHead, activity: null, owner }, openThreads, roundsRun, tokens };
}

/** A later commit, and a reply on the same commit after it, each from a different owner. */
const twoQueued: readonly QueuedRecord[] = [
  { head: laterHead, activity: null, status: "queued", owner: { sessionId: "b-session" } },
  { head: laterStill, activity: reply, status: "queued" },
];

test("nothing open with a later state queued and rounds remaining leaves the episode open", () => {
  assert.deepEqual(decideRoundEnd(roundOf(1, []), bounds, twoQueued.slice(0, 1)), {
    outcome: "reviewed clean, episode open",
    // No exit status and no open threads: the round reached no close, so the
    // record carries nothing a summary or a note would be written from.
    record: { head: reviewedHead, activity: null, owner, status: "reviewed", result: "clean, episode open" },
  });
});

test("threads open with rounds remaining leaves every queued state to be reviewed next", () => {
  assert.deepEqual(decideRoundEnd(roundOf(2, ["PRRT_a", "PRRT_b"]), bounds, twoQueued), {
    outcome: "threads open",
    record: {
      head: reviewedHead,
      activity: null,
      owner,
      status: "reviewed",
      result: "exited",
      exitStatus: 2,
      openThreads: ["PRRT_a", "PRRT_b"],
    },
  });
});

test("the round cap closes the episode and records each of two queued states not reviewed", () => {
  assert.deepEqual(decideRoundEnd(roundOf(3, ["PRRT_a"]), bounds, twoQueued), {
    outcome: "closed",
    because: "round-cap",
    record: {
      head: reviewedHead,
      activity: null,
      owner,
      status: "reviewed",
      result: "exited",
      exitStatus: 3,
      openThreads: ["PRRT_a"],
    },
    leftNotReviewed: {
      bound: "round-cap",
      after: { head: reviewedHead, activity: null },
      states: [
        {
          head: laterHead,
          activity: null,
          owner: { sessionId: "b-session" },
          status: "not reviewed",
          reason: "the episode closed at the round cap, after reviewing 3f9c2e0",
        },
        {
          head: laterStill,
          activity: reply,
          status: "not reviewed",
          reason: "the episode closed at the round cap, after reviewing 3f9c2e0",
        },
      ],
    },
  });
});

test("the token bound closes the episode and records each of two queued states not reviewed", () => {
  const ended = decideRoundEnd(roundOf(1, ["PRRT_a"], bound), bounds, twoQueued);
  assert.equal(ended.outcome, "closed");
  assert.ok(ended.outcome === "closed");
  assert.equal(ended.because, "token-bound");
  assert.equal(ended.record.result === "exited" && ended.record.exitStatus, 3);
  assert.equal(ended.leftNotReviewed?.bound, "token-bound");
  assert.deepEqual(
    ended.leftNotReviewed.states.map((record) => [record.head, record.status, record.reason]),
    [
      [laterHead, "not reviewed", "the episode closed at the token bound, after reviewing 3f9c2e0"],
      [laterStill, "not reviewed", "the episode closed at the token bound, after reviewing 3f9c2e0"],
    ],
  );
});

// The queued state needs a round of its own, and the cap or the bound leaves it
// none, so nothing open does not keep the episode open for it. The episode still
// closed with nothing open, which is what its summary says.
test("nothing open on the last round closes the episode and records the queued state not reviewed", () => {
  const atCap = decideRoundEnd(roundOf(3, []), bounds, twoQueued.slice(0, 1));
  assert.ok(atCap.outcome === "closed", `the cap is spent, and the episode closed as ${atCap.outcome}`);
  assert.equal(atCap.because, "nothing-open");
  assert.equal(atCap.record.result === "exited" && atCap.record.exitStatus, 0);
  // The bound is named apart from the close, which says only that nothing was open.
  assert.equal(atCap.leftNotReviewed?.bound, "round-cap");
  assert.deepEqual(
    atCap.leftNotReviewed.states.map((record) => record.reason),
    ["the episode closed at the round cap, after reviewing 3f9c2e0"],
  );

  const atBound = decideRoundEnd(roundOf(1, [], bound), bounds, twoQueued.slice(0, 1));
  assert.ok(atBound.outcome === "closed", `the bound is reached, and the episode closed as ${atBound.outcome}`);
  assert.equal(atBound.because, "nothing-open");
  assert.equal(atBound.leftNotReviewed?.bound, "token-bound");
  assert.deepEqual(
    atBound.leftNotReviewed.states.map((record) => record.reason),
    ["the episode closed at the token bound, after reviewing 3f9c2e0"],
  );
});

test("the close of a clean last round hands the summary the cap and the state it stopped", () => {
  const ended = decideRoundEnd(roundOf(3, []), bounds, twoQueued.slice(0, 1));
  assert.ok(ended.outcome === "closed");
  const comment = renderSummary({
    rounds: [unspentRound, unspentRound, unspentRound],
    threads: [],
    findings: { outcomes: [] },
    earlier: [],
    because: ended.because,
    confinement: nothingEstablished,
    leftNotReviewed: ended.leftNotReviewed,
  });
  assert.ok(
    comment.endsWith(
      "- The episode ended at its round cap with nothing left open, and did not review 8d21a4f",
    ),
    `the cap and the state it stopped were not noted: ${comment}`,
  );
});

test("a state is named by its short head commit where no state before it shares that head", () => {
  assert.deepEqual(
    namedStates({ head: reviewedHead, activity: null }, [
      { head: laterHead, activity: null },
      { head: laterStill, activity: reply },
    ]),
    ["8d21a4f", "c47e19b"],
  );
});

// The reviewed state's reply was deleted, so the queued state has no reply at
// all. A shared head says the replies changed, not which way.
test("a state whose reply was deleted is named with different replies", () => {
  assert.deepEqual(namedStates({ head: reviewedHead, activity: reply }, [{ head: reviewedHead, activity: null }]), [
    "3f9c2e0 with different replies",
  ]);
});

test("a state with the head of the reviewed state and a reply after it is named with different replies", () => {
  assert.deepEqual(namedStates({ head: reviewedHead, activity: null }, [{ head: reviewedHead, activity: reply }]), [
    "3f9c2e0 with different replies",
  ]);
});

// Two replies on one commit are two states, and a line naming both must not
// read as one state named twice.
test("states sharing a head are counted apart by how many before them share it", () => {
  assert.deepEqual(
    namedStates({ head: reviewedHead, activity: null }, [
      { head: laterHead, activity: null },
      { head: laterHead, activity: reply },
      { head: laterHead, activity: "PRRC_kwDOL7tYbc6OmQx9z" },
      { head: reviewedHead, activity: "PRRC_kwDOL7tYbc6OmQy1c" },
    ]),
    [
      "8d21a4f",
      "8d21a4f with different replies",
      "8d21a4f with different replies a second time",
      "3f9c2e0 with different replies",
    ],
  );
});

test("with nothing queued, every round ends where the round decision says", () => {
  const cases: readonly EndedRound[] = [
    roundOf(1, []),
    roundOf(3, []),
    roundOf(1, [], bound),
    roundOf(1, ["PRRT_a"]),
    roundOf(2, ["PRRT_a", "PRRT_b"]),
    roundOf(3, ["PRRT_a"]),
    roundOf(1, ["PRRT_a"], bound),
    roundOf(5, ["PRRT_a"]),
    roundOf(Number.NaN, ["PRRT_a"]),
  ];
  for (const round of cases) {
    const today = decideAfterRound(
      { openThreads: round.openThreads.length, roundsRun: round.roundsRun, tokens: round.tokens },
      bounds,
    );
    const ended = decideRoundEnd(round, bounds, []);
    const label = `round ${round.roundsRun} with ${round.openThreads.length} open and ${round.tokens} tokens`;
    if (today.next === "block") {
      assert.equal(ended.outcome, "threads open", `${label} blocks today`);
      assert.equal(ended.record.result === "exited" && ended.record.exitStatus, 2, label);
      continue;
    }
    assert.ok(ended.outcome === "closed", `${label} closes today, and ended as ${ended.outcome}`);
    assert.equal(ended.because, today.because, label);
    assert.equal(ended.leftNotReviewed, null, label);
    assert.equal(
      ended.record.result === "exited" && ended.record.exitStatus,
      round.openThreads.length === 0 ? 0 : 3,
      `${label}: 0 where nothing is open, and 3 where a bound closed it with threads open`,
    );
  }
});
