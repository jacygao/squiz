import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { claimDirectory, directoryName } from "./directory.ts";

/** A `SQUIZ_LOCAL` of its own, removed when the test ends. */
function localIn(t: TestContext): string {
  const local = mkdtempSync(join(tmpdir(), "squiz-local-directory-"));
  t.after(() => rmSync(local, { recursive: true, force: true }));
  return local;
}

test("a worktree's directory is named for its path, with the leading slash dropped and every other made a dash", () => {
  assert.equal(directoryName("/work/squiz"), "work-squiz");
  assert.equal(directoryName("/Users/jacy/Dev/squiz/.claude/worktrees/agent-a1"), "Users-jacy-Dev-squiz-.claude-worktrees-agent-a1");
});

test("a worktree's directory is made where it is missing, SQUIZ_LOCAL with it, holding the path it was made for", (t) => {
  const local = join(localIn(t), "not-yet");

  const claimed = claimDirectory(local, "/work/squiz");

  assert.deepEqual(claimed, { outcome: "claimed", directory: join(local, "work-squiz") });
  assert.equal(readFileSync(join(local, "work-squiz", "worktree"), "utf8"), "/work/squiz");
});

test("a worktree's own directory is claimed again, and left as it was", (t) => {
  const local = localIn(t);
  claimDirectory(local, "/work/squiz");
  writeFileSync(join(local, "work-squiz", "threads.json"), "{}");

  const again = claimDirectory(local, "/work/squiz");

  assert.deepEqual(again, { outcome: "claimed", directory: join(local, "work-squiz") });
  assert.deepEqual(readdirSync(join(local, "work-squiz")).sort(), ["threads.json", "worktree"]);
});

test("two worktrees whose paths differ only where the naming folds them get one directory, and the second is refused with § 4's line", (t) => {
  const local = localIn(t);
  claimDirectory(local, "/work/squiz-a");
  const before = readdirSync(join(local, "work-squiz-a"));

  const second = claimDirectory(local, "/work-squiz/a");

  assert.deepEqual(second, {
    outcome: "refused",
    reason: `${join(local, "work-squiz-a")} holds the review of /work/squiz-a, not /work-squiz/a`,
  });
  assert.equal(readFileSync(join(local, "work-squiz-a", "worktree"), "utf8"), "/work/squiz-a", "the first worktree's claim was overwritten");
  assert.deepEqual(readdirSync(join(local, "work-squiz-a")), before, "the refused claim wrote into the other worktree's directory");
  assert.deepEqual(readdirSync(local), ["work-squiz-a"], "the refused claim made a directory of its own");
});

test("a path that is not a worktree's absolute toplevel is refused, and nothing is made", (t) => {
  const local = localIn(t);

  for (const path of ["work/squiz", "/", "/..", "/work/../squiz", "/work/squiz/", ""]) {
    const claimed = claimDirectory(local, path);
    assert.equal(claimed.outcome, "failed", `${JSON.stringify(path)}: ${JSON.stringify(claimed)}`);
  }
  assert.deepEqual(readdirSync(local), []);
});

test("a SQUIZ_LOCAL that cannot be made fails with the reason, and does not throw", (t) => {
  const file = join(localIn(t), "a-file");
  writeFileSync(file, "");

  const claimed = claimDirectory(join(file, "local"), "/work/squiz");

  assert.equal(claimed.outcome, "failed", JSON.stringify(claimed));
  assert.match(claimed.outcome === "failed" ? claimed.reason : "", /could not be made/u);
  assert.equal(existsSync(join(file, "local")), false);
});
