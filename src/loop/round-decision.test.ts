import assert from "node:assert/strict";
import { test } from "node:test";

import { defaultConfig } from "../config/config.ts";
import {
  decideAfterRound,
  type EpisodeBounds,
  type FinishedRound,
  type RoundDecision,
} from "./round-decision.ts";

/** Every cap the configuration accepts. */
const caps = [1, 2, 3, 4, 5, 6, 7, 8] as const;

const budget = 0.5;

/**
 * How many rounds an episode is driven for before the test gives up on it.
 *
 * It is what fails where the arithmetic never closes an episode, rather than the
 * test hanging the way the loop it is checking would bill forever.
 */
const RUNAWAY = 100;

/**
 * Drive a whole episode under one cap, each round leaving three threads open and
 * spending `perRound` dollars, and collect the decision each round came to.
 *
 * The episode stops at the first decision to close, which is what a real one
 * does, so the number of decisions is the number of rounds the cap bought.
 */
function episodeUnder(cap: number, perRound = 0): RoundDecision[] {
  const bounds: EpisodeBounds = { rounds: cap, budget };
  const decisions: RoundDecision[] = [];
  for (let roundsRun = 1; roundsRun <= RUNAWAY; roundsRun += 1) {
    const decision = decideAfterRound(
      { openThreads: 3, roundsRun, spent: perRound * roundsRun },
      bounds,
    );
    decisions.push(decision);
    if (decision.next === "close") break;
  }
  assert.ok(
    decisions.length < RUNAWAY,
    `a cap of ${cap} never closed the episode, which is an unbounded billed loop`,
  );
  return decisions;
}

function blocksIn(decisions: readonly RoundDecision[]): number {
  return decisions.filter((decision) => decision.next === "block").length;
}

test("a cap of 1 reviews once and never blocks", () => {
  assert.deepEqual(
    episodeUnder(1),
    [{ next: "close", because: "round-cap" }],
    "a cap of 1 buys one round, and that round has no block to spend",
  );
});

test("a cap of R blocks at most R−1 times, for every cap the configuration allows", () => {
  for (const cap of caps) {
    const decisions = episodeUnder(cap);
    assert.equal(
      blocksIn(decisions),
      cap - 1,
      `a cap of ${cap} must block ${cap - 1} times, and it blocked ${blocksIn(decisions)}`,
    );
    assert.equal(
      decisions.length,
      cap,
      `a cap of ${cap} must run ${cap} rounds: every round but the last blocks`,
    );
    assert.deepEqual(
      decisions.at(-1),
      { next: "close", because: "round-cap" },
      `a cap of ${cap} must close on its last round, with the cap as the reason`,
    );
  }
});

// The boundary between the cap that never blocks and the cap that blocks once.
// Either side of it read from the other's arithmetic is a loop that blocks R
// times or one that never blocks at all.

test("a cap of 2 blocks once, where a cap of 1 blocks not at all", () => {
  assert.deepEqual(episodeUnder(2), [
    { next: "block" },
    { next: "close", because: "round-cap" },
  ]);
  assert.equal(blocksIn(episodeUnder(1)), 0);
});

test("the largest cap blocks seven times, which is what the runtime honours", () => {
  assert.equal(
    blocksIn(episodeUnder(8)),
    7,
    "the most consecutive blocks the cap can ask for is seven",
  );
});

// The firings where the runtime reports its own loop guard as already active,
// which is every firing after the first. A decision that read the guard would
// stop here and no episode would ever reach round 2.

test("the loop blocks again from round 2 onward", () => {
  const bounds: EpisodeBounds = { rounds: 8, budget };
  for (const roundsRun of [2, 3, 4, 5, 6, 7]) {
    assert.deepEqual(
      decideAfterRound({ openThreads: 1, roundsRun, spent: 0 }, bounds),
      { next: "block" },
      `round ${roundsRun} must block: the runtime's loop guard is not part of this`,
    );
  }
});

test("the decision is made from the round's three counts and nothing else", () => {
  // A required field added for anything the runtime reports fails to compile
  // here, and the keys say what the decision is allowed to read.
  const round: FinishedRound = { openThreads: 1, roundsRun: 1, spent: 0 };
  assert.deepEqual(Object.keys(round).sort(), ["openThreads", "roundsRun", "spent"]);
});

test("an episode whose rounds already exceed the cap closes", () => {
  // A cap lowered while the episode was running, which leaves the count above
  // the cap rather than at it.
  assert.deepEqual(
    decideAfterRound({ openThreads: 4, roundsRun: 5, spent: 0 }, { rounds: 3, budget }),
    { next: "close", because: "round-cap" },
  );
});

test("a round with no open threads closes the episode whatever the cap allows", () => {
  assert.deepEqual(
    decideAfterRound({ openThreads: 0, roundsRun: 1, spent: 0 }, { rounds: 8, budget }),
    { next: "close", because: "nothing-open" },
    "blocking with nothing open asks the coding agent to do nothing",
  );
});

test("the budget being spent closes the episode with rounds still allowed", () => {
  const bounds: EpisodeBounds = { rounds: 8, budget };
  assert.deepEqual(
    decideAfterRound({ openThreads: 2, roundsRun: 1, spent: budget }, bounds),
    { next: "close", because: "cost-bound" },
    "reaching the figure is reaching the bound",
  );
  assert.deepEqual(
    decideAfterRound({ openThreads: 2, roundsRun: 1, spent: budget + 0.2 }, bounds),
    { next: "close", because: "cost-bound" },
  );
  assert.deepEqual(
    decideAfterRound({ openThreads: 2, roundsRun: 1, spent: budget - 0.01 }, bounds),
    { next: "block" },
    "a round under the bound leaves the next round to run",
  );
});

test("an episode closes on the round that reaches the bound, not the one after", () => {
  // The bound is read from what the round that has just finished recorded, so
  // the episode closes holding the findings that round posted.
  const decisions = episodeUnder(8, 0.2);
  assert.deepEqual(decisions, [
    { next: "block" },
    { next: "block" },
    { next: "close", because: "cost-bound" },
  ]);
});

test("a spent budget closes the episode as nothing open where nothing is open", () => {
  // Nothing was stopped by the bound: the episode ran out of work first, and
  // that is what closed it.
  assert.deepEqual(
    decideAfterRound({ openThreads: 0, roundsRun: 2, spent: budget * 2 }, { rounds: 8, budget }),
    { next: "close", because: "nothing-open" },
  );
});

test("a count the arithmetic cannot use closes the episode rather than blocking", () => {
  const bounds: EpisodeBounds = { rounds: 8, budget };
  const unusable: readonly FinishedRound[] = [
    { openThreads: Number.NaN, roundsRun: 1, spent: 0 },
    { openThreads: -3, roundsRun: 1, spent: 0 },
    { openThreads: 2, roundsRun: 0, spent: 0 },
    { openThreads: 2, roundsRun: -1, spent: 0 },
    { openThreads: 2, roundsRun: 1.5, spent: 0 },
    { openThreads: 2, roundsRun: Number.NaN, spent: 0 },
    { openThreads: 2, roundsRun: Number.POSITIVE_INFINITY, spent: 0 },
  ];
  for (const round of unusable) {
    assert.equal(
      decideAfterRound(round, bounds).next,
      "close",
      `${JSON.stringify(round)} must not block: the cap is the only bound on the loop`,
    );
  }
  const unusableCaps = [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY];
  for (const rounds of unusableCaps) {
    assert.deepEqual(
      decideAfterRound({ openThreads: 2, roundsRun: 1, spent: 0 }, { rounds, budget }),
      { next: "close", because: "round-cap" },
      `a cap of ${rounds} must buy no block`,
    );
  }
});

test("the loaded configuration is the bounds an episode runs under", () => {
  // The two settings are read straight off the configuration, so a name that
  // drifts from it fails here rather than in the round that composes them.
  const bounds: EpisodeBounds = defaultConfig;
  assert.equal(blocksIn(episodeUnder(bounds.rounds)), 2, "the default cap of 3 blocks twice");
  assert.equal(
    decideAfterRound({ openThreads: 1, roundsRun: 1, spent: bounds.budget }, bounds).next,
    "close",
  );
});
