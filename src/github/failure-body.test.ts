import assert from "node:assert/strict";
import { test } from "node:test";

import { renderFailure } from "./failure-body.ts";

const REASON = "the reviewer was killed at its 900-second bound, and the round kept the 2 findings the reviewer had reported";
const RETRY = "The review is still open. A new commit or reply, or running `squiz review` again, retries it.";

test("what the round established is a list after the retry", () => {
  const moved = "`HEAD` moved while the reviewer ran: from a detached HEAD at 3f9c2e0 to a detached HEAD at 8d21a4f";
  assert.equal(
    renderFailure({ reason: REASON, established: [moved], salvaged: { threaded: 2, reported: 2 } }),
    `**Squiz review failed — ${REASON}**\n\nBoth findings are posted as threads. ${RETRY}\n\n- ${moved}`,
  );
});

test("the count says how many of the salvaged findings landed, in words that agree with it", () => {
  const counted = [
    { threaded: 1, reported: 1, says: "The finding is posted as a thread." },
    { threaded: 3, reported: 3, says: "All 3 findings are posted as threads." },
    { threaded: 0, reported: 1, says: "The finding the reviewer reported is not posted as a thread." },
    { threaded: 0, reported: 2, says: "0 of the 2 findings the reviewer reported are posted as threads." },
    { threaded: 2, reported: 3, says: "2 of the 3 findings the reviewer reported are posted as threads." },
  ];
  for (const { threaded, reported, says } of counted) {
    const body = renderFailure({ reason: REASON, established: [], salvaged: { threaded, reported } });
    assert.equal(body.split("\n\n")[1], `${says} ${RETRY}`, `${threaded} of ${reported}`);
  }
});

test("#544: a failed round that left no round under the cap says the review closed rather than that it retries", () => {
  const body = renderFailure({
    reason: REASON,
    established: [],
    salvaged: { threaded: 2, reported: 2 },
    closed: { bound: "round-cap", roundsRun: 3, cap: 3 },
  });
  assert.equal(
    body.split("\n\n")[1],
    "Both findings are posted as threads. The review is closed: it has run 3 rounds, and the round cap allows 3. " +
      "No round runs again. A new commit or reply, or running `squiz review`, posts its summary.",
  );
  assert.doesNotMatch(body, /retries/u, "no retry is coming");
});

test("#544: a failed round that reached the token bound says the review closed at the bound", () => {
  const body = renderFailure({
    reason: REASON,
    established: [],
    closed: { bound: "token-bound", tokens: 10_000_000, roundsRun: 2 },
  });
  assert.equal(
    body.split("\n\n")[1],
    "The review is closed: it reached the token bound of 10,000,000 tokens. " +
      "No round runs again. A new commit or reply, or running `squiz review`, posts its summary.",
  );
});

test("an episode closed at the token bound before any round ran promises no summary", () => {
  const body = renderFailure({
    reason: REASON,
    established: [],
    closed: { bound: "token-bound", tokens: 400_000, roundsRun: 0 },
  });
  assert.equal(
    body.split("\n\n")[1],
    "The review is closed: it reached the token bound of 400,000 tokens. No round runs again.",
  );
});
