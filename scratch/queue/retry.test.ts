import assert from "node:assert/strict";
import { test } from "node:test";
import { scheduleFor, waitFor } from "./retry.ts";

test("the first wait is a quarter of a second, and each doubles", () => {
  assert.equal(waitFor(1), 250);
  assert.equal(waitFor(2), 500);
  assert.equal(waitFor(3), 1_000);
});

test("the wait is capped rather than growing without bound", () => {
  assert.equal(waitFor(20), 30_000);
});

test("a message given one attempt waits not at all", () => {
  assert.deepEqual(scheduleFor(1), []);
});
