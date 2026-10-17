import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { type RoundCost, unspent } from "../reviewers/adapter.ts";
import {
  type EpisodeState,
  type RoundRecord,
  type RoundWork,
  type Timings,
  readState,
  recordRound,
  recordRulings,
  recordSpendOutsideRounds,
  recordUnpostedReplies,
  writeState,
} from "./episode-state.ts";
import { type Episode, episodeAt } from "./episode.ts";

const pullRequest = 41;

const firstCost: RoundCost = { dollars: 0.0031744240000000003, tokens: 6697, messages: 2 };
const secondCost: RoundCost = { dollars: 0.0142, tokens: 21043, messages: 7 };

/** What every round entry carries beside its cost. */
const ran: Timings & RoundWork = {
  reviewer: "pi",
  elapsedSeconds: 41.3,
  head: "3f9c2e0aa",
  raised: 0,
  ruled: { fixed: 0, withdrawn: 0, open: 0 },
};

const firstRound: RoundRecord = { ...firstCost, ...ran };
const secondRound: RoundRecord = { ...secondCost, ...ran, head: "1b86987bb" };

/** `ran` as the JSON of a round entry's fields, and no spend outside the rounds as the file's. */
const RAN = `"reviewer": "pi", "elapsedSeconds": 41.3, "head": "3f9c2e0aa", "raised": 0, "ruled": {"fixed": 0, "withdrawn": 0, "open": 0}`;
const NONE_OUTSIDE = `"spentOutsideRounds": {"dollars": 0, "tokens": 0, "messages": 0}`;

/** A worktree of its own, holding one episode, removed when the test ends. */
function episodeIn(t: TestContext): Episode {
  const worktree = mkdtempSync(join(tmpdir(), "squiz-episode-"));
  t.after(() => rmSync(worktree, { recursive: true, force: true }));
  return episodeAt(worktree, pullRequest);
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
  const state: EpisodeState = {
    rounds: [firstRound, secondRound],
    spentOutsideRounds: unspent,
  };

  assert.deepEqual(writeState(episode, state), { outcome: "written" });
  assert.deepEqual(readState(episode), { outcome: "read", state });
});

test("how long each round ran and posted, and the bound that cut one short, come back as written", (t) => {
  const episode = episodeIn(t);
  const state: EpisodeState = {
    rounds: [
      { ...firstRound, elapsedSeconds: 41.3 },
      { ...secondRound, elapsedSeconds: 480.2, cutShortAtSeconds: 480, postingSeconds: 4.3 },
    ],
    spentOutsideRounds: unspent,
  };

  assert.deepEqual(writeState(episode, state), { outcome: "written" });
  assert.deepEqual(readState(episode), { outcome: "read", state });
});

/** A floor read back as a total is a cost the reader takes as complete. */
test("what each round reviewed, raised and ruled comes back as written (#586)", (t) => {
  const episode = episodeIn(t);
  const state: EpisodeState = {
    rounds: [
      { ...firstRound, head: "3f9c2e0aa", raised: 3, ruled: { fixed: 0, withdrawn: 0, open: 0 } },
      {
        ...secondRound,
        head: "1b86987bb",
        raised: 0,
        ruled: { fixed: 2, withdrawn: 1, open: 0 },
        unpostedReplies: ["`src/queue.ts:134` — Retry backoff resets (ruled fixed, and the reviewer's reply could not be posted on its thread)"],
        unread: ["src/queue.ts", "docs/a file.md"],
      },
    ],
    spentOutsideRounds: unspent,
  };

  writeState(episode, state);
  assert.deepEqual(readState(episode), { outcome: "read", state });
});

test("a round's unposted replies are added to its own entry and no other (#586)", () => {
  const state: EpisodeState = { rounds: [firstRound, secondRound], spentOutsideRounds: unspent };
  const lines = ["`a.ts:1` — A (ruled fixed, and the reviewer's reply could not be posted on its thread)"];

  assert.deepEqual(recordUnpostedReplies(state, 2, lines).rounds, [
    firstRound,
    { ...secondRound, unpostedReplies: lines },
  ]);
  assert.deepEqual(recordUnpostedReplies(state, 2, []), state, "an empty list was written onto the round");
  assert.deepEqual(recordUnpostedReplies(state, 3, lines), state, "a round that does not exist was given lines");
});

test("a cost that is a floor comes back as a floor, in a round and outside the rounds", (t) => {
  const episode = episodeIn(t);
  const state: EpisodeState = {
    rounds: [firstRound, { ...secondRound, floor: true }],
    spentOutsideRounds: { ...firstCost, floor: true },
  };

  assert.deepEqual(writeState(episode, state), { outcome: "written" });
  assert.deepEqual(readState(episode), { outcome: "read", state });
});

test("AI credits come back as written, in a round and outside the rounds", (t) => {
  const episode = episodeIn(t);
  const state: EpisodeState = {
    rounds: [{ dollars: 0, tokens: 18_200, messages: 5, credits: 0.36, ...ran }],
    spentOutsideRounds: { dollars: 0, tokens: 900, messages: 1, credits: 0.02 },
  };

  assert.deepEqual(writeState(episode, state), { outcome: "written" });
  assert.deepEqual(readState(episode), { outcome: "read", state });
});

test("the reviewer and the models a round ran come back as written (#271)", (t) => {
  const episode = episodeIn(t);
  const state: EpisodeState = {
    rounds: [
      { ...firstRound, reviewer: "pi", models: ["deepseek/deepseek-v4-pro"] },
      { ...ran, dollars: 0, tokens: 18_200, messages: 5, models: ["gpt-5-mini", "claude-haiku-4.5"], reviewer: "copilot" },
      { ...ran, elapsedSeconds: 900.4, reviewer: "copilot" },
    ],
    spentOutsideRounds: unspent,
  };

  assert.deepEqual(writeState(episode, state), { outcome: "written" });
  assert.deepEqual(readState(episode), { outcome: "read", state });
});

/**
 * A round with no cost is written with no figures. Zeros would be read back as
 * a round that spent nothing, and summed into the spend line as one.
 */
test("a round with no cost is written with no figures and comes back with none", (t) => {
  const episode = episodeIn(t);
  const state: EpisodeState = {
    rounds: [firstRound, { ...ran, elapsedSeconds: 900.4, cutShortAtSeconds: 900 }],
    spentOutsideRounds: unspent,
  };

  assert.deepEqual(writeState(episode, state), { outcome: "written" });
  assert.deepEqual(readState(episode), { outcome: "read", state });
});

test("spend outside the rounds adds up AI credits with the rest", () => {
  const start: EpisodeState = { rounds: [], spentOutsideRounds: unspent };
  const after = recordSpendOutsideRounds(
    recordSpendOutsideRounds(start, { dollars: 0, tokens: 100, messages: 1, credits: 0.25 }),
    { dollars: 0, tokens: 100, messages: 1, credits: 0.5 },
  );
  assert.deepEqual(after.spentOutsideRounds, { dollars: 0, tokens: 200, messages: 2, credits: 0.75 });
});

test("spend outside the rounds is a floor once any of it is", () => {
  const start: EpisodeState = { rounds: [], spentOutsideRounds: unspent };
  const after = recordSpendOutsideRounds(
    recordSpendOutsideRounds(start, { ...firstCost, floor: true }),
    secondCost,
  );
  assert.equal(after.spentOutsideRounds.floor, true);
});

test("the episode's directory is made by the write that needs it", (t) => {
  const episode = episodeIn(t);
  assert.deepEqual(writeState(episode, { rounds: [], spentOutsideRounds: unspent }), { outcome: "written" });
  assert.deepEqual(readdirSync(episode.directory), ["state.json"]);
});

test("a later round's state replaces the one before it", (t) => {
  const episode = episodeIn(t);
  writeState(episode, { rounds: [firstRound], spentOutsideRounds: unspent });
  const second: EpisodeState = {
    rounds: [firstRound, secondRound],
    spentOutsideRounds: unspent,
  };
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
  `{}`,
  `{"rounds": {}}`,
  `{"rounds": [3], ${NONE_OUTSIDE}}`,
  `{"rounds": [{${RAN}, "dollars": 0.01, "tokens": 100}], ${NONE_OUTSIDE}}`,
  `{"rounds": [{${RAN}, "dollars": "0.01", "tokens": 100, "messages": 1}], ${NONE_OUTSIDE}}`,
  `{"rounds": [{${RAN}, "dollars": 0.01, "tokens": -1, "messages": 1}], ${NONE_OUTSIDE}}`,
  // A floor that is there and cannot be read must not stand in for a total.
  `{"rounds": [{${RAN}, "dollars": 0.01, "tokens": 100, "messages": 1, "floor": false}], ${NONE_OUTSIDE}}`,
  `{"rounds": [{${RAN}, "dollars": 0.01, "tokens": 100, "messages": 1, "floor": "true"}], ${NONE_OUTSIDE}}`,
  // Credits that are there and cannot be read must not be dropped, and a round
  // with no cost carries no figure of any kind.
  `{"rounds": [{${RAN}, "dollars": 0, "tokens": 100, "messages": 1, "credits": "0.36"}], ${NONE_OUTSIDE}}`,
  `{"rounds": [{${RAN}, "dollars": 0, "tokens": 100, "messages": 1, "credits": -1}], ${NONE_OUTSIDE}}`,
  `{"rounds": [{${RAN}, "credits": 0.36}], ${NONE_OUTSIDE}}`,
  `{"rounds": [{${RAN}, "floor": true}], ${NONE_OUTSIDE}}`,
  `{"rounds": [{${RAN}, "tokens": 100, "messages": 1}], ${NONE_OUTSIDE}}`,
  `{"rounds": [], "spentOutsideRounds": {}}`,
  // A spend that is there and cannot be read must not stand in for zero: the
  // token bound would then let the episode spend past a bound it had reached.
  `{"rounds": [], "spentOutsideRounds": 0.04}`,
  `{"rounds": [], "spentOutsideRounds": {"dollars": 0.04}}`,
  `{"rounds": [], "spentOutsideRounds": {"dollars": "0.04", "tokens": 1, "messages": 1}}`,
  // A close that is there and cannot be read is neither yes nor no. Read as no,
  // the next firing announces a missing summary for an episode carrying one; read
  // as yes, it closes the episode in silence.
  `{"rounds": [], "closeReported": "true", ${NONE_OUTSIDE}}`,
  `{"rounds": [], "closeReported": 1, ${NONE_OUTSIDE}}`,
  // How long a round ran and posted, and the bound that cut it short, are the measurements a
  // later reading takes from this file. A figure that is there and cannot be read
  // would be a measurement nobody took.
  `{"rounds": [{${RAN}, "dollars": 0.01, "tokens": 100, "messages": 1, "elapsedSeconds": "12"}], ${NONE_OUTSIDE}}`,
  `{"rounds": [{${RAN}, "dollars": 0.01, "tokens": 100, "messages": 1, "elapsedSeconds": -1}], ${NONE_OUTSIDE}}`,
  `{"rounds": [{${RAN}, "dollars": 0.01, "tokens": 100, "messages": 1, "cutShortAtSeconds": 0}], ${NONE_OUTSIDE}}`,
  `{"rounds": [{${RAN}, "dollars": 0.01, "tokens": 100, "messages": 1, "cutShortAtSeconds": 2.5}], ${NONE_OUTSIDE}}`,
  `{"rounds": [{${RAN}, "dollars": 0.01, "tokens": 100, "messages": 1, "cutShortAtSeconds": true}], ${NONE_OUTSIDE}}`,
  `{"rounds": [{${RAN}, "dollars": 0.01, "tokens": 100, "messages": 1, "postingSeconds": "4"}], ${NONE_OUTSIDE}}`,
  `{"rounds": [{${RAN}, "dollars": 0.01, "tokens": 100, "messages": 1, "postingSeconds": -1}], ${NONE_OUTSIDE}}`,
  // A reviewer or a model that is there and cannot be read would be named in
  // the summary as one nobody recorded.
  `{"rounds": [{${RAN}, "dollars": 0.01, "tokens": 100, "messages": 1, "reviewer": "claude"}], ${NONE_OUTSIDE}}`,
  `{"rounds": [{${RAN}, "dollars": 0.01, "tokens": 100, "messages": 1, "models": "gpt-5-mini"}], ${NONE_OUTSIDE}}`,
  `{"rounds": [{${RAN}, "dollars": 0.01, "tokens": 100, "messages": 1, "models": []}], ${NONE_OUTSIDE}}`,
  `{"rounds": [{${RAN}, "dollars": 0.01, "tokens": 100, "messages": 1, "models": [""]}], ${NONE_OUTSIDE}}`,
  `{"rounds": [{${RAN}, "dollars": 0.01, "tokens": 100, "messages": 1, "models": [" "]}], ${NONE_OUTSIDE}}`,
  `{"rounds": [{${RAN}, "dollars": 0.01, "tokens": 100, "messages": 1, "models": [7]}], ${NONE_OUTSIDE}}`,
  // A model is named only by the spend it was reported against.
  `{"rounds": [{${RAN}, "models": ["gpt-5-mini"]}], ${NONE_OUTSIDE}}`,
  // What a round reviewed and ruled is what the summary lists it by, and a
  // figure that is there and cannot be read would list a round nobody ran.
  `{"rounds": [{${RAN}, "dollars": 0.01, "tokens": 100, "messages": 1, "head": ""}], ${NONE_OUTSIDE}}`,
  `{"rounds": [{${RAN}, "dollars": 0.01, "tokens": 100, "messages": 1, "raised": -1}], ${NONE_OUTSIDE}}`,
  `{"rounds": [{${RAN}, "dollars": 0.01, "tokens": 100, "messages": 1, "ruled": {"fixed": 1, "withdrawn": 0}}], ${NONE_OUTSIDE}}`,
  `{"rounds": [{${RAN}, "dollars": 0.01, "tokens": 100, "messages": 1, "ruled": {"fixed": 1, "withdrawn": 0, "open": "2"}}], ${NONE_OUTSIDE}}`,
  `{"rounds": [{${RAN}, "dollars": 0.01, "tokens": 100, "messages": 1, "unpostedReplies": "a line"}], ${NONE_OUTSIDE}}`,
  `{"rounds": [{${RAN}, "dollars": 0.01, "tokens": 100, "messages": 1, "unpostedReplies": [3]}], ${NONE_OUTSIDE}}`,
  `{"rounds": [{${RAN}, "dollars": 0.01, "tokens": 100, "messages": 1, "unread": "src/a.ts"}], ${NONE_OUTSIDE}}`,
  `{"rounds": [{${RAN}, "dollars": 0.01, "tokens": 100, "messages": 1, "unread": [""]}], ${NONE_OUTSIDE}}`,
  // A record dropped on reading is a state with no record, which a trigger queues
  // again, or a queued state that no round host ever takes.
  `{"rounds": [], "records": {}, ${NONE_OUTSIDE}}`,
  `{"rounds": [], "records": [3], ${NONE_OUTSIDE}}`,
  `{"rounds": [], "records": [{"head": "3f9c2e0", "activity": null, "status": "postponed"}], ${NONE_OUTSIDE}}`,
  `{"rounds": [], "records": [{"head": "3f9c2e0", "status": "queued"}], ${NONE_OUTSIDE}}`,
  // A ruling dropped or guessed on reading is a withdrawn finding counted some
  // other way by a close that runs no reviewer.
  `{"rounds": [], "rulings": [], ${NONE_OUTSIDE}}`,
  `{"rounds": [], "rulings": {"PRRT_a": "resolved"}, ${NONE_OUTSIDE}}`,
  `{"rounds": [], "rulings": {"PRRT_a": null}, ${NONE_OUTSIDE}}`,
  // Two records for one state leave no telling which of them is true.
  `{"rounds": [], "records": [{"head": "3f9c2e0", "activity": null, "status": "queued"}, {"head": "3f9c2e0", "activity": null, "status": "failed", "reason": "r", "ownerNoted": true}], ${NONE_OUTSIDE}}`,
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

  const written = writeState(episode, {
    rounds: [firstRound],
    spentOutsideRounds: unspent,
  });
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
  const start: EpisodeState = { rounds: [], spentOutsideRounds: unspent };
  const afterTwo = recordRound(recordRound(start, firstRound), secondRound);

  assert.equal(start.rounds.length, 0, "the state a round was given must not change");
  assert.deepEqual(afterTwo.rounds, [firstRound, secondRound]);
});

test("a round that spent nothing is still a round", (t) => {
  const episode = episodeIn(t);
  const start: EpisodeState = { rounds: [], spentOutsideRounds: unspent };
  writeState(episode, recordRound(start, { ...unspent, ...ran }));

  assert.deepEqual(readState(episode), {
    outcome: "read",
    state: { rounds: [{ ...unspent, ...ran }], spentOutsideRounds: unspent },
  });
});

/**
 * The two figures are two ledgers, and this is the one the cap does not count.
 * An attempt can complete a paid response and still end as something that is no
 * round, and the money it spent has to survive that.
 */
test("spend recorded outside the rounds does not move the round count", () => {
  const start: EpisodeState = { rounds: [firstRound], spentOutsideRounds: unspent };
  const after = recordSpendOutsideRounds(recordSpendOutsideRounds(start, firstCost), secondCost);

  assert.equal(after.rounds.length, 1, "no round was run, so the cap has nothing more to spend");
  assert.deepEqual(after.spentOutsideRounds, {
    dollars: firstCost.dollars + secondCost.dollars,
    tokens: firstCost.tokens + secondCost.tokens,
    messages: firstCost.messages + secondCost.messages,
  });
  assert.deepEqual(start.spentOutsideRounds, unspent, "the state it was given must not change");
});

test("a reported close is written and comes back, and one never written is absent", (t) => {
  const episode = episodeIn(t);
  const closed: EpisodeState = {
    rounds: [firstRound],
    spentOutsideRounds: unspent,
    closeReported: true,
  };

  assert.deepEqual(writeState(episode, closed), { outcome: "written" });
  assert.deepEqual(readState(episode), { outcome: "read", state: closed });

  // A file with no close says it was never reported, which is the answer that
  // has the next firing announce the missing summary.
  writeFileSync(episode.stateFile, `{"rounds": [], ${NONE_OUTSIDE}}`);
  const read = readState(episode);
  assert.equal(read.outcome === "read" ? read.state.closeReported : "unread", undefined);
});

test("the reviewer's last ruling on each thread is written and comes back, and a file with none reads with none", (t) => {
  const episode = episodeIn(t);
  const ruled: EpisodeState = {
    rounds: [firstRound],
    spentOutsideRounds: unspent,
    rulings: { PRRT_argued: "withdrawn", PRRT_mended: "fixed", PRRT_kept: "open" },
  };

  assert.deepEqual(writeState(episode, ruled), { outcome: "written" });
  assert.deepEqual(readState(episode), { outcome: "read", state: ruled });

  writeFileSync(episode.stateFile, `{"rounds": [], ${NONE_OUTSIDE}}`);
  const read = readState(episode);
  assert.equal(read.outcome === "read" ? read.state.rulings : "unread", undefined);
});

test("a ruling replaces the one before it on its thread, and leaves the others", () => {
  const before: EpisodeState = { rounds: [], spentOutsideRounds: unspent, rulings: { PRRT_a: "open", PRRT_b: "fixed" } };
  assert.deepEqual(recordRulings(before, { PRRT_a: "withdrawn" }).rulings, { PRRT_a: "withdrawn", PRRT_b: "fixed" });
});

test("the record for each state of the pull request is written and comes back", (t) => {
  const episode = episodeIn(t);
  const state: EpisodeState = {
    rounds: [firstRound],
    spentOutsideRounds: unspent,
    records: [
      {
        head: "3f9c2e0",
        activity: null,
        status: "reviewed",
        result: "clean, episode open",
        round: { number: 1, startedAt: 1_790_999_000, endedAt: 1_790_999_400, reviewer: { backend: "detached" } },
        newFindings: 0,
      },
      {
        head: "8d21a4f",
        activity: "PRRC_kwDOL7tYbc6OmQx7a",
        status: "reviewing",
        owner: { sessionId: "60517e1f-e1dc-49b1-8e39-6fcbe686f3fb", subagent: "a402ef8f56c1b2ed1" },
        host: { pid: 4012, startedAt: 1_791_000_000 },
        round: { number: 2 },
      },
      { head: "9e01b2c", activity: "PRRC_kwDOL7tYbc6OmQx7a", status: "queued" },
    ],
  };

  assert.deepEqual(writeState(episode, state), { outcome: "written" });
  assert.deepEqual(readState(episode), { outcome: "read", state });
});

test("a record that cannot be read is named by its place in the file and what is wrong with it", (t) => {
  const reason = refusalOf(
    t,
    `{"rounds": [], "records": [{"head": "3f9c2e0", "activity": null, "status": "queued"}, {"head": "8d21a4f", "activity": null, "status": "postponed"}], ${NONE_OUTSIDE}}`,
  );
  assert.match(reason, /record 2 has "status" as "postponed"/u);
});

for (const field of ["reviewer", "elapsedSeconds", "head", "raised", "ruled"] as const) {
  test(`a round with no "${field}" is refused, and the refusal names it`, (t) => {
    const { [field]: _missing, ...rest } = firstRound;
    const reason = refusalOf(t, JSON.stringify({ rounds: [rest], spentOutsideRounds: unspent }));
    assert.match(reason, new RegExp(`round 1 has "${field}"`, "u"));
  });
}

test("a state file with no spend outside its rounds is refused, and the refusal names it", (t) => {
  assert.match(refusalOf(t, `{"rounds": []}`), /"spentOutsideRounds"/u);
});
