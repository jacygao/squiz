import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { unspent } from "../reviewers/adapter.ts";
import { LOCAL_KEY, localVenue } from "../venues/local/venue.ts";
import { archiveEpisode, archivedEpisodes } from "./archive.ts";
import { readState, writeState, type EpisodeState } from "./episode-state.ts";
import { episodeAt, type Episode } from "./episode.ts";

const CLOSED: EpisodeState = {
  rounds: [{ reviewer: "pi", elapsedSeconds: 3, head: "3f9c2e0aa", raised: 0, ruled: { fixed: 0, withdrawn: 0, open: 0 } }],
  spentOutsideRounds: unspent,
  closeReported: true,
  cleanClose: { head: "3f9c2e0aa", activity: null, records: 1 },
  records: [
    {
      head: "3f9c2e0aa",
      activity: null,
      status: "reviewed",
      result: "exited",
      exitStatus: 0,
      openThreads: [],
      round: { number: 1, startedAt: 1_790_999_000, endedAt: 1_790_999_400, reviewer: { backend: "detached" } },
      newFindings: 0,
    },
  ],
};

/** A local venue's `.squiz/local/` after one closed round, holding the worktree's own files beside the episode's. */
function closedLocalEpisode(t: TestContext): Episode {
  const worktree = realpathSync(mkdtempSync(join(tmpdir(), "squiz-archive-")));
  t.after(() => rmSync(worktree, { recursive: true, force: true }));
  const found = episodeAt(localVenue, worktree, LOCAL_KEY);
  assert.equal(found.outcome, "found");
  const episode = found.outcome === "found" ? found.episode : assert.fail("no episode");
  const at = (...path: string[]): string => join(episode.directory, ...path);
  assert.equal(writeState(episode, CLOSED).outcome, "written");
  mkdirSync(at("rounds", "1", "session"), { recursive: true });
  writeFileSync(at("rounds", "1", "prompt.md"), "the task\n");
  writeFileSync(at("rounds", "1", "resume.txt"), "pi --session-dir .squiz/local/rounds/1/session --session 0193f2c4\n");
  writeFileSync(at("summary.md"), "the summary\n");
  writeFileSync(at("base.json"), `{"commit": "7c1e0d3", "branches": []}\n`);
  mkdirSync(at("objects", "ab"), { recursive: true });
  writeFileSync(at("objects", "ab", "cdef"), "an object");
  writeFileSync(at("threads.json"), `{"threads": []}\n`);
  writeFileSync(at("failure-1.md"), "a failure\n");
  writeFileSync(at("host.log"), "a line\n");
  mkdirSync(at("notes", "60517e1f"), { recursive: true });
  writeFileSync(at("notes", "60517e1f", "1.note"), "to=60517e1f\n");
  return episode;
}

test("#832: archiving a closed episode moves its state, rounds and summary under episodes/1/, and leaves the worktree's own files where they were", (t) => {
  const episode = closedLocalEpisode(t);
  const at = (...path: string[]): string => join(episode.directory, ...path);

  const archived = archiveEpisode(episode, CLOSED);

  assert.deepEqual(archived, { outcome: "archived", directory: at("episodes", "1") });
  assert.deepEqual(readState({ ...episode, directory: at("episodes", "1"), stateFile: at("episodes", "1", "state.json") }), { outcome: "read", state: CLOSED });
  assert.equal(readFileSync(at("episodes", "1", "rounds", "1", "prompt.md"), "utf8"), "the task\n");
  assert.equal(readFileSync(at("episodes", "1", "summary.md"), "utf8"), "the summary\n");
  assert.ok(!existsSync(at("rounds")), "the closed episode's rounds were left where the new episode's round 1 goes");
  assert.ok(!existsSync(at("summary.md")), "the closed episode's summary was left where the new episode's goes");
  for (const kept of ["base.json", join("objects", "ab", "cdef"), "threads.json", "failure-1.md", "host.log", join("notes", "60517e1f", "1.note")]) {
    assert.ok(existsSync(at(kept)), `${kept} belongs to the worktree, and archiving lost it`);
  }
});

test("#803: archiving a closed episode moves its closed.json with it, so a caller waiting on the next episode's never reads the last one's", (t) => {
  const episode = closedLocalEpisode(t);
  const at = (...path: string[]): string => join(episode.directory, ...path);
  const close = `{"head": "3f9c2e0aa", "exitStatus": 0, "openThreads": []}\n`;
  writeFileSync(at("closed.json"), close);

  archiveEpisode(episode, CLOSED);

  assert.ok(!existsSync(at("closed.json")), "the closed episode's closed.json was left where the new episode's goes");
  assert.equal(readFileSync(at("episodes", "1", "closed.json"), "utf8"), close);
});

test("#832: an archived round's resume command names the session where the archive put it", (t) => {
  const episode = closedLocalEpisode(t);

  archiveEpisode(episode, CLOSED);

  assert.equal(
    readFileSync(join(episode.directory, "episodes", "1", "rounds", "1", "resume.txt"), "utf8"),
    "pi --session-dir .squiz/local/episodes/1/rounds/1/session --session 0193f2c4\n",
  );
});

test("#832: each closed episode is archived under the next number, and the archives list oldest first", (t) => {
  const episode = closedLocalEpisode(t);
  assert.equal(archiveEpisode(episode, CLOSED).outcome, "archived");
  mkdirSync(join(episode.directory, "rounds", "1"), { recursive: true });
  const second: EpisodeState = { ...CLOSED, cleanClose: { head: "1b86987bb", activity: null, records: 1 } };

  assert.deepEqual(archiveEpisode(episode, second), { outcome: "archived", directory: join(episode.directory, "episodes", "2") });

  const found = archivedEpisodes(episode);
  const listed = found.outcome === "listed" ? found.episodes : assert.fail(found.reason);
  assert.deepEqual(listed.map((archive) => archive.directory), [join(episode.directory, "episodes", "1"), join(episode.directory, "episodes", "2")]);
  assert.deepEqual(listed.map((archive) => archive.key), [LOCAL_KEY, LOCAL_KEY]);
  assert.deepEqual(readState(listed[1] ?? assert.fail("no second archive")), { outcome: "read", state: second });
});

test("#832: an episode never archived lists no archives", (t) => {
  const episode = closedLocalEpisode(t);
  assert.deepEqual(archivedEpisodes(episode), { outcome: "listed", episodes: [] });
});

test("#832: archives that cannot be listed are a failure, never no archives", (t) => {
  const episode = closedLocalEpisode(t);
  writeFileSync(join(episode.directory, "episodes"), "not a directory");

  const listed = archivedEpisodes(episode);

  assert.equal(listed.outcome, "failed", "an unreadable archive directory read as none would hide every closed episode");
  assert.match(listed.outcome === "failed" ? listed.reason : "", /episodes could not be listed: ENOTDIR/u);
});
