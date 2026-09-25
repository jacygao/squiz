import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { type RoundCost, unspent } from "../reviewers/adapter.ts";
import { type EpisodeState, readState, recordRound, writeState } from "./episode-state.ts";
import { type Episode, episodeAt } from "./episode.ts";

const agentId = "a1e3196c5ad0f2410";

const firstRound: RoundCost = { dollars: 0.0031744240000000003, tokens: 6697, messages: 2 };
const secondRound: RoundCost = { dollars: 0.0142, tokens: 21043, messages: 7 };

/** A worktree of its own, holding one episode, removed when the test ends. */
function episodeIn(t: TestContext): Episode {
  const worktree = mkdtempSync(join(tmpdir(), "squiz-episode-"));
  t.after(() => rmSync(worktree, { recursive: true, force: true }));
  return episodeAt(worktree, agentId);
}

/** The reason the state file `contents` came back unreadable. */
function refusalOf(t: TestContext, contents: string): string {
  const episode = episodeIn(t);
  mkdirSync(episode.directory, { recursive: true });
  writeFileSync(episode.stateFile, contents);

  const read = readState(episode);
  if (read.outcome !== "unreadable") {
    assert.fail(
      `${JSON.stringify(contents)} was read as "${read.outcome}": a state file that cannot be read must not be read as a first round, which would restart the round count on every firing`,
    );
  }
  return read.reason;
}

test("state written comes back as it was written", (t) => {
  const episode = episodeIn(t);
  const state: EpisodeState = { pullRequest: 142, rounds: [firstRound, secondRound] };

  assert.deepEqual(writeState(episode, state), { outcome: "written" });
  assert.deepEqual(readState(episode), { outcome: "read", state });
});

test("the episode's directory is made by the write that needs it", (t) => {
  const episode = episodeIn(t);
  assert.deepEqual(writeState(episode, { pullRequest: 7, rounds: [] }), { outcome: "written" });
  assert.deepEqual(readdirSync(episode.directory), ["state.json"]);
});

test("a later round's state replaces the one before it", (t) => {
  const episode = episodeIn(t);
  writeState(episode, { pullRequest: 142, rounds: [firstRound] });
  const second: EpisodeState = { pullRequest: 142, rounds: [firstRound, secondRound] };
  writeState(episode, second);

  assert.deepEqual(readState(episode), { outcome: "read", state: second });
  // The new state is renamed over the old, and a half-written file reads as
  // unreadable, so what the rename was made from must not be left behind.
  assert.deepEqual(readdirSync(episode.directory), ["state.json"]);
});

test("a state file that was never written is a first round", (t) => {
  assert.deepEqual(readState(episodeIn(t)), { outcome: "absent" });
});

test("an episode directory holding no state file is a first round", (t) => {
  const episode = episodeIn(t);
  mkdirSync(episode.directory, { recursive: true });
  assert.deepEqual(readState(episode), { outcome: "absent" });
});

/**
 * Every file that is there and does not read back as state. The first is what a
 * write killed before it wrote anything leaves, and the rest are shapes a round
 * must not read figures out of.
 */
const unreadableContents: readonly string[] = [
  "",
  "{",
  "null",
  "[]",
  `"142"`,
  `{"rounds": []}`,
  `{"pullRequest": "142", "rounds": []}`,
  `{"pullRequest": 0, "rounds": []}`,
  `{"pullRequest": 1.5, "rounds": []}`,
  `{"pullRequest": 142}`,
  `{"pullRequest": 142, "rounds": {}}`,
  `{"pullRequest": 142, "rounds": [3]}`,
  `{"pullRequest": 142, "rounds": [{"dollars": 0.01, "tokens": 100}]}`,
  `{"pullRequest": 142, "rounds": [{"dollars": "0.01", "tokens": 100, "messages": 1}]}`,
  `{"pullRequest": 142, "rounds": [{"dollars": 0.01, "tokens": -1, "messages": 1}]}`,
];

for (const contents of unreadableContents) {
  test(`a state file holding ${JSON.stringify(contents)} is unreadable, not a first round`, (t) => {
    assert.ok(refusalOf(t, contents).includes("state.json"));
  });
}

test("a state file that is there and cannot be read at all is not read as absent", (t) => {
  const episode = episodeIn(t);
  // A directory in its place is the portable way to fail the read with
  // something other than ENOENT.
  mkdirSync(episode.stateFile, { recursive: true });

  const read = readState(episode);
  if (read.outcome !== "unreadable") {
    assert.fail(`a directory where the state file goes was read as "${read.outcome}"`);
  }
  assert.match(read.reason, /could not be read/u);
  assert.ok(read.reason.includes(episode.stateFile));
});

test("a write that cannot happen carries the error the filesystem gave", (t) => {
  const episode = episodeIn(t);
  // A file where the episodes directory goes is the portable way to make the
  // write fail: no directory can be created underneath it.
  writeFileSync(join(episode.worktree, ".squiz"), "");

  const written = writeState(episode, { pullRequest: 142, rounds: [firstRound] });
  if (written.outcome !== "failed") {
    assert.fail(`a write that cannot happen came back "${written.outcome}"`);
  }
  assert.ok(written.reason.includes(episode.stateFile));
  assert.match(
    written.reason,
    /ENOTDIR|EEXIST|not a directory|file exists/iu,
    `the reason has to name the underlying error, and it said: ${written.reason}`,
  );
});

test("a round's spend is appended, and the number of entries is the number of rounds", () => {
  const start: EpisodeState = { pullRequest: 142, rounds: [] };
  const afterTwo = recordRound(recordRound(start, firstRound), secondRound);

  assert.equal(start.rounds.length, 0, "the state a round was given must not change");
  assert.equal(afterTwo.pullRequest, 142);
  assert.deepEqual(afterTwo.rounds, [firstRound, secondRound]);
});

test("a round that spent nothing is still a round", (t) => {
  const episode = episodeIn(t);
  writeState(episode, recordRound({ pullRequest: 142, rounds: [] }, unspent));

  assert.deepEqual(readState(episode), {
    outcome: "read",
    state: { pullRequest: 142, rounds: [unspent] },
  });
});
