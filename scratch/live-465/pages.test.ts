import { test } from "node:test";
import assert from "node:assert/strict";
import { pageCount } from "./pages.ts";

test("10 items in pages of 5 fill 2 pages", () => {
  assert.equal(pageCount(10, 5), 2);
});
