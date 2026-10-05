import assert from "node:assert/strict";
import { test } from "node:test";
import { paginate } from "./paginate.ts";

test("splits items into full pages and a shorter last page", () => {
  assert.deepEqual(paginate([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test("returns only full pages when the size divides the count", () => {
  assert.deepEqual(paginate(["a", "b", "c", "d"], 2), [["a", "b"], ["c", "d"]]);
});

test("returns a single page when the size exceeds the item count", () => {
  assert.deepEqual(paginate([1, 2], 10), [[1, 2]]);
});

test("returns no pages for no items", () => {
  assert.deepEqual(paginate([], 3), []);
});

test("rejects a page size that is not a positive integer", () => {
  for (const size of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => paginate([1, 2, 3], size), RangeError, `size ${size} was accepted`);
  }
});
