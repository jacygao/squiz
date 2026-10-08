/**
 * `squiz review` against a real round host in a real git work tree, with a fake
 * `gh` that keeps the pull request's threads in a file, and a reviewer that
 * reports what the test plans.
 *
 * The fake `gh` opens a thread for each comment the round creates, resolves one
 * when the round's verdict asks, adds the reply the round posts on a thread it
 * keeps open, and lists what it holds. A test replies on a
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
import { standIn } from "../testing/stand-in.ts";
import type { Plan, PlannedStart } from "./host-fixture.ts";
import type { ThreadVerdict } from "../reviewers/adapter.ts";
import { deadlineIn } from "../reviewers/deadline.ts";
import { runReview } from "./review.ts";
import { squizStatus } from "./status.ts";

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
    const head = (state.staleHeads ?? []).shift() ?? state.head;
    save();
    return JSON.stringify([{ number: state.number, id: "PR_pull", baseRefName: "main", headRefName: state.branch, headRefOid: head, body: "" }]);
  }
  if (argv[1] === "graphql") {
    const request = JSON.parse(body);
    const query = request.query;
    if (query.includes("addPullRequestReviewThreadReply")) {
      if (state.rejectReply) {
        return http("200 OK", { data: null, errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }] });
      }
      const thread = state.threads.find((t) => t.id === request.variables.threadId);
      const n = thread.comments.length + 1;
      thread.comments.push({ id: thread.id + "_reply" + n, databaseId: 9900 + n, body: request.variables.body, createdAt: "2026-10-05T07:25:00Z" });
      save();
      return http("200 OK", { data: { addPullRequestReviewThreadReply: { comment: { databaseId: 9900 + n } } } });
    }
    if (query.includes("resolveReviewThread")) {
      if (state.rejectResolve) {
        return http("200 OK", { data: null, errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }] });
      }
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
    if (state.rejectSummary) {
      process.stdout.write(http("403 Forbidden", { message: "Resource not accessible by integration" }));
      process.stderr.write("gh: Resource not accessible by integration (HTTP 403)\n");
      process.exitCode = 1;
      return "";
    }
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
  /** Heads the next lookups answer with, one each, before `head`: GitHub not yet showing a push. */
  readonly staleHeads?: readonly string[];
  readonly diff: string;
  threads: { id: string; isResolved: boolean; comments: { id: string; databaseId: number; body: string; createdAt: string }[] }[];
  readonly issueComments: string[];
  /** Whether GitHub refuses every review comment the round creates. */
  readonly rejectCreate?: boolean;
  /** Whether GitHub refuses every issue comment, which is how the summary is posted. */
  readonly rejectSummary?: boolean;
  /** Whether GitHub refuses every reply the round posts on a thread. */
  readonly rejectReply?: boolean;
  /** Whether GitHub refuses every resolve and re-open the round sends. */
  readonly rejectResolve?: boolean;
};

type Fixture = {
  readonly worktree: string;
  /** Commit a change in the worktree, and return its sha. The fake `gh` reports it only once it is set as the head. */
  readonly commit: () => string;
  readonly episode: Episode;
  readonly planFile: string;
  readonly gh: () => GhState;
  readonly setGh: (state: GhState) => void;
  /** Commit a change and make it the pull request's head, as a push does. Returns the commit. */
  readonly push: () => string;
};

/** Whether the repository's own `.gitignore` lists `.squiz/`, as a project set up before squiz ignored it itself did. */
type Ignores = { readonly squizInGitignore: boolean };

async function withPullRequest(
  starts: readonly PlannedStart[],
  body: (fixture: Fixture) => Promise<void>,
  { squizInGitignore }: Ignores = { squizInGitignore: true },
): Promise<void> {
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
  if (squizInGitignore) writeFileSync(join(worktree, ".gitignore"), ".squiz/\n", "utf8");
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
    const commit = (): string => {
      writeFileSync(join(worktree, FILE), "// line 1\n// line 2, which says what it is for\n", "utf8");
      git("commit", "--quiet", "--all", "--message", "say what the line is for");
      return git("rev-parse", "HEAD");
    };
    const gh = (): GhState => JSON.parse(readFileSync(ghFile, "utf8")) as GhState;
    let pushes = 0;
    const push = (): string => {
      pushes += 1;
      writeFileSync(join(worktree, FILE), `// line 1\n// line 2, fixed ${pushes}\n`, "utf8");
      git("commit", "--quiet", "--all", "--message", `fix ${pushes}`);
      const head = git("rev-parse", "HEAD");
      setGh({ ...gh(), head });
      return head;
    };
    await body({ worktree, commit, episode, planFile, gh, setGh, push });
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

const KEPT_OPEN = "A fixture still needs a line saying what it is for. Add one, or show where the header says it.";

const rulings: readonly [ThreadVerdict, number, string][] = [
  [{ thread: "PRRT_1", verdict: "withdrawn", reason: "The header already says it." }, 0, "Nothing is open. The review is closed, and its summary is on the pull request."],
  [{ thread: "PRRT_1", verdict: "open", reason: KEPT_OPEN }, 2, "1 thread is open:"],
];

for (const [ruling, exit, paragraph] of rulings) {
  test(`a disputed finding with no commit after it is a new state, whose round rules it ${ruling.verdict} and counts against the cap`, async () => {
    const starts: PlannedStart[] = [
      { findings: [FINDING], verdicts: [] },
      { findings: [], verdicts: [ruling] },
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
      const comments = fixture.gh().threads[0]?.comments ?? [];
      if (ruling.verdict !== "open") {
        assert.equal(
          comments.at(-1)?.body,
          `**Squiz reviewer · withdrawn**\n\nWithdrawn in round 2 at ${fixture.gh().head.slice(0, 7)}.\n\nThe header already says it.`,
          "the thread the reviewer closed carries no reply saying so (#586)",
        );
        assert.equal(comments.length, 3);
        const summary = fixture.gh().issueComments[0] ?? "";
        assert.match(
          summary,
          /\*\*Rounds\*\*\n\n- Round 1 at [0-9a-f]{7}: raised 1 finding\n- Round 2 at [0-9a-f]{7}: raised nothing, and ruled 1 withdrawn$/u,
        );
        return;
      }
      assert.deepEqual(
        lines.slice(5, 13),
        [
          "PRRT_1 src/ui/card.ts:2 high — The new line says nothing",
          "  - A reader cannot tell what it is for.",
          "",
          "  **Suggested fix:** Say what it is for.",
          "",
          "  **Squiz coding agent**",
          "",
          "  The line is a fixture, and says so in the file's header.",
        ],
      );
      assert.deepEqual(
        lines.slice(13, 17),
        ["", "  **Squiz reviewer · still open**", "", `  ${KEPT_OPEN}`],
        "the reviewer's reason for keeping the thread open did not reach the coding agent",
      );
      assert.equal(second.stderr, "");
    });
  });
}

test("a run straight after a reply and a push, which reads the head GitHub has not yet moved, queues the pushed commit and returns its round (#588)", async () => {
  const starts: PlannedStart[] = [
    { findings: [FINDING], verdicts: [] },
    { findings: [], verdicts: [{ thread: "PRRT_1", verdict: "fixed" }] },
  ];
  await withPullRequest(starts, async (fixture) => {
    const first = await review(fixture);
    assert.equal(first.exit, 2, `${first.stdout}${first.stderr}\n${hostLog(fixture.episode)}`);
    const old = fixture.gh().head;

    // squiz reply, git push, squiz review: GitHub lists the reply at once, and
    // answers the run's lookup with the head from before the push.
    const gh = fixture.gh();
    gh.threads[0]?.comments.push({
      id: "PRRC_reply",
      databaseId: 9500,
      body: renderReply("The line now says what it is for."),
      createdAt: "2026-10-05T07:20:00Z",
    });
    const pushed = fixture.commit();
    fixture.setGh({ ...gh, head: pushed, staleHeads: [old] });

    const second = await runReview({
      directory: fixture.worktree,
      pullRequest: NUMBER,
      environment: {},
      pollMs: 100,
      until: deadlineIn(20_000),
      host: (pullRequest) => ({ command: process.execPath, args: [hostFixture, String(pullRequest), fixture.planFile] }),
    });

    const log = hostLog(fixture.episode);
    assert.match(
      log,
      new RegExp(`round 2: ${old.slice(0, 7)} with reply PRRC_reply not reviewed: superseded by ${pushed.slice(0, 7)}\\n`, "u"),
      `the run did not read the head from before the push, so this is not the sequence #588 saw:\n${log}`,
    );
    assert.match(log, new RegExp(`round 2: reviewing ${pushed.slice(0, 7)} with reply PRRC_reply\\n`, "u"), `no round for the pushed commit started:\n${log}`);
    assert.equal(second.exit, 0, `${second.stdout}${second.stderr}\n${log}`);
    assert.equal(second.stdout.split("\n")[1], `Squiz reviewed PR #41 at ${pushed.slice(0, 7)}: round 2 of 3, no new findings.`);
    const records = stateOf(fixture.episode).records ?? [];
    assert.deepEqual(
      records.map((record) => [record.head, record.status]),
      [
        [old, "reviewed"],
        [old, "not reviewed"],
        [pushed, "reviewed"],
      ],
    );
  });
});

test("a reason GitHub refuses to post is named on stderr, and the thread stays open (#511)", async () => {
  const starts: PlannedStart[] = [
    { findings: [FINDING], verdicts: [] },
    { findings: [], verdicts: [{ thread: "PRRT_1", verdict: "open", reason: KEPT_OPEN }] },
  ];
  await withPullRequest(starts, async (fixture) => {
    const first = await review(fixture);
    assert.equal(first.exit, 2, `${first.stdout}${first.stderr}\n${hostLog(fixture.episode)}`);

    const gh = fixture.gh();
    gh.threads[0]?.comments.push({
      id: "PRRC_reply",
      databaseId: 9500,
      body: renderReply("The line is a fixture, and says so in the file's header."),
      createdAt: "2026-10-05T07:20:00Z",
    });
    fixture.setGh({ ...gh, rejectReply: true });

    const second = await review(fixture);
    assert.equal(second.exit, 2, `${second.stdout}${second.stderr}\n${hostLog(fixture.episode)}`);
    assert.match(
      second.stderr,
      /the reviewer's reply on thread PRRT_1 could not be posted: GitHub reported a GraphQL error: Resource not accessible by integration/u,
    );
    assert.equal(fixture.gh().threads[0]?.comments.length, 2);
    assert.equal(fixture.gh().threads[0]?.isResolved, false);
  });
});

test("a ruling GitHub refuses and one naming a thread never handed over are named by squiz review and squiz status (#605)", async () => {
  const starts: PlannedStart[] = [
    { findings: [FINDING], verdicts: [] },
    {
      findings: [],
      verdicts: [
        { thread: "PRRT_1", verdict: "fixed" },
        { thread: "PRRT_9", verdict: "withdrawn", reason: "The header already says it." },
      ],
    },
  ];
  await withPullRequest(starts, async (fixture) => {
    const first = await review(fixture);
    assert.equal(first.exit, 2, `${first.stdout}${first.stderr}\n${hostLog(fixture.episode)}`);

    const gh = fixture.gh();
    gh.threads[0]?.comments.push({
      id: "PRRC_reply",
      databaseId: 9500,
      body: renderReply("The line is a fixture, and says so in the file's header."),
      createdAt: "2026-10-05T07:20:00Z",
    });
    fixture.setGh({ ...gh, rejectResolve: true });

    const second = await review(fixture);
    assert.equal(
      second.exit,
      2,
      `the thread GitHub would not resolve was counted closed: ${second.stdout}${second.stderr}\n${hostLog(fixture.episode)}`,
    );
    assert.equal(fixture.gh().threads[0]?.isResolved, false);
    const refused =
      "the reviewer ruled thread PRRT_1 fixed, and it could not be resolved: GitHub reported a GraphQL error: Resource not accessible by integration";
    const unsent =
      "the reviewer ruled thread PRRT_9 withdrawn, and the ruling was not applied: no thread with that id was handed to the reviewer";
    assert.deepEqual(second.stderr.split("\n").filter((line) => line.includes("ruled thread")), [
      `squiz: ${refused}`,
      `squiz: ${unsent}`,
    ]);
    const status = squizStatus(fixture.worktree).stdout;
    assert.ok(status.includes(`  ${refused}\n`), `squiz status did not name the refused ruling:\n${status}`);
    assert.ok(status.includes(`  ${unsent}\n`), `squiz status did not name the unsent ruling:\n${status}`);
  });
});

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
        "Reviewed by `pi` on an unknown model",
        "",
        "**Needs a person**",
        "",
        "- `src/ui/card.ts:2` — The new line says nothing (disputed)",
        "",
        "**Rounds**",
        "",
        `- Round 1 at ${commit}: raised 1 finding`,
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

test("a run after a round closed without its summary prints the failure the closing run printed (#425)", async () => {
  await withPullRequest([{ findings: [], verdicts: [] }], async (fixture) => {
    fixture.setGh({ ...fixture.gh(), rejectSummary: true });

    const closing = await review(fixture);
    assert.equal(closing.exit, 0, `${closing.stdout}${closing.stderr}\n${hostLog(fixture.episode)}`);
    assert.match(closing.stderr, /^squiz: the review of PR #41 closed without its summary: .*403/u);

    const later = await review(fixture);

    assert.equal(later.exit, 0, `${later.stdout}${later.stderr}\n${hostLog(fixture.episode)}`);
    assert.equal(later.stdout.split("\n")[1], "Squiz's review of PR #41 closed after 1 round, with nothing open. No round runs again in this worktree.");
    assert.equal(later.stderr, closing.stderr);
  });
});

test("a run after a close before any review, without its summary, prints the failure the closing run printed (#425)", async () => {
  await withPullRequest([{ findings: [FINDING], verdicts: [] }], async (fixture) => {
    const first = await review(fixture);
    assert.equal(first.exit, 2, `${first.stdout}${first.stderr}\n${hostLog(fixture.episode)}`);
    const plan = JSON.parse(readFileSync(fixture.planFile, "utf8")) as Plan;
    writeFileSync(fixture.planFile, JSON.stringify({ ...plan, config: { rounds: 1 } }), "utf8");
    // A reply is a new state on the same commit, which the spent cap closes before a round takes it.
    const gh = fixture.gh();
    gh.threads[0]?.comments.push({
      id: "PRRC_reply",
      databaseId: 9500,
      body: renderReply("The line is a fixture, and says so in the file's header."),
      createdAt: "2026-10-05T07:20:00Z",
    });
    fixture.setGh({ ...gh, rejectSummary: true });

    const closing = await review(fixture);
    assert.equal(closing.exit, 3, `${closing.stdout}${closing.stderr}\n${hostLog(fixture.episode)}`);
    assert.match(closing.stderr, /^squiz: the review of PR #41 closed without its summary: .*403/u);

    const later = await review(fixture);

    assert.equal(later.exit, 3, `${later.stdout}${later.stderr}\n${hostLog(fixture.episode)}`);
    assert.equal(later.stdout.split("\n")[1], "Squiz's review of PR #41 closed after 1 round, with 1 thread open. No round runs again in this worktree.");
    assert.equal(later.stderr, closing.stderr);
  });
});

test("a round leaves the repository clean in git status, with nothing about .squiz/ in its own .gitignore (#699)", async () => {
  await withPullRequest(
    [{ findings: [FINDING], verdicts: [] }],
    async (fixture) => {
      const printed = await review(fixture);
      assert.equal(printed.exit, 2, `${printed.stdout}${printed.stderr}\n${hostLog(fixture.episode)}`);
      assert.ok(existsSync(fixture.episode.stateFile), "the round wrote no state, so git status has nothing to show either way");
      assert.ok(!existsSync(join(fixture.worktree, ".gitignore")), "the repository's own .gitignore must not be what ignores .squiz/");

      const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: fixture.worktree, encoding: "utf8" });
      assert.equal(status, "", "git status shows what squiz wrote under .squiz/ as the project's own work");
      assert.equal(readFileSync(join(fixture.worktree, ".squiz", ".gitignore"), "utf8"), "*\n");
    },
    { squizInGitignore: false },
  );
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

test("a state file that cannot be read exits 1 naming it, starts no host, and posts no comment", async () => {
  await withPullRequest([{ findings: [FINDING], verdicts: [] }], async (fixture) => {
    mkdirSync(fixture.episode.directory, { recursive: true });
    writeFileSync(fixture.episode.stateFile, "{ not json", "utf8");

    const printed = await review(fixture);

    assert.equal(printed.exit, 1, `${printed.stdout}${printed.stderr}\n${hostLog(fixture.episode)}`);
    assert.equal(printed.stdout, "");
    const [line, ...rest] = printed.stderr.split("\n");
    assert.ok(
      line?.startsWith(`squiz: no review ran: ${fixture.episode.stateFile} is not valid JSON: `),
      `the first line does not name the file and the parser's error: ${printed.stderr}`,
    );
    assert.deepEqual(rest, ["squiz: put these lines in your report rather than running squiz review again", ""]);
    assert.equal(readFileSync(fixture.episode.stateFile, "utf8"), "{ not json", "the run wrote over the file it could not read");
    assert.equal(hostLog(fixture.episode), "", "a round host was started for a state nothing queued");
    assert.deepEqual(fixture.gh().issueComments, [], "a comment was posted on the pull request");
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

const SECOND_FINDING: Finding = { ...FINDING, severity: "medium", headline: "The new line repeats the first" };

const DROPPED: Finding = { ...FINDING, severity: "low", headline: "A finding the closing round may not raise" };

/** The cap set to `rounds`, in the plan every later host reads and in the settings `squiz review` prints from. */
function capAt(fixture: Fixture, rounds: number): void {
  const plan = JSON.parse(readFileSync(fixture.planFile, "utf8")) as Plan;
  writeFileSync(fixture.planFile, JSON.stringify({ ...plan, config: { rounds } }), "utf8");
  writeFileSync(join(fixture.worktree, ".squiz.json"), JSON.stringify({ rounds }), "utf8");
}

/** How many reviewers the plan has started, across every host. */
function started(fixture: Fixture): number {
  const file = `${fixture.planFile}.started`;
  return existsSync(file) ? Number(readFileSync(file, "utf8")) : 0;
}

test("a fix pushed after the cap closed the episode gets one closing round, which rules only on the open threads and posts no finding the reviewer reports (#587)", async () => {
  const starts: PlannedStart[] = [
    { findings: [FINDING, SECOND_FINDING], verdicts: [] },
    { findings: [DROPPED], verdicts: [{ thread: "PRRT_1", verdict: "fixed" }] },
  ];
  await withPullRequest(starts, async (fixture) => {
    capAt(fixture, 1);
    const first = await review(fixture);
    assert.equal(first.exit, 3, `${first.stdout}${first.stderr}\n${hostLog(fixture.episode)}`);

    const reviewed = fixture.gh().head.slice(0, 7);
    // A person resolves the second thread, and the coding agent pushes a fix for the first.
    const gh = fixture.gh();
    const second = gh.threads[1];
    if (second !== undefined) second.isResolved = true;
    fixture.setGh(gh);
    const fixed = fixture.push().slice(0, 7);

    const closing = await review(fixture);

    assert.equal(closing.exit, 0, `${closing.stdout}${closing.stderr}\n${hostLog(fixture.episode)}`);
    assert.deepEqual(closing.stdout.split("\n").slice(1, 4), [
      `Squiz reviewed PR #41 at ${fixed}: the closing round, after 1 of 1 round.`,
      "",
      "Nothing is open. The review is closed, and its summary is on the pull request.",
    ]);
    const dropped =
      "`src/ui/card.ts:2` — A finding the closing round may not raise (reported in the closing round, which raises no findings, so it was not posted)";
    assert.equal(closing.stderr, `squiz: the closing round did not post this: ${dropped}\n`);
    assert.deepEqual(
      fixture.gh().threads.map((thread) => [thread.id, thread.isResolved]),
      [["PRRT_1", true], ["PRRT_2", true]],
      "the closing round opened a thread for a finding, or left the fixed one open",
    );

    assert.equal(
      fixture.gh().threads[0]?.comments.at(-1)?.body,
      `**Squiz reviewer · fixed**\n\nConfirmed in the closing round at ${fixed}.`,
      "the closing round's fixed verdict did not post its reply, or did not name the closing round",
    );

    const prompt = readFileSync(join(fixture.episode.directory, "rounds", "2", "prompt.md"), "utf8");
    assert.ok(prompt.includes("\n## Closing round\n"), `the closing round's prompt did not say what it is:\n${prompt}`);
    assert.ok(prompt.includes("\n### PRRT_1\n"), "the open thread was not handed over");
    assert.ok(!prompt.includes("PRRT_2"), "a resolved thread was handed to the closing round");

    const rounds = stateOf(fixture.episode).rounds;
    assert.deepEqual(rounds.map((round) => round.closing === true), [false, true], "the closing round's entry is not marked");

    const [atCap, last, ...more] = fixture.gh().issueComments;
    assert.deepEqual(more, []);
    assert.match(atCap ?? "", /^\*\*Squiz review — 1 round, 2 findings\*\*/u);
    assert.equal(
      last,
      [
        "**Squiz review — 1 round and a closing round, 2 findings**",
        "",
        "Fixed 1 · Withdrawn 0 · Open 0 · Disputed 0 · Resolved, ruling unknown 1",
        "2,400 tokens over 1 round and the closing round: 1,200, 1,200 · $0.0200",
        "Reviewed by `pi` on an unknown model",
        "",
        "**Needs a person**",
        "",
        "Nothing needs a person.",
        "",
        "**Rounds**",
        "",
        `- Round 1 at ${reviewed}: raised 2 findings`,
        `- The closing round at ${fixed}: raised nothing, and ruled 1 fixed`,
        "",
        "**Notes**",
        "",
        `- ${dropped}`,
        "- The closing round ruled on the 1 thread the round cap left open, and settled 1: `src/ui/card.ts:2` — The new line says nothing (fixed)",
      ].join("\n"),
    );
  });
});

test("a second fix after the closing round runs no round, and leaves the thread for a person with exit 3 (#587)", async () => {
  const starts: PlannedStart[] = [
    { findings: [FINDING], verdicts: [] },
    { findings: [], verdicts: [{ thread: "PRRT_1", verdict: "open", reason: KEPT_OPEN }] },
    { findings: [], verdicts: [{ thread: "PRRT_1", verdict: "fixed" }] },
  ];
  await withPullRequest(starts, async (fixture) => {
    capAt(fixture, 1);
    const first = await review(fixture);
    assert.equal(first.exit, 3, `${first.stdout}${first.stderr}\n${hostLog(fixture.episode)}`);

    const fixed = fixture.push().slice(0, 7);
    const closing = await review(fixture);
    assert.equal(closing.exit, 3, `${closing.stdout}${closing.stderr}\n${hostLog(fixture.episode)}`);
    assert.deepEqual(closing.stdout.split("\n").slice(1, 8), [
      `Squiz reviewed PR #41 at ${fixed}: the closing round, after 1 of 1 round.`,
      "",
      "The closing round is done. The review is closed with 1 thread open, and its",
      "summary is on the pull request. A person takes it from here, so do not run",
      "`squiz review 41` again.",
      "",
      "PRRT_1 src/ui/card.ts:2 high — The new line says nothing",
    ]);

    fixture.push();
    const after = await review(fixture);

    assert.equal(after.exit, 3, `${after.stdout}${after.stderr}\n${hostLog(fixture.episode)}`);
    assert.equal(
      after.stdout.split("\n")[1],
      "Squiz's review of PR #41 closed after 1 round and its closing round, with 1 thread open. No round runs again in this worktree.",
    );
    assert.equal(started(fixture), 2, "a second closing round ran");
    assert.equal(fixture.gh().threads[0]?.isResolved, false);
    assert.equal(fixture.gh().issueComments.length, 2, "a third summary was posted");
    const status = squizStatus(fixture.worktree).stdout;
    assert.ok(status.includes("1 thread open, review closed by the closing round"), `squiz status did not name the closing round:\n${status}`);
  });
});

test("a closing round whose reviewer would not start spent nothing, so its failure comment promises the retry and squiz review runs it (#587)", async () => {
  const starts: PlannedStart[] = [
    { findings: [FINDING], verdicts: [] },
    { findings: [], verdicts: [], refuse: "the provider refused the credential" },
    { findings: [], verdicts: [{ thread: "PRRT_1", verdict: "fixed" }] },
  ];
  await withPullRequest(starts, async (fixture) => {
    capAt(fixture, 1);
    const first = await review(fixture);
    assert.equal(first.exit, 3, `${first.stdout}${first.stderr}\n${hostLog(fixture.episode)}`);

    fixture.push();
    const refused = await review(fixture);
    assert.equal(refused.exit, 1, `${refused.stdout}${refused.stderr}\n${hostLog(fixture.episode)}`);
    const failure = fixture.gh().issueComments.find((body) => body.startsWith("**Squiz review failed"));
    assert.ok(
      failure?.includes("A new commit or reply, or running `squiz review` again, retries it."),
      `the failure comment of a closing round that spent nothing did not promise the retry:\n${failure}`,
    );

    const retried = await review(fixture);

    assert.equal(retried.exit, 0, `${retried.stdout}${retried.stderr}\n${hostLog(fixture.episode)}`);
    assert.match(retried.stdout.split("\n")[1] ?? "", /: the closing round, after 1 of 1 round\.$/u);
  });
});

test("a closing round's ruling on a resolved thread it was not handed is named in its summary as not handed over (#587)", async () => {
  const starts: PlannedStart[] = [
    { findings: [FINDING, SECOND_FINDING], verdicts: [] },
    { findings: [], verdicts: [{ thread: "PRRT_1", verdict: "fixed" }, { thread: "PRRT_2", verdict: "withdrawn", reason: "The line repeats nothing." }] },
  ];
  await withPullRequest(starts, async (fixture) => {
    capAt(fixture, 1);
    const first = await review(fixture);
    assert.equal(first.exit, 3, `${first.stdout}${first.stderr}\n${hostLog(fixture.episode)}`);
    const gh = fixture.gh();
    const second = gh.threads[1];
    if (second !== undefined) second.isResolved = true;
    fixture.setGh(gh);
    fixture.push();

    const closing = await review(fixture);

    assert.equal(closing.exit, 0, `${closing.stdout}${closing.stderr}\n${hostLog(fixture.episode)}`);
    const last = fixture.gh().issueComments.at(-1) ?? "";
    assert.ok(
      last.includes("- A ruling of withdrawn on thread `PRRT_2`, which was not handed to the reviewer, was not applied\n"),
      `the summary did not say the ruling named a thread never handed over:\n${last}`,
    );
  });
});

test("a token bound lowered past what the episode spent stops the closing round before its reviewer starts (#587)", async () => {
  const starts: PlannedStart[] = [
    { findings: [FINDING], verdicts: [] },
    { findings: [], verdicts: [{ thread: "PRRT_1", verdict: "fixed" }] },
  ];
  await withPullRequest(starts, async (fixture) => {
    capAt(fixture, 1);
    const first = await review(fixture);
    assert.equal(first.exit, 3, `${first.stdout}${first.stderr}\n${hostLog(fixture.episode)}`);

    // Round 1 spent 1,200 tokens, which a bound of 1,000 has been reached by.
    const plan = JSON.parse(readFileSync(fixture.planFile, "utf8")) as Plan;
    writeFileSync(fixture.planFile, JSON.stringify({ ...plan, config: { rounds: 1, tokens: 1000 } }), "utf8");
    fixture.push();

    const after = await review(fixture);

    assert.equal(after.exit, 3, `${after.stdout}${after.stderr}\n${hostLog(fixture.episode)}`);
    assert.equal(started(fixture), 1, "the closing round's reviewer ran past the token bound");
    assert.equal(fixture.gh().threads[0]?.isResolved, false);
    assert.equal(fixture.gh().issueComments.length, 1, "a second summary was posted for a closing round that never ran");
    assert.equal(stateOf(fixture.episode).rounds.length, 1);
  });
});

test("a close at the token bound with threads open leaves no closing round, so a fix after it runs no reviewer (#587)", async () => {
  const starts: PlannedStart[] = [
    { findings: [FINDING], verdicts: [] },
    { findings: [], verdicts: [{ thread: "PRRT_1", verdict: "fixed" }] },
  ];
  await withPullRequest(starts, async (fixture) => {
    // Round 1 spends 1,200 tokens, which reaches a bound of 1,000.
    const plan = JSON.parse(readFileSync(fixture.planFile, "utf8")) as Plan;
    writeFileSync(fixture.planFile, JSON.stringify({ ...plan, config: { tokens: 1000 } }), "utf8");
    const first = await review(fixture);
    assert.equal(first.exit, 3, `${first.stdout}${first.stderr}\n${hostLog(fixture.episode)}`);
    assert.match(first.stdout, /^The token bound is reached\./mu);

    // Raised after the close, so the bound would let a closing round spend.
    writeFileSync(fixture.planFile, JSON.stringify({ ...plan, config: { tokens: 100_000 } }), "utf8");
    fixture.push();
    const after = await review(fixture);

    assert.equal(after.exit, 3, `${after.stdout}${after.stderr}\n${hostLog(fixture.episode)}`);
    assert.equal(started(fixture), 1, "a closing round ran after a close at the token bound");
    assert.equal(fixture.gh().issueComments.length, 1);
  });
});

test("a close before any reviewer ran leaves no closing round, so a fix after it runs no reviewer (#587)", async () => {
  const starts: PlannedStart[] = [
    { findings: [FINDING], verdicts: [] },
    { findings: [], verdicts: [{ thread: "PRRT_1", verdict: "fixed" }] },
  ];
  await withPullRequest(starts, async (fixture) => {
    const first = await review(fixture);
    assert.equal(first.exit, 2, `${first.stdout}${first.stderr}\n${hostLog(fixture.episode)}`);
    // The cap is lowered, so the next state closes the episode before a reviewer starts.
    capAt(fixture, 1);
    fixture.push();
    const closed = await review(fixture);
    assert.equal(closed.exit, 3, `${closed.stdout}${closed.stderr}\n${hostLog(fixture.episode)}`);
    assert.match(closed.stdout, /the episode closed at the round cap before a round took this state/u);

    fixture.push();
    const after = await review(fixture);

    assert.equal(after.exit, 3, `${after.stdout}${after.stderr}\n${hostLog(fixture.episode)}`);
    assert.equal(started(fixture), 1, "a closing round ran after a close before any review");
    assert.equal(fixture.gh().issueComments.length, 1);
  });
});
