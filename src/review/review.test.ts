/**
 * `squiz review`'s wait, driven against a real state file in a real git work
 * tree. The trigger is a stand-in, so each test decides what the trigger found,
 * and the test then writes the records a round host would, while the run polls.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { renderComment } from "../findings/comment.ts";
import type { ReviewThread } from "../github/threads.ts";
import type { HostStart, Triggered, TriggerRequest } from "../host/trigger.ts";
import { writeState, type EpisodeState } from "../loop/episode-state.ts";
import { episodeAt, type Episode } from "../loop/episode.ts";
import type { StateKey, StateRecord } from "../loop/state-record.ts";
import type { TriggerDecision } from "../loop/trigger-decision.ts";
import { deadlineIn, type Deadline } from "../reviewers/deadline.ts";
import { runReview, type ReviewRequest } from "./review.ts";

const NUMBER = 41;
const OWN: StateKey = { head: "3f9c2e0a1b2c3d4e5f60718293a4b5c6d7e8f901", activity: null };
const LATER: StateKey = { head: "8d21a4f6c3b9e0d7a5f2c8b1e4d9a6c3f7b0e258", activity: null };
const POLL_MS = 20;
const NO_COST = { dollars: 0, tokens: 0, messages: 0 };

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

async function withWorktree(body: (fixture: Fixture) => Promise<void>): Promise<void> {
  // Real paths, because git answers the toplevel with symlinks resolved.
  const worktree = realpathSync(mkdtempSync(join(tmpdir(), "squiz-review-")));
  try {
    const made = spawnSync("git", ["init", "--quiet", "--initial-branch", "feature-a"], { cwd: worktree });
    assert.equal(made.status, 0);
    await body({ worktree, episode: episodeAt(worktree, NUMBER) });
  } finally {
    rmSync(worktree, { recursive: true, force: true });
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
    pullRequest: {
      number: NUMBER,
      nodeId: "PR_kwDOUEd2qM8AAAABDNPXSA",
      baseRef: "main",
      headRef: "feature-a",
      headSha: OWN.head,
      description: "",
    },
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
    pullRequest: NUMBER,
    environment: {},
    until: run.until ?? deadlineIn(10_000),
    pollMs: POLL_MS,
    trigger: (asked) => {
      handed.push(asked);
      return run.triggered;
    },
    listThreads: () => ({ outcome: "listed", threads: run.threads ?? [] }),
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
      ], { rounds: [NO_COST] });
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

test("the run's deadline is the trigger's, so the gate and the listing count against it", async () => {
  await withWorktree(async (fixture) => {
    records(fixture, [{ ...OWN, status: "reviewed", result: "exited", exitStatus: 0, openThreads: [] }], { closeReported: true, rounds: [NO_COST] });
    const handed: TriggerRequest[] = [];
    const until = deadlineIn(10_000);

    await runReview(request(fixture, { triggered: decided(fixture, { outcome: "result" }), until }, handed));

    assert.equal(handed.length, 1);
    assert.equal(handed[0]?.until, until);
    assert.equal(handed[0]?.trigger, "review");
    assert.equal(handed[0]?.pullRequest, NUMBER);
  });
});

test("a state already reviewed is returned at once, as a result the run did not produce", async () => {
  await withWorktree(async (fixture) => {
    records(fixture, [
      { ...OWN, status: "reviewed", result: "exited", exitStatus: 2, openThreads: [OPEN_THREAD.id], newFindings: 1, round: { number: 1, startedAt: 1, endedAt: 2, reviewer: { backend: "detached" } } },
    ], { rounds: [NO_COST] });
    const started = Date.now();

    const printed = await runReview(request(fixture, { triggered: decided(fixture, { outcome: "result" }, [OPEN_THREAD]) }));

    assert.equal(printed.exit, 2);
    assert.equal(printed.stdout.split("\n")[1], "Squiz already reviewed PR #41 at 3f9c2e0: round 1 of 3, 1 new finding.");
    assert.ok(Date.now() - started < 2_000, "a recorded result was waited for");
  });
});

test("a newer state reviewed while the run waits is not the run's result, and the run exits 4 at its deadline", async () => {
  await withWorktree(async (fixture) => {
    records(fixture, [
      reviewing(OWN),
      { ...LATER, status: "reviewed", result: "exited", exitStatus: 0, openThreads: [] },
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
    records(fixture, [{ ...OWN, status: "reviewed", result: "clean, episode open" }, reviewing(LATER)]);
    const finished = (async () => {
      await sleep(POLL_MS * 4);
      records(fixture, [
        { ...OWN, status: "reviewed", result: "clean, episode open" },
        { ...LATER, status: "reviewed", result: "exited", exitStatus: 2, openThreads: [OPEN_THREAD.id], newFindings: 1, round: { number: 2, startedAt: 1, endedAt: 2, reviewer: { backend: "detached" } } },
      ], { rounds: [NO_COST, NO_COST] });
    })();

    const printed = await runReview(request(fixture, { triggered: decided(fixture, { outcome: "in-hand" }), threads: [OPEN_THREAD] }));
    await finished;

    assert.equal(printed.exit, 2, printed.stdout + printed.stderr);
    assert.equal(printed.stdout.split("\n")[1], "Squiz reviewed PR #41 at 8d21a4f: round 2 of 3, 1 new finding.");
  });
});

test("a state reviewed clean with the episode open returns the close the queue ends on", async () => {
  await withWorktree(async (fixture) => {
    records(fixture, [
      { ...OWN, status: "reviewed", result: "clean, episode open" },
      { ...LATER, status: "reviewed", result: "exited", exitStatus: 0, openThreads: [], newFindings: 0, round: { number: 2, startedAt: 1, endedAt: 2, reviewer: { backend: "detached" } } },
    ], { closeReported: true, rounds: [NO_COST, NO_COST] });

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
    records(fixture, [{ ...OWN, status: "reviewed", result: "clean, episode open" }, reviewing(LATER)]);

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
    ], { rounds: [NO_COST] });

    const printed = await runReview({
      ...request(fixture, { triggered: decided(fixture, { outcome: "in-hand" }) }),
      listThreads: () => ({ outcome: "unreadable", reason: "GitHub answered 502" }),
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

test("a state left not reviewed by the cap is handed the close, with the line saying why", async () => {
  await withWorktree(async (fixture) => {
    records(fixture, [
      { ...LATER, status: "reviewed", result: "exited", exitStatus: 0, openThreads: [], newFindings: 0, round: { number: 3, startedAt: 1, endedAt: 2, reviewer: { backend: "detached" } } },
      { ...OWN, status: "not reviewed", reason: "the episode closed at the round cap, after reviewing 8d21a4f" },
    ], { closeReported: true, rounds: [NO_COST, NO_COST, NO_COST] });

    const printed = await runReview(request(fixture, { triggered: decided(fixture, { outcome: "in-hand" }) }));

    assert.equal(printed.exit, 0);
    assert.deepEqual(printed.stdout.split("\n").slice(1, 3), [
      "Squiz reviewed PR #41 at 8d21a4f: round 3 of 3, no new findings.",
      "Squiz did not review PR #41 at 3f9c2e0: the episode closed at the round cap, after reviewing 8d21a4f.",
    ]);
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
    ], { closeReported: true, rounds: [NO_COST, NO_COST, NO_COST] });

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

test("a state queued behind the one the cap stopped is handed the same close, named after it", async () => {
  await withWorktree(async (fixture) => {
    const taken: StateKey = { head: OWN.head, activity: "PRRC_older" };
    records(fixture, [
      { ...taken, status: "not reviewed", reason: BEFORE_A_ROUND, closed: { exitStatus: 0, openThreads: [], closedAt: "round cap" } },
      { ...OWN, status: "not reviewed", reason: BEFORE_A_ROUND },
    ], { closeReported: true, rounds: [NO_COST, NO_COST, NO_COST] });

    const printed = await runReview(request(fixture, { triggered: decided(fixture, { outcome: "in-hand" }) }));

    assert.equal(printed.exit, 0, printed.stdout + printed.stderr);
    assert.deepEqual(printed.stdout.split("\n").slice(1, 4), [
      `Squiz did not review PR #41 at 3f9c2e0 with different replies: ${BEFORE_A_ROUND}.`,
      "",
      "Nothing is open. The review is closed, and its summary is on the pull request.",
    ]);
  });
});

test("a close before any round ran, with nothing to summarise, exits 0 and says on stderr why there is no summary", async () => {
  await withWorktree(async (fixture) => {
    const problem = "the review of PR #41 closed without its summary: the episode closed before any round ran";
    records(fixture, [
      {
        ...OWN,
        status: "not reviewed",
        reason: "the episode closed at the token bound before a round took this state",
        closed: { exitStatus: 0, openThreads: [], closedAt: "token bound", problems: [problem] },
      },
    ], { closeReported: true });

    const printed = await runReview(request(fixture, { triggered: decided(fixture, { outcome: "in-hand" }) }));

    assert.equal(printed.exit, 0);
    assert.equal(printed.stderr, `squiz: ${problem}\n`);
    assert.equal(printed.stdout.split("\n").at(-2), "Nothing is open, and the review is closed.");
  });
});

test("a state superseded before its round started follows to the state that superseded it, and returns its result", async () => {
  await withWorktree(async (fixture) => {
    records(fixture, [
      { ...OWN, status: "not reviewed", reason: "superseded by 8d21a4f", supersededBy: LATER },
      { ...LATER, status: "reviewed", result: "exited", exitStatus: 2, openThreads: [OPEN_THREAD.id], newFindings: 1, round: { number: 1, startedAt: 1, endedAt: 2, reviewer: { backend: "detached" } } },
    ], { rounds: [NO_COST] });

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

test("a round some of whose findings failed to post keeps its status, and says how many on stderr", async () => {
  await withWorktree(async (fixture) => {
    records(fixture, [
      { ...OWN, status: "reviewed", result: "exited", exitStatus: 2, openThreads: [OPEN_THREAD.id], newFindings: 1, unposted: { failed: 1, of: 2 }, round: { number: 1, startedAt: 1, endedAt: 2, reviewer: { backend: "detached" } } },
    ], { rounds: [NO_COST] });

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
    ], { rounds: [NO_COST] });

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
      { ...LATER, status: "reviewed", result: "exited", exitStatus: 3, openThreads: [OPEN_THREAD.id], closedAt: "round cap" },
    ], { closeReported: true, rounds: [NO_COST, NO_COST, NO_COST] });

    const printed = await runReview(request(fixture, { triggered: decided(fixture, { outcome: "closed" }, [OPEN_THREAD]) }));

    assert.equal(printed.exit, 3);
    assert.equal(
      printed.stdout.split("\n")[1],
      "Squiz's review of PR #41 closed after 3 rounds, with 1 thread open. No round runs again in this worktree.",
    );
    assert.match(printed.stdout, /^PRRT_kwDOL7tYbc5abcd1 /mu);
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
      ], { rounds: [NO_COST] });
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
