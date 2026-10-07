import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { prepareCase } from "./case-repository.ts";

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
}

/** An upstream repository of one commit, and a patch that changes its one file. */
function upstream(): { url: string; commit: string; patches: string } {
  const root = mkdtempSync(join(tmpdir(), "measure-case-"));
  const repository = join(root, "upstream");
  execFileSync("git", ["init", "--quiet", repository]);
  writeFileSync(join(repository, "a.js"), "module.exports = 1;\n");
  git(repository, "add", "a.js");
  git(repository, "-c", "user.name=u", "-c", "user.email=u@example.com", "commit", "--quiet", "-m", "first");
  const patches = join(root, "patches");
  execFileSync("mkdir", [patches]);
  writeFileSync(
    join(patches, "two.patch"),
    [
      "diff --git a/a.js b/a.js",
      "index 0000000..0000000 100644",
      "--- a/a.js",
      "+++ b/a.js",
      "@@ -1 +1 @@",
      "-module.exports = 1;",
      "+module.exports = 2;",
      "",
    ].join("\n"),
  );
  return { url: repository, commit: git(repository, "rev-parse", "HEAD"), patches };
}

test("an upstream case is its commit with the patch committed on top, and its diff is the patch", () => {
  const { url, commit, patches } = upstream();
  const cache = mkdtempSync(join(tmpdir(), "measure-cache-"));
  const prepared = prepareCase("two", { kind: "upstream", url, commit, patch: "two.patch" }, patches, cache);
  assert.equal(prepared.outcome, "prepared");
  if (prepared.outcome !== "prepared") return;
  assert.equal(prepared.base, commit);
  assert.match(prepared.head, /^[0-9a-f]{40}$/u);
  assert.equal(git(prepared.repository, "rev-parse", `${prepared.head}^`), commit);
  assert.match(prepared.diff, /^-module\.exports = 1;$/mu);
  assert.match(prepared.diff, /^\+module\.exports = 2;$/mu);
});

test("preparing a case twice gives the same head, so every run of it reviews one commit", () => {
  const { url, commit, patches } = upstream();
  const cache = mkdtempSync(join(tmpdir(), "measure-cache-"));
  const source = { kind: "upstream", url, commit, patch: "two.patch" } as const;
  const first = prepareCase("two", source, patches, cache);
  const second = prepareCase("two", source, patches, cache);
  assert.equal(first.outcome, "prepared");
  assert.deepEqual(second, first);
});

test("a case of this repository's own commits is reviewed where they are", () => {
  const { url, commit } = upstream();
  const prepared = prepareCase("own", { kind: "here", repository: url, base: commit, head: commit }, "/nowhere", "/nowhere");
  assert.deepEqual(prepared, { outcome: "prepared", repository: url, base: commit, head: commit, diff: "" });
});

test("a patch that does not apply is a reason, not a throw", () => {
  const { url, commit, patches } = upstream();
  const cache = mkdtempSync(join(tmpdir(), "measure-cache-"));
  writeFileSync(join(patches, "bad.patch"), "diff --git a/b.js b/b.js\n--- a/b.js\n+++ b/b.js\n@@ -1 +1 @@\n-x\n+y\n");
  const prepared = prepareCase("bad", { kind: "upstream", url, commit, patch: "bad.patch" }, patches, cache);
  assert.equal(prepared.outcome, "failed");
});
