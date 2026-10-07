/**
 * `squiz review` against a real round host in a real git work tree, with a fake
 * `gh` that keeps the pull request's threads in a file, and a reviewer that
 * reports what the test plans.
 *
 * The fake `gh` opens a thread for each comment the round creates, resolves one
 * when the round's verdict asks, and lists what it holds. A test replies on a
 * thread by adding a comment to that file, which is how the coding agent's
 * `squiz reply` reaches the next listing.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { renderReply } from "../findings/comment.ts";
import type { Finding } from "../findings/finding.ts";
import { readState, writeState, type EpisodeState } from "../loop/episode-state.ts";
import { episodeAt, type Episode } from "../loop/episode.ts";
import type { Verdict } from "../findings/status.ts";
import { standIn } from "../testing/stand-in.ts";
import type { Plan, PlannedStart } from "./host-fixture.ts";
import { deadlineIn } from "../reviewers/deadline.ts";
import { runReview } from "./review.ts";

const NUMBER = 41;
const BRANCH = "feature-a";
const FILE = "src/ui/card.ts";
const hostFixture = fileURLToPath(new URL("host-fixture.ts", import.meta.url));
const runner = fileURLToPath(new URL("review-runner.ts", import.meta.url));
const originalPath = process.env["PATH"] ?? "";

const DIFF = `diff --git a/${FILE} b/${FILE}
index d3d0cb2..6db135b 100644
--- a/${FILE}
+++ b/${FILE}
@@ -1,1 +1,2 @@
 // line 1
+// line 2
`;

const FINDING: Finding = {
  scope: "line",
  file: FILE,
  line: 2,
  severity: "high",
  headline: "The new line says nothing",
  reasoning: ["A reader cannot tell what it is for."],
  suggestedFix: "Say what it is for.",
};

/**
 * The fake `gh`. It reads its whole stdin before it answers, because a `gh`
 * that answered first is reported as never having reached GitHub.
 */
const GH = String.raw`"use strict";
const fs = require("node:fs");
const path = require("node:path");
const file = path.join(path.dirname(process.argv[1]), "gh-state.json");
const argv = process.argv.slice(2);

function http(status, value) {
  return "HTTP/2.0 " + status + "\nContent-Type: application/json; charset=utf-8\r\n\r\n" + JSON.stringify(value);
}

function threadNode(thread) {
  return {
    id: thread.id, isResolved: thread.isResolved, isOutdated: false, path: thread.path,
    line: thread.line, originalLine: thread.line, subjectType: "LINE",
    comments: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: thread.comments.map((c) => ({ id: c.id, databaseId: c.databaseId, author: { login: "squiz" }, body: c.body, createdAt: c.createdAt })),
    },
  };
}

function answer(body) {
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  const save = () => fs.writeFileSync(file, JSON.stringify(state));
  const page = (nodes) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes });
  if (argv[0] === "pr") {
    return JSON.stringify([{ number: state.number, id: "PR_pull", baseRefName: "main", headRefName: state.branch, headRefOid: state.head, body: "" }]);
  }
  if (argv[1] === "graphql") {
    const request = JSON.parse(body);
    const query = request.query;
    if (query.includes("resolveReviewThread")) {
      const resolving = !query.includes("unresolveReviewThread");
      const thread = state.threads.find((t) => t.id === request.variables.threadId);
      thread.isResolved = resolving;
      save();
      const field = resolving ? "resolveReviewThread" : "unresolveReviewThread";
      return http("200 OK", { data: { [field]: { thread: { isResolved: resolving } } } });
    }
    if (query.includes("$comment")) {
      const nodes = state.threads.map((t) => ({ id: t.id, comments: { nodes: [{ databaseId: t.comments[0].databaseId }] } }));
      return http("200 OK", { data: { node: { pullRequest: { reviewThreads: page(nodes) } } } });
    }
    if (query.includes("$pullRequest")) {
      return http("200 OK", { data: { node: { reviewThreads: page(state.threads.map(threadNode)) } } });
    }
    throw new Error("no answer for the query " + query);
  }
  const at = argv.find((a) => a.startsWith("repos/"));
  if (at.includes("/issues/")) {
    state.issueComments.push(JSON.parse(body).body);
    save();
    return http("201 Created", { id: 7000 + state.issueComments.length, node_id: "IC_" + state.issueComments.length, html_url: "https://github.com/o/r/pull/41#issuecomment-1" });
  }
  if (at.endsWith("/comments")) {
    if (state.rejectCreate) {
      process.stdout.write(http("403 Forbidden", { message: "Resource not accessible by integration" }));
      process.stderr.write("gh: Resource not accessible by integration (HTTP 403)\n");
      process.exitCode = 1;
      return "";
    }
    const posted = JSON.parse(body);
    const n = state.threads.length + 1;
    state.threads.push({
      id: "PRRT_" + n, isResolved: false, path: posted.path, line: posted.line,
      comments: [{ id: "PRRC_" + n, databaseId: 9000 + n, body: posted.body, createdAt: "2026-10-05T07:13:05Z" }],
    });
    save();
    return http("201 Created", { id: 9000 + n, node_id: "PRRC_" + n, html_url: "https://github.com/o/r/pull/41#discussion_r" + (9000 + n) });
  }
  return state.diff;
}

const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  try {
    process.stdout.write(answer(Buffer.concat(chunks).toString("utf8")));
  } catch (error) {
    process.stderr.write("fake gh: " + error.message + "\n");
    process.exitCode = 1;
  }
});
`;

type GhState = {
  readonly number: number;
  readonly branch: string;
  readonly head: string;
  readonly diff: string;
  threads: { id: string; isResolved: boolean; comments: { id: string; databaseId: number; body: string; createdAt: string }[] }[];
  readonly issueComments: string[];
  /** Whether GitHub refuses every review comment the round creates. */
  readonly rejectCreate?: boolean;
};

type Fixture = {
  readonly worktree: string;
  readonly episode: Episode;
  readonly planFile: string;
  readonly gh: () => GhState;
  readonly setGh: (state: GhState) => void;
};

async function withPullRequest(starts: readonly PlannedStart[], body: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "squiz-review-e2e-")));
  const worktree = join(root, "tree");
  const bin = join(root, "bin");
  mkdirSync(join(worktree, "src", "ui"), { recursive: true });
  mkdirSync(bin);
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: worktree, encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch", BRANCH);
  git("config", "user.email", "squiz@example.invalid");
  git("config", "user.name", "Squiz");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(worktree, ".gitignore"), ".squiz/\n", "utf8");
  writeFileSync(join(worktree, FILE), "// line 1\n// line 2\n", "utf8");
  git("add", ".");
  git("commit", "--quiet", "--message", "the change under review");

  const ghFile = join(bin, "gh-state.json");
  const setGh = (state: GhState): void => writeFileSync(ghFile, JSON.stringify(state), "utf8");
  setGh({ number: NUMBER, branch: BRANCH, head: git("rev-parse", "HEAD"), diff: DIFF, threads: [], issueComments: [] });
  standIn(bin, "gh", GH, "node");
  const charterFile = join(root, "charter.md");
  writeFileSync(charterFile, "What a good review is.\n", "utf8");
  const planFile = join(root, "plan.json");
  const plan: Plan = { charterFile, starts };
  writeFileSync(planFile, JSON.stringify(plan), "utf8");

  const episode = episodeAt(worktree, NUMBER);
  process.env["PATH"] = `${bin}:${originalPath}`;
  try {
    await body({ worktree, episode, planFile, gh: () => JSON.parse(readFileSync(ghFile, "utf8")) as GhState, setGh });
  } finally {
    // A host still running would find its worktree gone and exit, so wait for it first.
    const lock = join(episode.directory, "host.lock");
    for (let waited = 0; existsSync(lock) && waited < 100; waited += 1) await sleep(100);
    process.env["PATH"] = originalPath;
    rmSync(root, { recursive: true, force: true });
  }
}

function review(fixture: Fixture) {
  return runReview({
    directory: fixture.worktree,
    pullRequest: NUMBER,
    environment: {},
    pollMs: 100,
    host: (pullRequest) => ({ command: process.execPath, args: [hostFixture, String(pullRequest), fixture.planFile] }),
  });
}

function stateOf(episode: Episode): EpisodeState {
  const read = readState(episode);
  assert.equal(read.outcome, "read", `the state file did not read: ${JSON.stringify(read)}`);
  return read.outcome === "read" ? read.state : { rounds: [], spentOutsideRounds: { dollars: 0, tokens: 0, messages: 0 } };
}

const hostLog = (episode: Episode): string => {
  const file = join(episode.directory, "host.log");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
};

const rulings: readonly [Verdict, number, string][] = [
  ["withdrawn", 0, "Nothing is open. The review is closed, and its summary is on the pull request."],
  ["open", 2, "1 thread is open:"],
];

for (const [verdict, exit, paragraph] of rulings) {
  test(`a disputed finding with no commit after it is a new state, whose round rules it ${verdict} and counts against the cap`, async () => {
    const starts: PlannedStart[] = [
      { findings: [FINDING], verdicts: [] },
      { findings: [], verdicts: [{ thread: "PRRT_1", verdict }] },
    ];
    await withPullRequest(starts, async (fixture) => {
      const first = await review(fixture);
      assert.equal(first.exit, 2, `${first.stdout}${first.stderr}\n${hostLog(fixture.episode)}`);
      assert.equal(first.stdout.split("\n")[1], "Squiz reviewed PR #41 at " + fixture.gh().head.slice(0, 7) + ": round 1 of 3, 1 new finding.");

      // The coding agent disputes the finding and pushes nothing.
      const gh = fixture.gh();
      gh.threads[0]?.comments.push({
        id: "PRRC_reply",
        databaseId: 9500,
        body: renderReply("The line is a fixture, and says so in the file's header."),
        createdAt: "2026-10-05T07:20:00Z",
      });
      fixture.setGh(gh);

      const second = await review(fixture);
      assert.equal(second.exit, exit, `${second.stdout}${second.stderr}\n${hostLog(fixture.episode)}`);
      const lines = second.stdout.split("\n");
      assert.equal(lines[1], "Squiz reviewed PR #41 at " + fixture.gh().head.slice(0, 7) + ": round 2 of 3, no new findings.");
      assert.equal(lines[3], paragraph);
      assert.equal(stateOf(fixture.episode).rounds.length, 2, "the round the reply started did not count against the cap");
    });
  });
}

test("a cap lowered after a round blocked closes the episode at the next run, which posts the summary and prints the cap (#508)", async () => {
  await withPullRequest([{ findings: [FINDING], verdicts: [] }], async (fixture) => {
    const first = await review(fixture);
    assert.equal(first.exit, 2, `${first.stdout}${first.stderr}\n${hostLog(fixture.episode)}`);

    const plan = JSON.parse(readFileSync(fixture.planFile, "utf8")) as Plan;
    writeFileSync(fixture.planFile, JSON.stringify({ ...plan, config: { rounds: 1 } }), "utf8");
    // The coding agent disputes the finding, which is a new state on the same commit.
    const gh = fixture.gh();
    gh.threads[0]?.comments.push({
      id: "PRRC_reply",
      databaseId: 9500,
      body: renderReply("The line is a fixture, and says so in the file's header."),
      createdAt: "2026-10-05T07:20:00Z",
    });
    fixture.setGh(gh);

    const second = await review(fixture);

    const commit = fixture.gh().head.slice(0, 7);
    assert.equal(second.exit, 3, `${second.stdout}${second.stderr}\n${hostLog(fixture.episode)}`);
    assert.equal(second.stderr, "");
    assert.deepEqual(second.stdout.split("\n").slice(1, 8), [
      `Squiz did not review PR #41 at ${commit} with different replies: the episode closed at the round cap before a round took this state.`,
      "",
      "The round cap is reached. The review is closed with 1 thread open, and its summary",
      "is on the pull request. A person takes it from here, so do not run",
      "`squiz review 41` again.",
      "",
      "PRRT_1 src/ui/card.ts:2 high — The new line says nothing",
    ]);
    assert.equal(stateOf(fixture.episode).rounds.length, 1, "a cap already spent ran another round");
    const [summary, ...more] = fixture.gh().issueComments;
    assert.deepEqual(more, [], "the close posted more than its one summary");
    assert.equal(
      summary,
      [
        "**Squiz review — 1 round, 1 finding**",
        "",
        "Fixed 0 · Withdrawn 0 · Open 0 · Disputed 1",
        "1,200 tokens over 1 round: 1,200 · $0.0100",
        "",
        "**Needs a person**",
        "",
        "- `src/ui/card.ts:2` — The new line says nothing (disputed)",
        "",
        "**Notes**",
        "",
        `- The episode ended at its round cap rather than with nothing left open, and did not review ${commit} with different replies`,
      ].join("\n"),
    );
  });
});

test("a bound spent before any round ran, with nothing of the reviewer's on the pull request, exits 0 and says on stderr why there is no summary (#508)", async () => {
  await withPullRequest([], async (fixture) => {
    const plan = JSON.parse(readFileSync(fixture.planFile, "utf8")) as Plan;
    writeFileSync(fixture.planFile, JSON.stringify({ ...plan, config: { tokens: 1000 } }), "utf8");
    const written = writeState(fixture.episode, { rounds: [], spentOutsideRounds: { dollars: 0, tokens: 1000, messages: 1 } });
    assert.equal(written.outcome, "written");

    const printed = await review(fixture);

    const commit = fixture.gh().head.slice(0, 7);
    assert.equal(printed.exit, 0, `${printed.stdout}${printed.stderr}\n${hostLog(fixture.episode)}`);
    assert.deepEqual(printed.stdout.split("\n").slice(1), [
      `Squiz did not review PR #41 at ${commit}: the episode closed at the token bound before a round took this state.`,
      "",
      "Nothing is open, and the review is closed.",
      "",
    ]);
    assert.equal(printed.stderr, "squiz: the review of PR #41 closed without its summary: the episode closed before any round ran\n");
    assert.deepEqual(fixture.gh().issueComments, []);
  });
});

test("a round whose only finding GitHub refused exits 1 saying it could not post it, rather than nothing open", async () => {
  await withPullRequest([{ findings: [FINDING], verdicts: [] }], async (fixture) => {
    fixture.setGh({ ...fixture.gh(), rejectCreate: true });

    const printed = await review(fixture);

    assert.equal(printed.exit, 1, `${printed.stdout}${printed.stderr}\n${hostLog(fixture.episode)}`);
    assert.equal(printed.stdout, "");
    assert.equal(
      printed.stderr,
      "squiz: review failed: round 1 found 1 finding and could not post it to PR #41\nsquiz: the failure is posted on PR #41\n" +
        "squiz: put these lines in your report rather than running squiz review again\n",
    );
  });
});

test("a round whose every finding failed to post is a failed round that leaves the episode open, so the run after an exit 4 retries it rather than printing a close (#426)", async () => {
  // The second start is the retry the next run asks for, and GitHub refuses it too.
  const refused: PlannedStart = { findings: [FINDING], verdicts: [] };
  await withPullRequest([{ ...refused, holdSeconds: 3 }, refused], async (fixture) => {
    fixture.setGh({ ...fixture.gh(), rejectCreate: true });

    const first = await runReview({
      directory: fixture.worktree,
      pullRequest: NUMBER,
      environment: {},
      pollMs: 100,
      until: deadlineIn(1_500),
      host: (pullRequest) => ({ command: process.execPath, args: [hostFixture, String(pullRequest), fixture.planFile] }),
    });
    assert.equal(first.exit, 4, `${first.stdout}${first.stderr}\n${hostLog(fixture.episode)}`);
    for (let waited = 0; waited < 200 && ["queued", "reviewing"].includes(stateOf_ifAny(fixture.episode) ?? "queued"); waited += 1) {
      await sleep(50);
    }

    const next = await review(fixture);

    assert.equal(next.exit, 1, `${next.stdout}${next.stderr}\n${hostLog(fixture.episode)}`);
    assert.equal(next.stdout, "");
    assert.match(next.stderr, /^squiz: review failed: round 2 found 1 finding and could not post it to PR #41\n/u);
    assert.notEqual(stateOf(fixture.episode).closeReported, true, "the episode closed over a finding nobody saw");
    assert.deepEqual(
      fixture.gh().issueComments.filter((body) => !body.startsWith("**Squiz review failed")),
      [],
      "a summary was posted for a round that posted none of its findings",
    );
  });
});

test("stopping a run while it waits ends only the wait, and the next run returns the round's result", async () => {
  await withPullRequest([{ findings: [FINDING], verdicts: [], holdSeconds: 2 }], async (fixture) => {
    // A group of its own, so the whole group can be stopped as a runtime stops a command.
    const child = spawn(process.execPath, [runner, String(NUMBER), fixture.planFile], {
      cwd: fixture.worktree,
      detached: true,
      stdio: "ignore",
    });
    const exited = new Promise((resolve) => child.on("exit", resolve));
    for (let waited = 0; waited < 200; waited += 1) {
      const record = stateOf_ifAny(fixture.episode);
      if (record === "reviewing") break;
      await sleep(50);
    }
    assert.equal(stateOf_ifAny(fixture.episode), "reviewing", `no round started:\n${hostLog(fixture.episode)}`);
    process.kill(-(child.pid ?? 0), "SIGKILL");
    await exited;

    for (let waited = 0; waited < 200 && stateOf_ifAny(fixture.episode) !== "reviewed"; waited += 1) await sleep(50);
    assert.equal(stateOf_ifAny(fixture.episode), "reviewed", `the round did not go on:\n${hostLog(fixture.episode)}`);

    const next = await review(fixture);
    assert.equal(next.exit, 2, next.stdout + next.stderr);
    assert.equal(next.stdout.split("\n")[1], "Squiz already reviewed PR #41 at " + fixture.gh().head.slice(0, 7) + ": round 1 of 3, 1 new finding.");
  });
});

/** The status of the first record, or `undefined` where there is none yet. */
function stateOf_ifAny(episode: Episode): string | undefined {
  const read = readState(episode);
  return read.outcome === "read" ? read.state.records?.[0]?.status : undefined;
}
