import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

import { adapterFor } from "./adapters.ts";
import { copilot } from "./copilot/adapter.ts";
import { pi } from "./pi/adapter.ts";

const reviewers = import.meta.dirname;
const sources = join(reviewers, "..");

test("each reviewer the configuration accepts is driven by its own adapter", () => {
  assert.equal(adapterFor("pi"), pi);
  assert.equal(adapterFor("copilot"), copilot);
});

// The specifier is matched as text, so an import written any way at all that
// names an adapter's directory is caught.
test("nothing outside src/reviewers/ reaches into one reviewer's adapter", () => {
  const reaching = readdirSync(sources, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.[cm]?ts$/u.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => relative(reviewers, file).startsWith(".."))
    .filter((file) => /["'`][^"'`]*reviewers\/(?:pi|copilot)\//u.test(readFileSync(file, "utf8")))
    .map((file) => relative(sources, file));

  assert.deepEqual(reaching, [], "the adapter is chosen by adapterFor alone");
});

// The history tools are granted at every review, so there is one grant and they end it.
test("each adapter's one grant ends in the history tools, under its own names", () => {
  assert.deepEqual(pi.grants.slice(-3), ["git_log_search", "git_blame", "git_show"]);
  assert.deepEqual(copilot.grants.slice(-3), ["squiz-git_log_search", "squiz-git_blame", "squiz-git_show"]);
});
