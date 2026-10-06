import { test } from "node:test";
import assert from "node:assert/strict";
import { pageCount } from "./pages.ts";

test("10 items in pages of 5 fill 2 pages", () => {
  assert.equal(pageCount(10, 5), 2);
});

test("a partly filled last page counts as a page", () => {
  assert.equal(pageCount(11, 5), 3);
});

test("fewer items than one page fill one page", () => {
  assert.equal(pageCount(1, 5), 1);
});

test("no items fill no pages", () => {
  assert.equal(pageCount(0, 5), 0);
});
