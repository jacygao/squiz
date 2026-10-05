import assert from "node:assert/strict";
import { join, sep } from "node:path";
import { test } from "node:test";

import { EpisodeError, episodeAt, episodeNamed } from "./episode.ts";

const number = 41;

const worktree = join(sep, "worktrees", "feature-a");

test("everything an episode owns hangs off one directory named for its pull request", () => {
  const directory = join(worktree, ".squiz", "41");
  assert.deepEqual(episodeAt(worktree, number), {
    worktree,
    id: "41",
    directory,
    stateFile: join(directory, "state.json"),
    scratchDirectory: join(directory, "scratch"),
  });
});

/**
 * Keys no pull request has, each typed as a number so that the check at run time
 * is what refuses it. A string and a fraction reach here only past the type
 * checker, which is how a value read from a file or an API arrives.
 */
const refused: readonly unknown[] = [
  0,
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 1,
  1e300,
  "41/../x",
  "41",
  undefined,
  null,
];

for (const key of refused) {
  test(`the key ${String(key)} (${typeof key}) is refused before it becomes a path`, () => {
    assert.throws(
      () => episodeAt(worktree, key as number),
      (error: unknown) => {
        assert.ok(
          error instanceof EpisodeError,
          `refused with ${String(error)} rather than an EpisodeError`,
        );
        return true;
      },
    );
  });
}

test("the largest whole number a JavaScript number holds exactly is a key", () => {
  const episode = episodeAt(worktree, Number.MAX_SAFE_INTEGER);
  assert.equal(episode.directory, join(worktree, ".squiz", String(Number.MAX_SAFE_INTEGER)));
});

test("two subagents' firings on one pull request open the same episode", () => {
  // Nothing about the subagent reaches the key, so a second one that stops on the
  // same pull request in the same worktree reads and writes the first one's state.
  assert.deepEqual(episodeAt(worktree, number), episodeAt(worktree, number));
});

test("two pull requests in one worktree hold their state apart", () => {
  const one = episodeAt(worktree, 41);
  const other = episodeAt(worktree, 42);
  assert.notEqual(one.directory, other.directory);
  assert.notEqual(one.stateFile, other.stateFile);
});

test("one pull request in two worktrees is two episodes", () => {
  const other = join(sep, "worktrees", "feature-b");
  assert.notEqual(episodeAt(worktree, number).directory, episodeAt(other, number).directory);
});

test("a directory named as a key would spell it is that episode", () => {
  assert.deepEqual(episodeNamed(worktree, "41"), episodeAt(worktree, 41));
});

test("a directory no pull request's number spells is nobody's episode", () => {
  // A subagent's id is no key either, so state kept under one is not read.
  const names = ["a1e3196c5ad0f2410", "041", "0", "-1", "1.5", "1e3", " 41", "41 ", "9".repeat(17)];
  for (const name of names) {
    assert.equal(episodeNamed(worktree, name), undefined, `${JSON.stringify(name)} is an episode`);
  }
});
