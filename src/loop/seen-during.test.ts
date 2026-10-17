import assert from "node:assert/strict";
import { test } from "node:test";

import type { Round } from "../reviewers/round.ts";
import { seenDuring } from "./seen-during.ts";

type TimedOut = Extract<Round, { readonly outcome: "timed-out" }>;

/** A `pi` round killed at a 900-second bound, as #484's was. */
function killed(over: Partial<TimedOut> = {}): TimedOut {
  return {
    outcome: "timed-out",
    cost: { dollars: 0.254, tokens: 891_728, messages: 21, floor: true },
    seconds: 900,
    refusals: 0,
    findings: [],
    verdicts: [],
    ...over,
  };
}

test("a killed round names its messages and the requests its provider failed (#494)", () => {
  assert.deepEqual(seenDuring(killed({ failedRequests: { count: 7, last: "429 Too Many Requests" } })), [
    "the reviewer's 21 messages took about 43 seconds each",
    'its provider failed 7 requests, the last with "429 Too Many Requests"',
  ]);
});

test("a killed round with no failed request names its messages alone (#494)", () => {
  assert.deepEqual(seenDuring(killed()), ["the reviewer's 21 messages took about 43 seconds each"]);
});

test("a killed round names one message, and no message, in words (#494)", () => {
  assert.deepEqual(seenDuring(killed({ cost: { dollars: 0, tokens: 0, messages: 1 } })), [
    "the reviewer's one message took about 900 seconds",
  ]);
  assert.deepEqual(seenDuring(killed({ cost: { dollars: 0, tokens: 0, messages: 0 } })), [
    "the reviewer completed no message",
  ]);
});

test("a failed request's error is quoted by its first line, cut to a length a line can carry (#494)", () => {
  const long = `${"x".repeat(300)}\nstack trace`;
  const [, failures] = seenDuring(killed({ failedRequests: { count: 1, last: long } }));
  assert.equal(failures, `its provider failed 1 request, the last with "${"x".repeat(120)}…"`);
});

test("a failed request with no error is counted without a quote (#494)", () => {
  const [, failures] = seenDuring(killed({ failedRequests: { count: 2, last: undefined } }));
  assert.equal(failures, "its provider failed 2 requests");
});

test("a killed round the machine slept through names the sleep, last (#665)", () => {
  assert.deepEqual(seenDuring(killed({ sleep: { slept: 780_400, added: 780_400 } })), [
    "the reviewer's 21 messages took about 43 seconds each",
    "the machine slept for 13 minutes of the round",
  ]);
});

test("a sleep is named in seconds under a minute, and one minute in words (#665)", () => {
  const [, short] = seenDuring(killed({ sleep: { slept: 42_000, added: 42_000 } }));
  assert.equal(short, "the machine slept for 42 seconds of the round");
  const [, minute] = seenDuring(killed({ sleep: { slept: 61_000, added: 61_000 } }));
  assert.equal(minute, "the machine slept for 1 minute of the round");
});
