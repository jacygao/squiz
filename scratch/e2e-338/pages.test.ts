import assert from "node:assert/strict";
import { test } from "node:test";
import { getPage, lastPage, pageCount } from "./pages.ts";

test("ten items in pages of five", () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(pageCount(items.length, 5), 2);
  assert.deepEqual(getPage(items, 1, 5), [1, 2, 3, 4, 5]);
  assert.deepEqual(lastPage(items, 5), [6, 7, 8, 9, 10]);
});
