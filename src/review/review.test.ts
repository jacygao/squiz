/**
 * `squiz review`'s wait, driven against a real state file in a real git work
 * tree. The trigger is a stand-in, so each test decides what the trigger found,
 * and the test then writes the records a round host would, while the run polls.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { renderComment } from "../findings/comment.ts";
import type { Change, ReviewThread, Venue } from "../venues/venue.ts";
import type { HostStart, Triggered, TriggerRequest } from "../host/trigger.ts";
import { archiveEpisode } from "../loop/archive.ts";
import { readState, writeState, type EpisodeState, type RoundRecord } from "../loop/episode-state.ts";
import { episodeAt, type Episode } from "../loop/episode.ts";
import { githubEpisode } from "../testing/episode.ts";
import type { StateKey, StateRecord } from "../loop/state-record.ts";
import type { TriggerDecision } from "../loop/trigger-decision.ts";
import { deadlineIn, type Deadline } from "../reviewers/deadline.ts";
import { githubVenue } from "../venues/github/venue.ts";
import { LOCAL_KEY, localVenue } from "../venues/local/venue.ts";
import type { Printed } from "./output.ts";
import { runReview, type ReviewRequest } from "./review.ts";

const NUMBER = 41;
const OWN: StateKey = { head: "3f9c2e0a1b2c3d4e5f60718293a4b5c6d7e8f901", activity: null };
const LATER: StateKey = { head: "8d21a4f6c3b9e0d7a5f2c8b1e4d9a6c3f7b0e258", activity: null };
const POLL_MS = 20;
const NO_COST = { dollars: 0, tokens: 0, messages: 0 };

/** A round that spent nothing, raised nothing and ruled on nothing. */
const ROUND: RoundRecord = {
  ...NO_COST,
  reviewer: "pi",
  elapsedSeconds: 1,
  head: OWN.head,
  raised: 0,
  ruled: { fixed: 0, withdrawn: 0, open: 0 },
};

/** Round `number` of a reviewed record, run by a detached reviewer. */
const ran = (number: number) => ({ number, startedAt: 1, endedAt: 2, reviewer: { backend: "detached" as const } });

const OPEN_THREAD: ReviewThread = {
  id: "PRRT_kwDOL7tYbc5abcd1",
  isResolved: false,
  isOutdated: false,
  path: "packages/sync/src/queue.ts",
  anchor: { at: "line", line: 134 },
  comments: [
    {
      id: "PRRC_1",
      databaseId: 1,
      author: "squiz",
      createdAt: "2026-10-05T07:13:05Z",
      body: renderComment({
        scope: "line",
        file: "packages/sync/src/queue.ts",
        line: 134,
        severity: "high",
        headline: "Retry backoff resets on every enqueue",
        reasoning: ["`enqueue()` calls `resetBackoff()` on every call."],
        suggestedFix: "reset the backoff only when the queue was empty.",
      }),
    },
  ],
};

type Fixture = { readonly worktree: string; readonly episode: Episode };

/** PR #41 as the GitHub venue reads it, at the run's own head. */
const CHANGE: Change = {
  key: String(NUMBER),
  name: `PR #${NUMBER}`,
  rerun: `squiz review ${NUMBER}`,
  summaryAt: "on the pull request",
  followUp: [
    "Fix what applies, and reply on each thread with `squiz reply <id> <text>` to say",
    "what you changed or why you disagree. Commit and push what you changed, then run",
    `\`squiz review ${NUMBER}\` again.`,
  ].join("\n"),
  base: "7c1e0d3f2a4b5c6d7e8f90a1b2c3d4e5f6a7b8c9",
  head: OWN.head,
  description: "",
};

/** A repository with a `.squiz.json` of its own, so that no run adds the line saying the defaults are in use. */
async function withWorktree(body: (fixture: Fixture) => Promise<void>): Promise<void> {
  // Real paths, because git answers the toplevel with symlinks resolved.
  const worktree = realpathSync(mkdtempSync(join(tmpdir(), "squiz-review-")));
  try {
    const made = spawnSync("git", ["init", "--quiet", "--initial-branch", "feature-a"], { cwd: worktree });
    assert.equal(made.status, 0);
    writeFileSync(join(worktree, ".squiz.json"), "{}");
    await body({ worktree, episode: githubEpisode(worktree, NUMBER) });
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
}

/**
 * A worktree made by `git worktree add`, holding `linkedSquizJson` as its own
 * `.squiz.json`, beside a main worktree holding `mainSquizJson`, or none where
 * it is null.
 */
async function withLinkedWorktree(
  mainSquizJson: string | null,
  linkedSquizJson: string,
  body: (fixture: Fixture & { readonly main: string }) => Promise<void>,
): Promise<void> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "squiz-review-linked-")));
  const main = join(base, "main");
  const worktree = join(base, "linked");
  try {
    mkdirSync(main);
    for (const args of [
      ["init", "--quiet", "--initial-branch", "main"],
      ["commit", "--quiet", "--allow-empty", "-m", "first"],
      ["worktree", "add", "--quiet", "-b", "feature-a", worktree],
    ]) {
      const ran = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: main, encoding: "utf8" });
      assert.equal(ran.status, 0, ran.stderr);
    }
    if (mainSquizJson !== null) writeFileSync(join(main, ".squiz.json"), mainSquizJson);
    writeFileSync(join(worktree, ".squiz.json"), linkedSquizJson);
    await body({ worktree, main, episode: githubEpisode(worktree, NUMBER) });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function records(fixture: Fixture, held: readonly StateRecord[], more: Partial<EpisodeState> = {}): void {
  const written = writeState(fixture.episode, { rounds: [], spentOutsideRounds: NO_COST, records: held, ...more });
  assert.equal(written.outcome, "written", "the fixture's state file must be written");
}

function decided(
  fixture: Fixture,
  decision: TriggerDecision,
  threads: readonly ReviewThread[] = [],
  host: HostStart = { outcome: "not started" },
): Triggered {
  return {
    outcome: "decided",
    change: CHANGE,
    episode: fixture.episode,
    state: OWN,
    threads,
    decision,
    queued: decision.outcome === "queue",
    host,
  };
}

type Run = {
  readonly triggered: Triggered;
  readonly until?: Deadline;
  readonly threads?: readonly ReviewThread[];
};

function request(fixture: Fixture, run: Run, handed: TriggerRequest[] = []): ReviewRequest {
  return {
    directory: fixture.worktree,
    key: String(NUMBER),
    environment: {},
    until: run.until ?? deadlineIn(10_000),
    pollMs: POLL_MS,
    trigger: (asked) => {
      handed.push(asked);
      return run.triggered;
    },
    venue: venueListing(() => ({ outcome: "listed", threads: run.threads ?? [] })),
  };
}

/**
 * A venue whose `listThreads` is `listThreads`, and which names the GitHub
 * venue's episode directory. The trigger is a stand-in, so those are the only
 * members a run reaches, and every other member throws.
 */
function venueListing(listThreads: Venue["listThreads"]): Venue {
  const unreached = (): never => {
    throw new Error("the run reached a venue member other than listThreads and episodeDirectory");
  };
  return {
    recordStart: unreached,
    readChange: unreached,
    episodeDirectory: githubVenue.episodeDirectory,
    provideCommits: unreached,
    listThreads,
    openThread: unreached,
    openFileThread: unreached,
    reply: unreached,
    resolve: unreached,
    reopen: unreached,
    postSummary: unreached,
    postFailure: unreached,
  };
}

const queued = (key: StateKey): StateRecord => ({ ...key, status: "queued" });
const reviewing = (key: StateKey): StateRecord => ({ ...key, status: "reviewing", host: { pid: 4242, startedAt: 1 }, round: { number: 1 } });
const PATH_LINE = (fixture: Fixture): string => `Full output, to read where this is cut short: ${join(fixture.episode.directory, "review.txt")}`;

test("a round that ends after a few polls is the run's result, with its threads as they stand now", async () => {
  await withWorktree(async (fixture) => {
    records(fixture, [queued(OWN)]);
    const finished = (async () => {
      await sleep(POLL_MS * 3);
      records(fixture, [reviewing(OWN)]);
      await sleep(POLL_MS * 3);
      records(fixture, [
        { ...OWN, status: "reviewed", result: "exited", exitStatus: 2, openThreads: [OPEN_THREAD.id], newFindings: 1, round: { number: 1, startedAt: 1, endedAt: 2, reviewer: { backend: "detached" } } },
      ], { rounds: [ROUND] });
    })();

    const printed = await runReview(request(fixture, { triggered: decided(fixture, { outcome: "queue", startHost: false }), threads: [OPEN_THREAD] }));
    await finished;

    assert.equal(printed.exit, 2, printed.stderr);
    const lines = printed.stdout.split("\n");
    assert.equal(lines[0], PATH_LINE(fixture));
    assert.equal(lines[1], "Squiz reviewed PR #41 at 3f9c2e0: round 1 of 3, 1 new finding.");
    assert.match(printed.stdout, /^PRRT_kwDOL7tYbc5abcd1 packages\/sync\/src\/queue.ts:134 high — Retry backoff resets on every enqueue$/mu);
    assert.equal(printed.stderr, "");
  });
});

test("open threads end with the follow-up the venue's change carries", async () => {
  await withWorktree(async (fixture) => {
    records(fixture, [
      { ...OWN, status: "reviewed", result: "exited", exitStatus: 2, openThreads: [OPEN_THREAD.id], newFindings: 1, round: ran(1) },
    ], { rounds: [ROUND] });
    const followUp = "Fix what applies in /work/squiz-a, then run `(cd '/work/squiz-a' && squiz review)` again.";
    const triggered = decided(fixture, { outcome: "in-hand" });
    const withFollowUp = { ...triggered, change: { ...CHANGE, followUp } };

    const printed = await runReview(request(fixture, { triggered: withFollowUp, threads: [OPEN_THREAD] }));

    assert.equal(printed.exit, 2, printed.stderr);
    assert.ok(printed.stdout.endsWith(`\n\n${followUp}\n`), `the output does not end with the change's follow-up:\n${printed.stdout}`);
  });
});

test("the run's deadline is the trigger's, so the gate and the listing count against it", async () => {
  await withWorktree(async (fixture) => {
    records(fixture, [{ ...OWN, status: "reviewed", result: "exited", exitStatus: 0, openThreads: [], newFindings: 0, round: ran(1) }], { closeReported: true, rounds: [ROUND] });
    const handed: TriggerRequest[] = [];
    const until = deadlineIn(10_000);

    await runReview(request(fixture, { triggered: decided(fixture, { outcome: "result" }), until }, handed));

    assert.equal(handed.length, 1);
    assert.equal(handed[0]?.until, until);
    assert.equal(handed[0]?.trigger, "review");
    assert.equal(handed[0]?.key, String(NUMBER));
  });
});

test("a state already reviewed is returned at once, as a result the run did not produce", async () => {
  await withWorktree(async (fixture) => {
    records(fixture, [
      { ...OWN, status: "reviewed", result: "exited", exitStatus: 2, openThreads: [OPEN_THREAD.id], newFindings: 1, round: { number: 1, startedAt: 1, endedAt: 2, reviewer: { backend: "detached" } } },
    ], { rounds: [ROUND] });
    const started = Date.now();

    const printed = await runReview(request(fixture, { triggered: decided(fixture, { outcome: "result" }, [OPEN_THREAD]) }));

    assert.equal(printed.exit, 2);
    assert.equal(printed.stdout.split("\n")[1], "Squiz already reviewed PR #41 at 3f9c2e0: round 1 of 3, 1 new finding.");
    assert.ok(Date.now() - started < 2_000, "a recorded result was waited for");
  });
});

const ALREADY_REVIEWED: StateRecord = {
  ...OWN,
  status: "reviewed",
  result: "exited",
  exitStatus: 2,
  openThreads: [OPEN_THREAD.id],
  newFindings: 1,
  round: { number: 1, startedAt: 1, endedAt: 2, reviewer: { backend: "detached" } },
};

test("#745: a linked worktree takes the round cap from the main worktree's .squiz.json, never its own", async () => {
  await withLinkedWorktree('{"reviewer": "copilot", "rounds": 5}', '{"reviewer": "pi", "rounds": 2}', async (fixture) => {
    records(fixture, [ALREADY_REVIEWED], { rounds: [ROUND] });

    const printed = await runReview(request(fixture, { triggered: decided(fixture, { outcome: "result" }, [OPEN_THREAD]) }));

    assert.equal(printed.exit, 2, printed.stderr);
    assert.equal(printed.stdout.split("\n")[1], "Squiz already reviewed PR #41 at 3f9c2e0: round 1 of 5, 1 new finding.");
    assert.equal(printed.stderr, "");
  });
});

test("#745: a run whose main worktree has no .squiz.json says on stderr that the defaults are in use, and keeps its outcome", async () => {
  await withLinkedWorktree(null, '{"reviewer": "copilot", "rounds": 5}', async (fixture) => {
    records(fixture, [ALREADY_REVIEWED], { rounds: [ROUND] });

    const printed = await runReview(request(fixture, { triggered: decided(fixture, { outcome: "result" }, [OPEN_THREAD]) }));

    assert.equal(printed.exit, 2);
    assert.equal(printed.stdout.split("\n")[1], "Squiz already reviewed PR #41 at 3f9c2e0: round 1 of 3, 1 new finding.");
    assert.equal(printed.stderr, `squiz: no .squiz.json was found in the main worktree, ${fixture.main}, so the defaults are in use\n`);
  });
});

test("#838: a run given no venue takes it from the main worktree's .squiz.json, never its own, and not from SQUIZ_VENUE", async () => {
  await withLinkedWorktree('{"venue": "local"}', '{"venue": "github"}', async (fixture) => {
    const { venue: _, ...unchosen } = request(fixture, { triggered: decided(fixture, { outcome: "result" }) });

    const printed = await runReview({ ...unchosen, environment: { SQUIZ_VENUE: "github" } });

    assert.equal(printed.exit, 1);
    assert.equal(
      printed.stderr,
      "squiz: no review ran: the local venue reviews the working tree, and takes no pull request number\n" +
        "squiz: put these lines in your report rather than running squiz review again\n",
      "the local venue, which refuses a pull request's number, was not the one chosen",
    );
  });
});

test("a newer state reviewed while the run waits is not the run's result, and the run exits 4 at its deadline", async () => {
  await withWorktree(async (fixture) => {
    records(fixture, [
      reviewing(OWN),
      { ...LATER, status: "reviewed", result: "exited", exitStatus: 0, openThreads: [], newFindings: 0, round: ran(2) },
    ], { closeReported: false });

    const printed = await runReview(request(fixture, { triggered: decided(fixture, { outcome: "in-hand" }), until: deadlineIn(POLL_MS * 5) }));

    assert.equal(printed.exit, 4, printed.stdout + printed.stderr);
    assert.equal(
      printed.stdout,
      `${PATH_LINE(fixture)}\nSquiz is still reviewing PR #41 at 3f9c2e0. Run \`squiz review 41\` again to wait for it.\n`,
    );
  });
});

test("a run whose state waits behind another's round exits 4 naming both", async () => {
  await withWorktree(async (fixture) => {
    records(fixture, [reviewing(LATER), queued(OWN)]);

    const printed = await runReview(request(fixture, { triggered: decided(fixture, { outcome: "queue", startHost: false }), until: deadlineIn(POLL_MS * 5) }));

    assert.equal(printed.exit, 4);
    assert.equal(
      printed.stdout.split("\n")[1],
      "Squiz is reviewing PR #41 at 8d21a4f first, and 3f9c2e0 is next. Run `squiz review 41` again to wait for it.",
    );
  });
});

test("a state reviewed clean with the episode open waits for the state queued behind it, and returns its threads", async () => {
  await withWorktree(async (fixture) => {
    records(fixture, [{ ...OWN, status: "reviewed", result: "clean, episode open", newFindings: 0, round: ran(1) }, reviewing(LATER)]);
    const finished = (async () => {
      await sleep(POLL_MS * 4);
      records(fixture, [
        { ...OWN, status: "reviewed", result: "clean, episode open", newFindings: 0, round: ran(1) },
        { ...LATER, status: "reviewed", result: "exited", exitStatus: 2, openThreads: [OPEN_THREAD.id], newFindings: 1, round: { number: 2, startedAt: 1, endedAt: 2, reviewer: { backend: "detached" } } },
      ], { rounds: [ROUND, ROUND] });
    })();

    const printed = await runReview(request(fixture, { triggered: decided(fixture, { outcome: "in-hand" }), threads: [OPEN_THREAD] }));
    await finished;

    assert.equal(printed.exit, 2, printed.stdout + printed.stderr);
    assert.equal(printed.stdout.split("\n")[1], "Squiz reviewed PR #41 at 8d21a4f: round 2 of 3, 1 new finding.");
  });
});

test("#832: a run whose state's round closed the episode clean, archived by a new head before the run read it, returns that round", async () => {
  await withWorktree(async (fixture) => {
    records(fixture, [reviewing(OWN)]);
    const archived = (async () => {
      await sleep(POLL_MS * 4);
      // The round closes clean, a hook queues a new head, and the host starts a
      // new episode, all between two of the run's readings.
      records(fixture, [{ ...OWN, status: "reviewed", result: "exited", exitStatus: 0, openThreads: [], newFindings: 0, round: ran(1) }], {
        closeReported: true,
        cleanClose: { ...OWN, records: 1 },
        rounds: [ROUND],
      });
      const read = readState(fixture.episode);
      assert.equal(archiveEpisode(fixture.episode, read.outcome === "read" ? read.state : assert.fail("no state")).outcome, "archived");
      records(fixture, [reviewing(LATER)]);
    })();

    const printed = await runReview(request(fixture, { triggered: decided(fixture, { outcome: "in-hand" }), until: deadlineIn(POLL_MS * 40) }));
    await archived;

    assert.equal(printed.exit, 0, printed.stdout + printed.stderr);
    assert.equal(printed.stdout.split("\n")[1], "Squiz reviewed PR #41 at 3f9c2e0: round 1 of 3, no new findings.");
  });
});

test("#832: a run its trigger found closed clean, whose episode a new head archived before the run read it, prints that close and not the new episode", async () => {
  await withWorktree(async (fixture) => {
    records(fixture, [{ ...OWN, status: "reviewed", result: "exited", exitStatus: 0, openThreads: [], newFindings: 0, round: ran(1) }], {
      closeReported: true,
      cleanClose: { ...OWN, records: 1 },
      rounds: [ROUND],
    });
    const read = readState(fixture.episode);
    const closed = read.outcome === "read" ? read.state : assert.fail("no state");
    assert.equal(archiveEpisode(fixture.episode, closed).outcome, "archived");
    // The episode that replaced it has closed too, at the cap.
    records(fixture, [{ ...LATER, status: "reviewed", result: "exited", exitStatus: 3, openThreads: [], closedAt: "round cap", newFindings: 0, round: ran(1) }], {
      closeReported: true,
      rounds: [ROUND],
    });

    const printed = await runReview(request(fixture, { triggered: { ...decided(fixture, { outcome: "closed" }), read: closed } as Triggered }));

    assert.equal(printed.exit, 0, printed.stdout + printed.stderr);
    assert.equal(
      printed.stdout.split("\n")[1],
      "Squiz's review of PR #41 closed at 3f9c2e0 after 1 round, with nothing open. Only a new head commit starts another review in this worktree.",
    );
  });
});

test("a state reviewed clean with the episode open returns the close the queue ends on", async () => {
  await withWorktree(async (fixture) => {
    records(fixture, [
      { ...OWN, status: "reviewed", result: "clean, episode open", newFindings: 0, round: ran(1) },
      { ...LATER, status: "reviewed", result: "exited", exitStatus: 0, openThreads: [], newFindings: 0, round: { number: 2, startedAt: 1, endedAt: 2, reviewer: { backend: "detached" } } },
    ], { closeReported: true, rounds: [ROUND, ROUND] });

    const printed = await runReview(request(fixture, { triggered: decided(fixture, { outcome: "in-hand" }) }));

    assert.equal(printed.exit, 0);
    assert.equal(
      printed.stdout,
      `${PATH_LINE(fixture)}\nSquiz reviewed PR #41 at 8d21a4f: round 2 of 3, no new findings.\n\nNothing is open. The review is closed, and its summary is on the pull request.\n`,
    );
  });
});

test("a state reviewed clean whose wait runs out before the close exits 4, naming the state under review", async () => {
  await withWorktree(async (fixture) => {
    records(fixture, [{ ...OWN, status: "reviewed", result: "clean, episode open", newFindings: 0, round: ran(1) }, reviewing(LATER)]);

    const printed = await runReview(request(fixture, { triggered: decided(fixture, { outcome: "in-hand" }), until: deadlineIn(POLL_MS * 5) }));

    assert.equal(printed.exit, 4);
    assert.equal(
      printed.stdout.split("\n")[1],
      "Squiz found nothing open in PR #41 at 3f9c2e0, and is reviewing 8d21a4f before it closes the review. Run `squiz review 41` again to wait for it.",
    );
  });
});

test("a round that fails exits 1 with the reason it recorded and nothing on stdout", async () => {
  await withWorktree(async (fixture) => {
    records(fixture, [
      { ...OWN, status: "failed", reason: "the reviewer was stopped at the time bound of 900 seconds", ownerNoted: false, lines: ["the failure is posted on PR #41"] },
    ]);

    const printed = await runReview(request(fixture, { triggered: decided(fixture, { outcome: "in-hand" }) }));

    assert.equal(printed.exit, 1);
    assert.equal(printed.stdout, "");
    assert.equal(
      printed.stderr,
      "squiz: review failed: the reviewer was stopped at the time bound of 900 seconds\nsquiz: the failure is posted on PR #41\n" +
        "squiz: put these lines in your report rather than running squiz review again\n",
    );
  });
});

test("threads that cannot be listed after the round exit 1 with the reason, and say not to run again (#600)", async () => {
  await withWorktree(async (fixture) => {
    records(fixture, [
      { ...OWN, status: "reviewed", result: "exited", exitStatus: 2, openThreads: [OPEN_THREAD.id], newFindings: 1, round: { number: 1, startedAt: 1, endedAt: 2, reviewer: { backend: "detached" } } },
    ], { rounds: [ROUND] });

    const printed = await runReview({
      ...request(fixture, { triggered: decided(fixture, { outcome: "in-hand" }) }),
      venue: venueListing(() => ({ outcome: "failed", reason: "GitHub answered 502" })),
    });

    assert.equal(printed.exit, 1);
    assert.equal(printed.stdout, "");
    assert.equal(
      printed.stderr,
      "squiz: the threads on PR #41 could not all be listed to print the review of 3f9c2e0: GitHub answered 502\n" +
        "squiz: put these lines in your report rather than running squiz review again\n",
    );
  });
});

/** A close at the round cap with nothing open, which left OWN, queued behind LATER's round, not reviewed. */
const LEFT_BY_THE_CAP: readonly StateRecord[] = [
  { ...LATER, status: "reviewed", result: "exited", exitStatus: 0, openThreads: [], newFindings: 0, round: ran(3) },
  { ...OWN, status: "not reviewed", reason: "the episode closed at the round cap, after reviewing 8d21a4f" },
];

test("#844: a state the cap left not reviewed, with nothing open, is handed the close at exit 3, with the line saying why", async () => {
  await withWorktree(async (fixture) => {
    records(fixture, LEFT_BY_THE_CAP, { closeReported: true, rounds: [ROUND, ROUND, ROUND] });

    const printed = await runReview(request(fixture, { triggered: decided(fixture, { outcome: "in-hand" }) }));

    assert.equal(printed.exit, 3, "exit 0 is the merge signal, and no round reviewed 3f9c2e0");
    assert.deepEqual(printed.stdout.split("\n").slice(1, 7), [
      "Squiz reviewed PR #41 at 8d21a4f: round 3 of 3, no new findings.",
      "Squiz did not review PR #41 at 3f9c2e0: the episode closed at the round cap, after reviewing 8d21a4f.",
      "",
      "The round cap is reached. The review is closed with nothing open, and its summary",
      "is on the pull request. A person takes it from here, so do not run",
      "`squiz review 41` again.",
    ]);
  });
});

test("#844: a later run on a state the cap left not reviewed agrees with the run that waited on it, at exit 3", async () => {
  await withWorktree(async (fixture) => {
    records(fixture, LEFT_BY_THE_CAP, { closeReported: true, rounds: [ROUND, ROUND, ROUND] });

    const printed = await runReview(request(fixture, { triggered: decided(fixture, { outcome: "closed" }) }));

    assert.equal(printed.exit, 3, "exit 0 is the merge signal, and no round reviewed 3f9c2e0");
    assert.deepEqual(printed.stdout.split("\n").slice(1, 3), [
      "Squiz did not review PR #41 at 3f9c2e0: the episode closed at the round cap, after reviewing 8d21a4f.",
      "Squiz's review of PR #41 closed at 8d21a4f after 3 rounds, with nothing open. No round runs again in this worktree.",
    ]);
  });
});

test("#844: a new commit after a close at the cap with nothing open exits 3, naming the new head as not reviewed", async () => {
  await withWorktree(async (fixture) => {
    const left: StateKey = { head: "5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f", activity: null };
    records(fixture, [
      { ...LATER, status: "reviewed", result: "exited", exitStatus: 0, openThreads: [], newFindings: 0, round: ran(3) },
      { ...left, status: "not reviewed", reason: "the episode closed at the round cap, after reviewing 8d21a4f" },
    ], { closeReported: true, rounds: [ROUND, ROUND, ROUND] });

    const printed = await runReview(request(fixture, { triggered: decided(fixture, { outcome: "closed" }) }));

    assert.equal(printed.exit, 3, "exit 0 is the merge signal, and no round reviewed 3f9c2e0");
    assert.deepEqual(printed.stdout.split("\n").slice(1, 3), [
      "Squiz did not review PR #41 at 3f9c2e0: the episode closed at the round cap, after reviewing 8d21a4f.",
      "Squiz's review of PR #41 closed at 8d21a4f after 3 rounds, with nothing open. No round runs again in this worktree.",
    ]);
  });
});

test("#844: a state superseded by the round that closed at the cap with nothing open is answered by that round, at exit 0, for the run waiting and for a later one", async () => {
  await withWorktree(async (fixture) => {
    const left: StateKey = { head: "5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f", activity: null };
    records(fixture, [
      { ...OWN, status: "not reviewed", reason: "superseded by 8d21a4f", supersededBy: LATER },
      { ...LATER, status: "reviewed", result: "exited", exitStatus: 0, openThreads: [], newFindings: 0, round: ran(3) },
      { ...left, status: "not reviewed", reason: "the episode closed at the round cap, after reviewing 8d21a4f" },
    ], { closeReported: true, rounds: [ROUND, ROUND, ROUND] });

    const waited = await runReview(request(fixture, { triggered: decided(fixture, { outcome: "in-hand" }) }));
    const later = await runReview(request(fixture, { triggered: decided(fixture, { outcome: "closed" }) }));

    assert.equal(waited.exit, 0, waited.stdout + waited.stderr);
    assert.equal(later.exit, 0, later.stdout + later.stderr);
    assert.equal(
      later.stdout.split("\n")[1],
      "Squiz's review of PR #41 closed at 8d21a4f after 3 rounds, with nothing open. No round runs again in this worktree.",
    );
  });
});

test("#844: a new commit after a close that reached the token bound at the last round names the token bound, as the states it left do", async () => {
  await withWorktree(async (fixture) => {
    const left: StateKey = { head: "5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f", activity: null };
    records(fixture, [
      { ...LATER, status: "reviewed", result: "exited", exitStatus: 0, openThreads: [], newFindings: 0, round: ran(3) },
      { ...left, status: "not reviewed", reason: "the episode closed at the token bound, after reviewing 8d21a4f" },
    ], { closeReported: true, rounds: [ROUND, ROUND, ROUND] });

    const printed = await runReview(request(fixture, { triggered: decided(fixture, { outcome: "closed" }) }));

    assert.equal(printed.exit, 3, printed.stdout + printed.stderr);
    assert.equal(
      printed.stdout.split("\n")[1],
      "Squiz did not review PR #41 at 3f9c2e0: the episode closed at the token bound, after reviewing 8d21a4f.",
    );
  });
});

test("#844: a later run on the state whose round closed the episode at the cap with nothing open still exits 0", async () => {
  await withWorktree(async (fixture) => {
    records(fixture, [
      { ...OWN, status: "reviewed", result: "exited", exitStatus: 0, openThreads: [], newFindings: 0, round: ran(3) },
      { ...LATER, status: "not reviewed", reason: "the episode closed at the round cap, after reviewing 3f9c2e0" },
    ], { closeReported: true, rounds: [ROUND, ROUND, ROUND] });

    const printed = await runReview(request(fixture, { triggered: decided(fixture, { outcome: "closed" }) }));

    assert.equal(printed.exit, 0, printed.stdout + printed.stderr);
    assert.equal(
      printed.stdout.split("\n")[1],
      "Squiz's review of PR #41 closed at 3f9c2e0 after 3 rounds, with nothing open. No round runs again in this worktree.",
    );
  });
});

test("#844: the last round under the cap leaving nothing open and nothing behind closes clean at exit 0, for the run waiting and for a later one", async () => {
  await withWorktree(async (fixture) => {
    records(fixture, [
      { ...OWN, status: "reviewed", result: "exited", exitStatus: 0, openThreads: [], newFindings: 0, round: ran(3) },
    ], { closeReported: true, rounds: [ROUND, ROUND, ROUND], cleanClose: { ...OWN, records: 1 } });

    const waited = await runReview(request(fixture, { triggered: decided(fixture, { outcome: "in-hand" }) }));
    const later = await runReview(request(fixture, { triggered: decided(fixture, { outcome: "closed" }) }));

    assert.equal(waited.exit, 0, waited.stdout + waited.stderr);
    assert.deepEqual(waited.stdout.split("\n").slice(1, 4), [
      "Squiz reviewed PR #41 at 3f9c2e0: round 3 of 3, no new findings.",
      "",
      "Nothing is open. The review is closed, and its summary is on the pull request.",
    ]);
    assert.equal(later.exit, 0, later.stdout + later.stderr);
    assert.equal(
      later.stdout.split("\n")[1],
      "Squiz's review of PR #41 closed at 3f9c2e0 after 3 rounds, with nothing open. Only a new head commit starts another review in this worktree.",
    );
  });
});

const BEFORE_A_ROUND = "the episode closed at the round cap before a round took this state";

test("a state the cap stopped before a round took it is handed the close, naming the cap, with the threads it left open", async () => {
  await withWorktree(async (fixture) => {
    records(fixture, [
      {
        ...OWN,
        status: "not reviewed",
        reason: BEFORE_A_ROUND,
        closed: { exitStatus: 3, openThreads: [OPEN_THREAD.id], closedAt: "round cap" },
      },
    ], { closeReported: true, rounds: [ROUND, ROUND, ROUND] });

    const printed = await runReview(
      request(fixture, { triggered: decided(fixture, { outcome: "in-hand" }), threads: [OPEN_THREAD] }),
    );

    assert.equal(printed.exit, 3, printed.stdout + printed.stderr);
    assert.equal(printed.stderr, "");
    assert.deepEqual(printed.stdout.split("\n").slice(1, 6), [
      `Squiz did not review PR #41 at 3f9c2e0: ${BEFORE_A_ROUND}.`,
      "",
      "The round cap is reached. The review is closed with 1 thread open, and its summary",
      "is on the pull request. A person takes it from here, so do not run",
      "`squiz review 41` again.",
    ]);
    assert.match(printed.stdout, /^PRRT_kwDOL7tYbc5abcd1 packages\/sync\/src\/queue\.ts:134 high — Retry backoff resets on every enqueue$/mu);
  });
});

test("#844: a state queued behind the one the cap stopped, with nothing open, is handed the same close at exit 3, named after it", async () => {
  await withWorktree(async (fixture) => {
    const taken: StateKey = { head: OWN.head, activity: "PRRC_older" };
    records(fixture, [
      { ...taken, status: "not reviewed", reason: BEFORE_A_ROUND, closed: { exitStatus: 3, openThreads: [], closedAt: "round cap" } },
      { ...OWN, status: "not reviewed", reason: BEFORE_A_ROUND },
    ], { closeReported: true, rounds: [ROUND, ROUND, ROUND] });

    const printed = await runReview(request(fixture, { triggered: decided(fixture, { outcome: "in-hand" }) }));

    assert.equal(printed.exit, 3, "exit 0 is the merge signal, and no round reviewed 3f9c2e0");
    assert.deepEqual(printed.stdout.split("\n").slice(1, 6), [
      `Squiz did not review PR #41 at 3f9c2e0 with different replies: ${BEFORE_A_ROUND}.`,
      "",
      "The round cap is reached. The review is closed with nothing open, and its summary",
      "is on the pull request. A person takes it from here, so do not run",
      "`squiz review 41` again.",
    ]);
  });
});

const NO_SUMMARY = "the review of PR #41 closed without its summary: the episode closed before any round ran";

/** Failed attempts spent the token bound before any round ran, and the round host closed the episode on OWN. */
const SPENT_BEFORE_ANY_ROUND: readonly StateRecord[] = [
  {
    ...OWN,
    status: "not reviewed",
    reason: "the episode closed at the token bound before a round took this state",
    closed: { exitStatus: 3, openThreads: [], closedAt: "token bound", problems: [NO_SUMMARY] },
  },
];

test("#844: a close before any round ran, with nothing open, exits 3 naming the head as not reviewed, and says on stderr why there is no summary", async () => {
  await withWorktree(async (fixture) => {
    records(fixture, SPENT_BEFORE_ANY_ROUND, { closeReported: true });

    const printed = await runReview(request(fixture, { triggered: decided(fixture, { outcome: "in-hand" }) }));

    assert.equal(printed.exit, 3, "exit 0 is the merge signal, and no round reviewed 3f9c2e0");
    assert.equal(printed.stderr, `squiz: ${NO_SUMMARY}\n`);
    assert.deepEqual(printed.stdout.split("\n").slice(1, 5), [
      "Squiz did not review PR #41 at 3f9c2e0: the episode closed at the token bound before a round took this state.",
      "",
      "The token bound is reached. The review is closed with nothing open. A person takes",
      "it from here, so do not run `squiz review 41` again.",
    ]);
  });
});

test("#844: a later run on an episode closed before any round ran, with nothing open, agrees with the run that waited on it, at exit 3", async () => {
  await withWorktree(async (fixture) => {
    records(fixture, SPENT_BEFORE_ANY_ROUND, { closeReported: true });

    const printed = await runReview(request(fixture, { triggered: decided(fixture, { outcome: "closed" }) }));

    assert.equal(printed.exit, 3, "exit 0 is the merge signal, and no round reviewed 3f9c2e0");
    assert.deepEqual(printed.stdout.split("\n").slice(1, 3), [
      "Squiz did not review PR #41 at 3f9c2e0: the episode closed at the token bound before a round took this state.",
      "Squiz's review of PR #41 closed at 3f9c2e0 after 0 rounds, with nothing open. No round runs again in this worktree.",
    ]);
  });
});

test("a state superseded before its round started follows to the state that superseded it, and returns its result", async () => {
  await withWorktree(async (fixture) => {
    records(fixture, [
      { ...OWN, status: "not reviewed", reason: "superseded by 8d21a4f", supersededBy: LATER },
      { ...LATER, status: "reviewed", result: "exited", exitStatus: 2, openThreads: [OPEN_THREAD.id], newFindings: 1, round: { number: 1, startedAt: 1, endedAt: 2, reviewer: { backend: "detached" } } },
    ], { rounds: [ROUND] });

    const printed = await runReview(request(fixture, { triggered: decided(fixture, { outcome: "in-hand" }), threads: [OPEN_THREAD] }));

    assert.equal(printed.exit, 2, printed.stdout + printed.stderr);
    assert.equal(printed.stdout.split("\n")[1], "Squiz reviewed PR #41 at 8d21a4f: round 1 of 3, 1 new finding.");
  });
});

test("a state superseded by a reply not yet queued waits for that reply's state, never an older record on its commit", async () => {
  await withWorktree(async (fixture) => {
    const replyA: StateKey = { head: OWN.head, activity: "PRRC_replyA" };
    const replyB: StateKey = { head: OWN.head, activity: "PRRC_replyB" };
    records(fixture, [
      { ...OWN, status: "failed", reason: "the provider refused the credential", ownerNoted: false },
      { ...replyA, status: "not reviewed", reason: "superseded by 3f9c2e0 with different replies", supersededBy: replyB },
    ]);
    const triggered = { ...decided(fixture, { outcome: "queue", startHost: false }), state: replyA };

    const printed = await runReview(request(fixture, { triggered, until: deadlineIn(POLL_MS * 5) }));

    assert.equal(printed.exit, 4, printed.stdout + printed.stderr);
    assert.equal(
      printed.stdout.split("\n")[1],
      "Squiz is reviewing PR #41 at 3f9c2e0 with different replies instead of 3f9c2e0. Run `squiz review 41` again to wait for it.",
    );
  });
});

test("a state superseded by one no trigger has queued triggers again, and returns the round of the state that trigger queued (#588)", async () => {
  await withWorktree(async (fixture) => {
    records(fixture, [{ ...OWN, status: "not reviewed", reason: "superseded by 8d21a4f", supersededBy: LATER }]);
    const handed: TriggerRequest[] = [];
    const later = { ...decided(fixture, { outcome: "queue", startHost: true }), state: LATER };
    const run: ReviewRequest = {
      ...request(fixture, { triggered: decided(fixture, { outcome: "result" }), threads: [OPEN_THREAD] }),
      trigger: (asked) => {
        handed.push(asked);
        if (handed.length === 1) return decided(fixture, { outcome: "result" });
        records(fixture, [{ ...OWN, status: "not reviewed", reason: "superseded by 8d21a4f", supersededBy: LATER }, queued(LATER)]);
        return later;
      },
    };
    const finished = (async () => {
      for (let waited = 0; handed.length < 2 && waited < 200; waited += 1) await sleep(POLL_MS);
      records(fixture, [
        { ...OWN, status: "not reviewed", reason: "superseded by 8d21a4f", supersededBy: LATER },
        { ...LATER, status: "reviewed", result: "exited", exitStatus: 2, openThreads: [OPEN_THREAD.id], newFindings: 1, round: { number: 1, startedAt: 1, endedAt: 2, reviewer: { backend: "detached" } } },
      ], { rounds: [ROUND] });
    })();

    const printed = await runReview(run);
    await finished;

    assert.equal(handed.length, 2, "the run did not trigger again for the state nothing had queued");
    assert.equal(printed.exit, 2, printed.stdout + printed.stderr);
    assert.equal(printed.stdout.split("\n")[1], "Squiz reviewed PR #41 at 8d21a4f: round 1 of 3, 1 new finding.");
  });
});

test("a trigger again that the run's deadline cuts off exits 4, not 1 (#588)", async () => {
  await withWorktree(async (fixture) => {
    records(fixture, [{ ...OWN, status: "not reviewed", reason: "superseded by 8d21a4f", supersededBy: LATER }]);
    let spent = false;
    const until: Deadline = { ...deadlineIn(10_000), passed: () => spent, remaining: () => (spent ? 0 : 10_000) };
    const handed: TriggerRequest[] = [];
    const run: ReviewRequest = {
      ...request(fixture, { triggered: decided(fixture, { outcome: "result" }), until }),
      trigger: (asked) => {
        handed.push(asked);
        if (handed.length === 1) return decided(fixture, { outcome: "result" });
        spent = true;
        return { outcome: "failed", reason: "the time left for GitHub ran out before this call was made" };
      },
    };

    const printed = await runReview(run);

    assert.equal(handed.length, 2, "the run did not trigger again");
    assert.equal(printed.exit, 4, printed.stdout + printed.stderr);
    assert.equal(
      printed.stdout.split("\n")[1],
      "Squiz is reviewing PR #41 at 8d21a4f instead of 3f9c2e0. Run `squiz review 41` again to wait for it.",
    );
  });
});

test("a superseded state whose wait runs out before the newer state's round ends exits 4, naming both", async () => {
  await withWorktree(async (fixture) => {
    records(fixture, [{ ...OWN, status: "not reviewed", reason: "superseded by 8d21a4f", supersededBy: LATER }, reviewing(LATER)]);

    const printed = await runReview(request(fixture, { triggered: decided(fixture, { outcome: "in-hand" }), until: deadlineIn(POLL_MS * 5) }));

    assert.equal(printed.exit, 4, printed.stdout + printed.stderr);
    assert.equal(
      printed.stdout.split("\n")[1],
      "Squiz is reviewing PR #41 at 8d21a4f instead of 3f9c2e0. Run `squiz review 41` again to wait for it.",
    );
  });
});

test("#427: a clean state followed by one it superseded waits out its deadline and exits 4, rather than following the two round each other", async () => {
  await withWorktree(async (fixture) => {
    // A completed clean while B was queued, then B's reply was deleted before its round started, so A superseded B.
    const replied: StateKey = { head: OWN.head, activity: "PRRC_deleted" };
    records(fixture, [
      { ...OWN, status: "reviewed", result: "clean, episode open", newFindings: 0, round: ran(1) },
      { ...replied, status: "not reviewed", reason: "superseded by 3f9c2e0", supersededBy: OWN },
    ], { rounds: [ROUND] });

    // Long enough for git to answer on a loaded machine, and short enough to wait out.
    const printed = await runReview(request(fixture, { triggered: decided(fixture, { outcome: "result" }), until: deadlineIn(2_000) }));

    assert.equal(printed.exit, 4, printed.stdout + printed.stderr);
    assert.equal(printed.stdout.split("\n")[1], "Squiz is still reviewing PR #41 at 3f9c2e0. Run `squiz review 41` again to wait for it.");
  });
});

test("#427: a superseded state whose successor was reviewed clean ahead of it waits out its deadline and exits 4", async () => {
  await withWorktree(async (fixture) => {
    const replied: StateKey = { head: OWN.head, activity: "PRRC_deleted" };
    records(fixture, [
      { ...OWN, status: "reviewed", result: "clean, episode open", newFindings: 0, round: ran(1) },
      { ...replied, status: "not reviewed", reason: "superseded by 3f9c2e0", supersededBy: OWN },
    ], { rounds: [ROUND] });
    const triggered = { ...decided(fixture, { outcome: "result" }), state: replied };

    const printed = await runReview(request(fixture, { triggered, until: deadlineIn(2_000) }));

    assert.equal(printed.exit, 4, printed.stdout + printed.stderr);
    assert.equal(
      printed.stdout.split("\n")[1],
      "Squiz is reviewing PR #41 at 3f9c2e0 instead of 3f9c2e0. Run `squiz review 41` again to wait for it.",
    );
  });
});

test("a round some of whose findings failed to post keeps its status, and says how many on stderr", async () => {
  await withWorktree(async (fixture) => {
    records(fixture, [
      { ...OWN, status: "reviewed", result: "exited", exitStatus: 2, openThreads: [OPEN_THREAD.id], newFindings: 1, unposted: { failed: 1, of: 2 }, round: { number: 1, startedAt: 1, endedAt: 2, reviewer: { backend: "detached" } } },
    ], { rounds: [ROUND] });

    const printed = await runReview(request(fixture, { triggered: decided(fixture, { outcome: "in-hand" }), threads: [OPEN_THREAD] }));

    assert.equal(printed.exit, 2);
    assert.equal(printed.stderr, "squiz: round 1 could not post 1 of its 2 findings to PR #41\n");
  });
});

test("#606: a round that left threads open prints each of its findings no thread holds on stderr, and keeps its status", async () => {
  await withWorktree(async (fixture) => {
    records(fixture, [
      {
        ...OWN,
        status: "reviewed",
        result: "exited",
        exitStatus: 2,
        openThreads: [OPEN_THREAD.id],
        newFindings: 1,
        unposted: { failed: 1, of: 3 },
        unthreaded: [
          "About the change as a whole: The retry queue duplicates the scheduler",
          "`src/cache.ts:12` — The cache is never cleared (raised, and its comment could not be posted)",
        ],
        round: { number: 1, startedAt: 1, endedAt: 2, reviewer: { backend: "detached" } },
      },
    ], { rounds: [ROUND] });

    const printed = await runReview(request(fixture, { triggered: decided(fixture, { outcome: "in-hand" }), threads: [OPEN_THREAD] }));

    assert.equal(printed.exit, 2);
    assert.equal(
      printed.stderr,
      [
        "squiz: round 1 could not post 1 of its 3 findings to PR #41",
        "squiz: round 1 raised this on no thread: About the change as a whole: The retry queue duplicates the scheduler",
        "squiz: round 1 raised this on no thread: `src/cache.ts:12` — The cache is never cleared (raised, and its comment could not be posted)",
        "",
      ].join("\n"),
    );
  });
});

test("a run on a closed episode prints the close, exiting as it did", async () => {
  await withWorktree(async (fixture) => {
    records(fixture, [
      { ...LATER, status: "reviewed", result: "exited", exitStatus: 3, openThreads: [OPEN_THREAD.id], closedAt: "round cap", newFindings: 0, round: ran(3) },
    ], { closeReported: true, rounds: [ROUND, ROUND, ROUND] });

    const printed = await runReview(request(fixture, { triggered: decided(fixture, { outcome: "closed" }, [OPEN_THREAD]) }));

    assert.equal(printed.exit, 3);
    assert.deepEqual(printed.stdout.split("\n").slice(1, 3), [
      "Squiz did not review PR #41 at 3f9c2e0: the episode closed at the round cap, after reviewing 8d21a4f.",
      "Squiz's review of PR #41 closed at 8d21a4f after 3 rounds, with 1 thread open. No round runs again in this worktree.",
    ]);
    assert.match(printed.stdout, /^PRRT_kwDOL7tYbc5abcd1 /mu);
  });
});

test("a run on an episode a round closed without its summary prints the recorded failure on stderr (#425)", async () => {
  await withWorktree(async (fixture) => {
    const problem = "the review of PR #41 closed without its summary: gh: HTTP 502 Bad Gateway";
    records(fixture, [
      { ...LATER, status: "reviewed", result: "exited", exitStatus: 3, openThreads: [OPEN_THREAD.id], closedAt: "round cap", problems: [problem], newFindings: 0, round: ran(3) },
    ], { closeReported: true, rounds: [ROUND, ROUND, ROUND] });

    const printed = await runReview(request(fixture, { triggered: decided(fixture, { outcome: "closed" }, [OPEN_THREAD]) }));

    assert.equal(printed.exit, 3);
    assert.equal(printed.stderr, `squiz: ${problem}\n`);
  });
});

test("a run on an episode closed before any review, without its summary, prints the recorded failure on stderr (#425)", async () => {
  await withWorktree(async (fixture) => {
    const problem = "the review of PR #41 closed without its summary: gh: HTTP 502 Bad Gateway";
    records(fixture, [
      {
        ...OWN,
        status: "not reviewed",
        reason: "the episode closed at the token bound before a round took this state",
        closed: { exitStatus: 3, openThreads: [OPEN_THREAD.id], closedAt: "token bound", problems: [problem] },
      },
    ], { closeReported: true });
    const triggered = { ...decided(fixture, { outcome: "closed" }, [OPEN_THREAD]), state: LATER };

    const printed = await runReview(request(fixture, { triggered }));

    assert.equal(printed.exit, 3);
    assert.equal(printed.stderr, `squiz: ${problem}\n`);
  });
});

test("a round host no one can tell running or gone exits 1 naming it", async () => {
  await withWorktree(async (fixture) => {
    records(fixture, [reviewing(OWN)]);

    const printed = await runReview(
      request(fixture, { triggered: decided(fixture, { outcome: "host-unknown", reason: "ps did not answer within 2000ms" }) }),
    );

    assert.equal(printed.exit, 1);
    assert.equal(printed.stdout, "");
    assert.equal(
      printed.stderr,
      "squiz: no review ran: whether round host 4242 for PR #41 is still running could not be told: ps did not answer within 2000ms\n" +
        "squiz: put these lines in your report rather than running squiz review again\n",
    );
  });
});

test("a gate that stops the trigger exits 1 with its reason and nothing on stdout", async () => {
  await withWorktree(async (fixture) => {
    const printed = await runReview(
      request(fixture, { triggered: { outcome: "no review", reason: "no open pull request has \"feature-a\" as its head" } }),
    );

    assert.equal(printed.exit, 1);
    assert.equal(printed.stdout, "");
    assert.equal(
      printed.stderr,
      "squiz: no review ran: no open pull request has \"feature-a\" as its head\n" +
        "squiz: put these lines in your report rather than running squiz review again\n",
    );
  });
});

const DRAFT_LINE = "PR #41 is a draft. Squiz reviews it once it is marked ready for review, so there is nothing to wait for.\n";

test("a draft exits 0 with one line on stdout saying so, nothing on stderr, and no output file (#720)", async () => {
  await withWorktree(async (fixture) => {
    const printed = await runReview(request(fixture, { triggered: { outcome: "held", line: DRAFT_LINE.trimEnd() } }));

    assert.deepEqual(printed, { exit: 0, stdout: DRAFT_LINE, stderr: "" });
    assert.equal(existsSync(join(fixture.worktree, ".squiz")), false, "a run on a draft wrote into .squiz");
  });
});

test("a pull request made a draft while the run waits ends the wait with the draft line, rather than as a review that could not run (#720)", async () => {
  await withWorktree(async (fixture) => {
    records(fixture, [{ ...OWN, status: "not reviewed", reason: "superseded by 8d21a4f", supersededBy: LATER }]);
    const handed: TriggerRequest[] = [];
    const run: ReviewRequest = {
      ...request(fixture, { triggered: decided(fixture, { outcome: "result" }) }),
      trigger: (asked) => {
        handed.push(asked);
        if (handed.length === 1) return decided(fixture, { outcome: "result" });
        return { outcome: "held", line: DRAFT_LINE.trimEnd() };
      },
    };

    const printed = await runReview(run);

    assert.equal(handed.length, 2, "the run did not trigger again");
    assert.deepEqual(printed, { exit: 0, stdout: DRAFT_LINE, stderr: "" });
  });
});

const UNKNOWN_START = "the intermediate process exited 1: spawn failed";

function startedUnknown(fixture: Fixture): Triggered {
  return decided(fixture, { outcome: "queue", startHost: true }, [], { outcome: "unknown", reason: UNKNOWN_START });
}

test("a round host whose start is unknown, and which never takes the lock, exits 1 naming squiz status and host.log", async () => {
  await withWorktree(async (fixture) => {
    records(fixture, [queued(OWN)]);
    const started = Date.now();

    const printed = await runReview({
      ...request(fixture, { triggered: startedUnknown(fixture), until: deadlineIn(10_000) }),
      hostStartMs: 200,
      presence: () => ({ outcome: "running" }),
    });

    assert.ok(Date.now() - started < 5_000, "the run must not wait out its deadline on a host that never started");
    assert.equal(printed.exit, 1);
    assert.equal(printed.stdout, "");
    assert.equal(
      printed.stderr,
      `squiz: no review ran: whether the round host for PR #41 started could not be told, and none has taken the review since: ${UNKNOWN_START}\n` +
        "squiz: `squiz status 41` shows whether one takes it later, and .squiz/41/host.log holds what the host wrote\n" +
        "squiz: put these lines in your report rather than running squiz review again\n",
    );
  });
});

test("a round host whose start is unknown, and which holds the lock, is waited on for its result", async () => {
  await withWorktree(async (fixture) => {
    records(fixture, [queued(OWN)]);
    mkdirSync(fixture.episode.directory, { recursive: true });
    writeFileSync(join(fixture.episode.directory, "host.lock"), `${JSON.stringify({ pid: 4242, startedAt: 1 })}\n`);
    const finished = (async () => {
      await sleep(400);
      records(fixture, [
        { ...OWN, status: "reviewed", result: "exited", exitStatus: 2, openThreads: [OPEN_THREAD.id], newFindings: 1, round: { number: 1, startedAt: 1, endedAt: 2, reviewer: { backend: "detached" } } },
      ], { rounds: [ROUND] });
    })();

    const printed = await runReview({
      ...request(fixture, { triggered: startedUnknown(fixture), threads: [OPEN_THREAD] }),
      hostStartMs: 100,
      presence: (identity) => (identity.pid === 4242 ? { outcome: "running" } : { outcome: "gone" }),
    });
    await finished;

    assert.equal(printed.exit, 2, printed.stderr);
    assert.equal(printed.stdout.split("\n")[1], "Squiz reviewed PR #41 at 3f9c2e0: round 1 of 3, 1 new finding.");
  });
});

test("a round host whose start is unknown is checked within its start window, never the run's whole deadline", async () => {
  await withWorktree(async (fixture) => {
    records(fixture, [queued(OWN)]);
    mkdirSync(fixture.episode.directory, { recursive: true });
    writeFileSync(join(fixture.episode.directory, "host.lock"), `${JSON.stringify({ pid: 4242, startedAt: 1 })}\n`);
    const bounds: number[] = [];

    const printed = await runReview({
      ...request(fixture, { triggered: startedUnknown(fixture), until: deadlineIn(10_000) }),
      hostStartMs: 200,
      presence: (_identity, boundMs) => {
        bounds.push(boundMs);
        return { outcome: "gone" };
      },
    });

    assert.equal(printed.exit, 1);
    assert.ok(bounds.length > 0);
    assert.ok(bounds.every((bound) => bound <= 200), `each ps must be bounded by the start window: ${bounds.join(", ")}`);
  });
});

test("a round host whose start is unknown, with the deadline passed and no host on the lock, exits 1 rather than 4", async () => {
  await withWorktree(async (fixture) => {
    records(fixture, [queued(OWN)]);

    const printed = await runReview(request(fixture, { triggered: startedUnknown(fixture), until: deadlineIn(500) }));

    assert.equal(printed.exit, 1);
    assert.match(printed.stderr, /could not be told, and none has taken the review since/u);
  });
});

/** The working tree as the local venue reads it, at the run's own head. */
const WORKING_TREE: Change = {
  key: LOCAL_KEY,
  name: "the working tree",
  rerun: "(cd '/work/squiz-a' && squiz review)",
  summaryAt: "in /work/squiz-a/.squiz/local/summary.md",
  followUp: "Fix what applies in /work/squiz-a, then run `(cd '/work/squiz-a' && squiz review)` again.",
  base: CHANGE.base,
  head: OWN.head,
  description: "",
};

type LocalRun = {
  readonly until?: Deadline;
  readonly threads?: readonly ReviewThread[];
  readonly listThreads?: Venue["listThreads"];
  readonly host?: HostStart;
  readonly hostStartMs?: number;
};

/** A run under the local venue, in a worktree whose one episode holds `held`, on a trigger that decided `decision`. */
async function localReview(
  held: readonly StateRecord[],
  more: Partial<EpisodeState>,
  decision: TriggerDecision,
  run: LocalRun = {},
): Promise<Printed> {
  const worktree = realpathSync(mkdtempSync(join(tmpdir(), "squiz-review-local-")));
  try {
    const made = spawnSync("git", ["init", "--quiet", "--initial-branch", "feature-a"], { cwd: worktree });
    assert.equal(made.status, 0);
    writeFileSync(join(worktree, ".squiz.json"), "{}");
    const found = episodeAt(localVenue, worktree, LOCAL_KEY);
    assert.ok(found.outcome === "found", "the local venue must name the episode");
    records({ worktree, episode: found.episode }, held, more);
    const triggered: Triggered = {
      outcome: "decided",
      change: WORKING_TREE,
      episode: found.episode,
      state: OWN,
      threads: run.threads ?? [],
      decision,
      queued: decision.outcome === "queue",
      host: run.host ?? { outcome: "not started" },
    };
    const listThreads = run.listThreads ?? (() => ({ outcome: "listed" as const, threads: run.threads ?? [] }));
    return await runReview({
      directory: worktree,
      key: LOCAL_KEY,
      environment: {},
      until: run.until ?? deadlineIn(10_000),
      pollMs: POLL_MS,
      trigger: () => triggered,
      venue: { ...venueListing(listThreads), episodeDirectory: localVenue.episodeDirectory },
      ...(run.hostStartMs === undefined ? {} : { hostStartMs: run.hostStartMs }),
    });
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
}

/** `printed` says `line`, and names no pull request anywhere. */
function callsItTheWorkingTree(printed: Printed, line: string): void {
  const all = printed.stdout + printed.stderr;
  assert.doesNotMatch(all, /PR #/u, `the output names a pull request:\n${all}`);
  assert.ok(all.includes(line), `the output does not say ${JSON.stringify(line)}:\n${all}`);
}

test("#820: a round's heading and its unposted findings under the local venue name the working tree", async () => {
  const printed = await localReview(
    [{ ...OWN, status: "reviewed", result: "exited", exitStatus: 2, openThreads: [OPEN_THREAD.id], newFindings: 1, unposted: { failed: 1, of: 2 }, round: ran(1) }],
    { rounds: [ROUND] },
    { outcome: "in-hand" },
    { threads: [OPEN_THREAD] },
  );

  assert.equal(printed.exit, 2, printed.stderr);
  callsItTheWorkingTree(printed, "Squiz reviewed the working tree at 3f9c2e0: round 1 of 3, 1 new finding.");
  callsItTheWorkingTree(printed, "round 1 could not post 1 of its 2 findings to the working tree");
});

test("#820: a close at the cap that left the run's state unreviewed names the working tree on both its lines", async () => {
  const printed = await localReview(
    [
      { ...LATER, status: "reviewed", result: "exited", exitStatus: 0, openThreads: [], newFindings: 0, round: ran(3) },
      { ...OWN, status: "not reviewed", reason: "the episode closed at the round cap, after reviewing 8d21a4f" },
    ],
    { closeReported: true, rounds: [ROUND, ROUND, ROUND] },
    { outcome: "in-hand" },
  );

  assert.equal(printed.exit, 3, printed.stderr);
  callsItTheWorkingTree(printed, "Squiz reviewed the working tree at 8d21a4f: round 3 of 3, no new findings.");
  callsItTheWorkingTree(printed, "Squiz did not review the working tree at 3f9c2e0: the episode closed at the round cap");
});

test("#820: a run still waiting at its deadline under the local venue names the working tree", async () => {
  const printed = await localReview([reviewing(OWN)], {}, { outcome: "in-hand" }, { until: deadlineIn(POLL_MS * 5) });

  assert.equal(printed.exit, 4, printed.stderr);
  callsItTheWorkingTree(printed, "Squiz is still reviewing the working tree at 3f9c2e0.");
});

test("#823: a run still waiting at its deadline under the local venue says to run the change's rerun, never squiz review local", async () => {
  const printed = await localReview([reviewing(OWN)], {}, { outcome: "in-hand" }, { until: deadlineIn(POLL_MS * 5) });

  assert.equal(printed.exit, 4, printed.stderr);
  assert.ok(printed.stdout.includes(`Run \`${WORKING_TREE.rerun}\` again to wait for it.`), printed.stdout);
  assert.doesNotMatch(printed.stdout, /squiz review local/u);
});

test("#820: a closed episode under the local venue names the working tree", async () => {
  const printed = await localReview(
    [{ ...LATER, status: "reviewed", result: "exited", exitStatus: 0, openThreads: [], newFindings: 0, round: ran(3) }],
    { closeReported: true, rounds: [ROUND, ROUND, ROUND] },
    { outcome: "closed" },
  );

  assert.equal(printed.exit, 3, printed.stderr);
  callsItTheWorkingTree(printed, "Squiz did not review the working tree at 3f9c2e0: the episode closed at the round cap, after reviewing 8d21a4f.");
  callsItTheWorkingTree(printed, "Squiz's review of the working tree closed at 8d21a4f after 3 rounds, with nothing open.");
});

test("#820: a round host under the local venue that cannot be told running, or that stopped, is named for the working tree", async () => {
  const unknown = await localReview([reviewing(OWN)], {}, { outcome: "host-unknown", reason: "ps did not answer within 2000ms" });
  assert.equal(unknown.exit, 1);
  callsItTheWorkingTree(unknown, "whether round host 4242 for the working tree is still running could not be told");

  const stopped = await localReview([reviewing(OWN)], {}, { outcome: "recover", afterwards: { outcome: "start-host" } });
  assert.equal(stopped.exit, 1);
  callsItTheWorkingTree(stopped, "round host 4242 for the working tree stopped before its round ended");
});

test("#820: threads that cannot be listed under the local venue are named for the working tree", async () => {
  const printed = await localReview(
    [{ ...OWN, status: "reviewed", result: "exited", exitStatus: 2, openThreads: [OPEN_THREAD.id], newFindings: 1, round: ran(1) }],
    { rounds: [ROUND] },
    { outcome: "in-hand" },
    { listThreads: () => ({ outcome: "failed", reason: "the record could not be read" }) },
  );

  assert.equal(printed.exit, 1);
  callsItTheWorkingTree(printed, "the threads on the working tree could not all be listed");
});

test("#820: a round host whose start is unknown under the local venue is named for the working tree", async () => {
  const printed = await localReview(
    [queued(OWN)],
    {},
    { outcome: "queue", startHost: true },
    { host: { outcome: "unknown", reason: UNKNOWN_START }, hostStartMs: 200 },
  );

  assert.equal(printed.exit, 1);
  callsItTheWorkingTree(printed, "whether the round host for the working tree started could not be told");
});

test("#820: a state no round took, with the episode open, is named for the working tree", async () => {
  const printed = await localReview(
    [{ ...OWN, status: "not reviewed", reason: "the reviewer was never configured" }],
    {},
    { outcome: "in-hand" },
  );

  assert.equal(printed.exit, 1);
  callsItTheWorkingTree(printed, "the working tree at 3f9c2e0 was not reviewed: the reviewer was never configured");
});
