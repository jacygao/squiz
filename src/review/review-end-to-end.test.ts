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
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { renderComment, renderReply } from "../findings/comment.ts";
import type { Finding } from "../findings/finding.ts";
import { readState, writeState, type EpisodeState } from "../loop/episode-state.ts";
import type { Episode } from "../loop/episode.ts";
import { archivesIn, githubEpisode } from "../testing/episode.ts";
import { standIn } from "../testing/stand-in.ts";
import type { Plan, PlannedStart } from "../testing/host-fixture.ts";
import type { ThreadVerdict } from "../reviewers/adapter.ts";
import { deadlineIn } from "../reviewers/deadline.ts";
import { runHook } from "../hook/hook.ts";
import { trigger } from "../host/trigger.ts";
import { waitingNotes } from "../sessions/notes.ts";
import { githubVenue } from "../venues/github/venue.ts";
import { runReview } from "./review.ts";
import { squizStatus } from "./status.ts";

const NUMBER = 41;
const BRANCH = "feature-a";
const FILE = "src/ui/card.ts";
const squiz = fileURLToPath(new URL("../../bin/squiz", import.meta.url));
const hostFixture = fileURLToPath(new URL("../testing/host-fixture.ts", import.meta.url));
const runner = fileURLToPath(new URL("../testing/review-runner.ts", import.meta.url));
const originalPath = process.env["PATH"] ?? "";

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
    line: thread.line, originalLine: thread.line, subjectType: thread.subjectType ?? "LINE",
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
    return JSON.stringify([{ number: state.number, id: "PR_pull", baseRefName: "main", headRefName: state.branch, headRefOid: head, baseRefOid: state.base, body: "", isDraft: state.draft === true }]);
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
      subjectType: posted.subject_type === "file" ? "FILE" : "LINE",
      comments: [{ id: "PRRC_" + n, databaseId: 9000 + n, body: posted.body, createdAt: "2026-10-05T07:13:05Z" }],
    });
    save();
    return http("201 Created", { id: 9000 + n, node_id: "PRRC_" + n, html_url: "https://github.com/o/r/pull/41#discussion_r" + (9000 + n) });
  }
  return "";
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
  /** Whether the pull request is a draft. */
  readonly draft?: boolean;
  /** The base commit, which the change is diffed against. */
  readonly base: string;
  threads: { id: string; isResolved: boolean; path?: string; line?: number; subjectType?: "LINE" | "FILE"; comments: { id: string; databaseId: number; body: string; createdAt: string }[] }[];
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
  writeFileSync(join(worktree, FILE), "// line 1\n", "utf8");
  git("add", ".");
  git("commit", "--quiet", "--message", "the base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(worktree, FILE), "// line 1\n// line 2\n", "utf8");
  git("commit", "--quiet", "--all", "--message", "the change under review");
  // A file of its own, so that no run adds the line saying the defaults are in
  // use. Kept out of git as this repository keeps its own.
  writeFileSync(join(worktree, ".squiz.json"), "{}", "utf8");
  appendFileSync(join(worktree, ".git", "info", "exclude"), ".squiz.json\n", "utf8");

  const ghFile = join(bin, "gh-state.json");
  const setGh = (state: GhState): void => writeFileSync(ghFile, JSON.stringify(state), "utf8");
  setGh({ number: NUMBER, branch: BRANCH, head: git("rev-parse", "HEAD"), base, threads: [], issueComments: [] });
  standIn(bin, "gh", GH, "node");
  const charterFile = join(root, "charter.md");
  writeFileSync(charterFile, "What a good review is.\n", "utf8");
  const planFile = join(root, "plan.json");
  const plan: Plan = { charterFile, starts };
  writeFileSync(planFile, JSON.stringify(plan), "utf8");

  const episode = githubEpisode(worktree, NUMBER);
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
    key: String(NUMBER),
    environment: {},
    pollMs: 100,
    host: (key) => ({ command: process.execPath, args: [hostFixture, key, fixture.planFile] }),
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
      key: String(NUMBER),
      environment: {},
      pollMs: 100,
      until: deadlineIn(20_000),
      host: (key) => ({ command: process.execPath, args: [hostFixture, key, fixture.planFile] }),
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
    const status = squizStatus(fixture.worktree, githubVenue).stdout;
    assert.ok(status.includes(`  ${refused}\n`), `squiz status did not name the refused ruling:\n${status}`);
    assert.ok(status.includes(`  ${unsent}\n`), `squiz status did not name the unsent ruling:\n${status}`);
  });
});

const UNREADABLE: PlannedStart = { findings: [], verdicts: [], unreadable: true };

test("#915: a failed round that spends the last of the cap closes the review, posts the summary of the rounds that ran, and exits 3", async () => {
  await withPullRequest([{ findings: [FINDING], verdicts: [] }, UNREADABLE, UNREADABLE], async (fixture) => {
    capAt(fixture, 2);
    const first = await review(fixture);
    assert.equal(first.exit, 2, `${first.stdout}${first.stderr}\n${hostLog(fixture.episode)}`);
    const reviewed = fixture.gh().head.slice(0, 7);
    fixture.push();

    const second = await review(fixture);

    const commit = fixture.gh().head.slice(0, 7);
    assert.equal(second.exit, 3, `the close is a person's to take: ${second.stdout}${second.stderr}\n${hostLog(fixture.episode)}`);
    assert.match(second.stdout.split("\n")[1] ?? "", new RegExp(`^Squiz did not review PR #41 at ${commit}: the review did not run: `, "u"));
    assert.match(second.stdout, /^The round cap is reached\. The review is closed with 1 thread open, and its summary$/mu);
    const [summary = "", failure = "", ...more] = fixture.gh().issueComments;
    assert.deepEqual(more, [], "the close posted more than its summary and its failure comment");
    const lines = summary.split("\n");
    assert.equal(lines[0], "**Squiz review — 2 rounds, 1 finding**");
    assert.ok(lines.includes("Fixed 0 · Withdrawn 0 · Open 1 · Disputed 0"), summary);
    assert.ok(lines.includes(`- Round 1 at ${reviewed}: raised 1 finding`), summary);
    assert.ok(lines.includes(`- Round 2 at ${commit}: found nothing new and ruled on nothing`), summary);
    assert.equal(
      lines.at(-1),
      "- The budget ran out before the review could be completed: the last attempt failed, and spent the last of the round cap. A person needs to look at this change.",
    );
    assert.match(failure, /^\*\*Squiz review failed — the review did not run: /u);
    assert.match(failure, /The review is closed: it has run 2 rounds, and the round cap allows 2\. No round runs again\. Its summary is on the pull request\./u);
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
    assert.equal(
      later.stdout.split("\n")[1],
      `Squiz's review of PR #41 closed at ${fixture.gh().head.slice(0, 7)} after 1 round, with nothing open. Only a new head commit starts another review in this worktree.`,
    );
    assert.equal(later.stderr, closing.stderr);
  });
});

test("a run after a failed round's close, without its summary, prints the failure the closing run printed (#425)", async () => {
  await withPullRequest([{ findings: [FINDING], verdicts: [] }, UNREADABLE, UNREADABLE], async (fixture) => {
    capAt(fixture, 2);
    const first = await review(fixture);
    assert.equal(first.exit, 2, `${first.stdout}${first.stderr}\n${hostLog(fixture.episode)}`);
    fixture.push();
    fixture.setGh({ ...fixture.gh(), rejectSummary: true });

    const closing = await review(fixture);
    assert.equal(closing.exit, 3, `${closing.stdout}${closing.stderr}\n${hostLog(fixture.episode)}`);
    const line = closing.stderr.split("\n").find((said) => said.startsWith("squiz: the review of PR #41 closed without its summary: "));
    assert.match(line ?? "", /403/u, closing.stderr);

    const later = await review(fixture);

    assert.equal(later.exit, 3, `${later.stdout}${later.stderr}\n${hostLog(fixture.episode)}`);
    const commit = fixture.gh().head.slice(0, 7);
    assert.match(later.stdout.split("\n")[1] ?? "", new RegExp(`^Squiz did not review PR #41 at ${commit}: the review did not run: `, "u"));
    assert.equal(later.stdout.split("\n")[2], `Squiz's review of PR #41 closed at ${commit} after 2 rounds, with 1 thread open. No round runs again in this worktree.`);
    assert.ok(later.stderr.split("\n").includes(line ?? ""), later.stderr);
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

// The terminal line is read back from the state file, and the comment is posted
// by the round, so each is checked where it lands.
test("a reviewer that is not signed in is reported so in the terminal and on the pull request, naming no model (#849)", async () => {
  await withPullRequest([{ findings: [], verdicts: [], fails: "Error: No authentication information found." }], async (fixture) => {
    const printed = await review(fixture);

    const reason = 'the reviewer could not run: the reviewer is not signed in to Copilot: it said "Error: No authentication information found."';
    assert.equal(printed.exit, 1, `${printed.stdout}${printed.stderr}\n${hostLog(fixture.episode)}`);
    const [comment] = fixture.gh().issueComments;
    assert.equal(comment?.split("\n")[0], `**Squiz review failed — ${reason}**`);
    assert.equal(
      printed.stderr,
      `squiz: review failed: ${reason}\nsquiz: the failure is posted on PR #41\n` +
        "squiz: put these lines in your report rather than running squiz review again\n",
    );
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
      key: String(NUMBER),
      environment: {},
      pollMs: 100,
      until: deadlineIn(1_500),
      host: (key) => ({ command: process.execPath, args: [hostFixture, key, fixture.planFile] }),
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

test("a draft runs no round, however often it is pushed to, and its first run once marked ready reviews the head it then has (#720)", async () => {
  await withPullRequest([{ findings: [FINDING], verdicts: [] }], async (fixture) => {
    fixture.setGh({ ...fixture.gh(), draft: true });
    const draftLine = "PR #41 is a draft. Squiz reviews it once it is marked ready for review, so there is nothing to wait for.\n";

    const opened = await review(fixture);
    assert.deepEqual(opened, { exit: 0, stdout: draftLine, stderr: "" });

    fixture.push();
    const pushed = await review(fixture);
    assert.deepEqual(pushed, { exit: 0, stdout: draftLine, stderr: "" });
    assert.equal(existsSync(fixture.episode.directory), false, "a run on a draft wrote into .squiz");

    const head = fixture.push().slice(0, 7);
    fixture.setGh({ ...fixture.gh(), draft: false });
    const ready = await review(fixture);

    assert.equal(ready.exit, 2, `${ready.stdout}${ready.stderr}\n${hostLog(fixture.episode)}`);
    assert.equal(ready.stdout.split("\n")[1], `Squiz reviewed PR #41 at ${head}: round 1 of 3, 1 new finding.`);
    assert.equal(started(fixture), 1);
  });
});

test("the round at the cap is the closing round: it opens threads for new findings, and a fix pushed after it runs no reviewer (#718)", async () => {
  const starts: PlannedStart[] = [
    { findings: [FINDING], verdicts: [] },
    { findings: [SECOND_FINDING], verdicts: [{ thread: "PRRT_1", verdict: "open", reason: KEPT_OPEN }] },
    { findings: [], verdicts: [{ thread: "PRRT_1", verdict: "fixed" }, { thread: "PRRT_2", verdict: "fixed" }] },
  ];
  await withPullRequest(starts, async (fixture) => {
    capAt(fixture, 2);
    const first = await review(fixture);
    assert.equal(first.exit, 2, `${first.stdout}${first.stderr}\n${hostLog(fixture.episode)}`);

    const atCap = fixture.push().slice(0, 7);
    const closing = await review(fixture);

    assert.equal(closing.exit, 3, `${closing.stdout}${closing.stderr}\n${hostLog(fixture.episode)}`);
    assert.deepEqual(closing.stdout.split("\n").slice(1, 6), [
      `Squiz reviewed PR #41 at ${atCap}: round 2 of 2, 1 new finding.`,
      "",
      "The round cap is reached. The review is closed with 2 threads open, and its summary",
      "is on the pull request. A person takes it from here, so do not run",
      "`squiz review 41` again.",
    ]);
    assert.deepEqual(
      fixture.gh().threads.map((thread) => [thread.id, thread.isResolved]),
      [["PRRT_1", false], ["PRRT_2", false]],
      "the round at the cap did not open a thread for its new finding",
    );

    const pushed = fixture.push();
    const after = await review(fixture);

    assert.equal(after.exit, 3, `${after.stdout}${after.stderr}\n${hostLog(fixture.episode)}`);
    assert.deepEqual(
      after.stdout.split("\n").slice(1, 3),
      [
        `Squiz did not review PR #41 at ${pushed.slice(0, 7)}: the episode closed at the round cap, after reviewing ${atCap}.`,
        `Squiz's review of PR #41 closed at ${atCap} after 2 rounds, with 2 threads open. No round runs again in this worktree.`,
      ],
      "#832, #844: a run reporting an old close must name the head it did not review, and the head the close was about",
    );
    assert.equal(started(fixture), 2, "a round ran after the round at the cap");
    assert.equal(fixture.gh().issueComments.length, 1, "a second summary was posted");
    assert.equal(stateOf(fixture.episode).rounds.length, 2);
    assert.equal(stateOf(fixture.episode).records?.find((record) => record.head === pushed), undefined, "#832: a close at the cap queued the head pushed after it");
    assert.deepEqual(archivesIn(fixture.episode), [], "#832: a close at the cap started a new episode");
  });
});

test("a close at the token bound with threads open runs no reviewer for a fix after it, though the bound was raised since (#587)", async () => {
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

    // Raised after the close, so the bound would let another round spend.
    writeFileSync(fixture.planFile, JSON.stringify({ ...plan, config: { tokens: 100_000 } }), "utf8");
    fixture.push();
    const after = await review(fixture);

    assert.equal(after.exit, 3, `${after.stdout}${after.stderr}\n${hostLog(fixture.episode)}`);
    assert.equal(started(fixture), 1, "a round ran after a close at the token bound");
    assert.equal(fixture.gh().issueComments.length, 1);
  });
});

test("a failed round that closed the review at the cap runs no reviewer for a fix after it (#587)", async () => {
  const starts: PlannedStart[] = [
    { findings: [FINDING], verdicts: [] },
    UNREADABLE,
    UNREADABLE,
    { findings: [], verdicts: [{ thread: "PRRT_1", verdict: "fixed" }] },
  ];
  await withPullRequest(starts, async (fixture) => {
    capAt(fixture, 2);
    const first = await review(fixture);
    assert.equal(first.exit, 2, `${first.stdout}${first.stderr}\n${hostLog(fixture.episode)}`);
    fixture.push();
    const closed = await review(fixture);
    assert.equal(closed.exit, 3, `${closed.stdout}${closed.stderr}\n${hostLog(fixture.episode)}`);

    fixture.push();
    const after = await review(fixture);

    assert.equal(after.exit, 3, `${after.stdout}${after.stderr}\n${hostLog(fixture.episode)}`);
    assert.equal(started(fixture), 3, "a round ran after a failed round closed the review");
    assert.equal(fixture.gh().issueComments.length, 2, "a comment was posted after the close");
  });
});

/**
 * `.squiz/` as the squiz before #792 left it after one round that opened one
 * thread: copied from a real run, with a note waiting for its owner and the
 * host lock of a host that has gone.
 */
function writeEarlierEpisode(worktree: string, head: string): void {
  const squiz = join(worktree, ".squiz");
  const episode = join(squiz, "41");
  const round = join(episode, "rounds", "1");
  mkdirSync(join(round, "gh"), { recursive: true });
  mkdirSync(join(round, "session"), { recursive: true });
  writeFileSync(join(squiz, ".gitignore"), "*\n", "utf8");
  writeFileSync(join(round, "prompt.md"), "The change under review.\n", "utf8");
  writeFileSync(join(round, "reports.jsonl"), "", "utf8");
  writeFileSync(join(round, "resume.txt"), "pi --session-dir .squiz/41/rounds/1/session --session 0193f2c4\n", "utf8");
  writeFileSync(join(episode, "host.log"), `2026-11-07T08:12:49.187Z round 1: reviewing ${head.slice(0, 7)}\n`, "utf8");
  writeFileSync(join(episode, "review.txt"), "Squiz reviewed PR #41\n", "utf8");
  writeFileSync(join(episode, "host.lock"), `${JSON.stringify({ pid: process.pid, startedAt: 1_794_039_100 })}\n`, "utf8");
  const note = join(episode, "notes", "60517e1f-e1dc-49b1-8e39-6fcbe686f3fb");
  mkdirSync(note, { recursive: true });
  writeFileSync(join(note, "1794039169-0001"), "pr=41\ntext=Squiz reviewed PR #41.\n", "utf8");
  const state = {
    rounds: [
      { dollars: 0.01, tokens: 1200, messages: 1, reviewer: "pi", elapsedSeconds: 0.1, postingSeconds: 0, head, raised: 1, ruled: { fixed: 0, withdrawn: 0, open: 0 } },
    ],
    spentOutsideRounds: { dollars: 0, tokens: 0, messages: 0 },
    records: [
      {
        head,
        activity: null,
        status: "reviewed",
        result: "exited",
        exitStatus: 2,
        openThreads: ["PRRT_1"],
        round: { number: 1, startedAt: 1_794_039_169, endedAt: 1_794_039_169, reviewer: { backend: "detached" } },
        newFindings: 1,
      },
    ],
  };
  writeFileSync(join(episode, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

test("an episode the squiz before #792 wrote is read unchanged by squiz status, squiz review and the round host (#792)", async () => {
  await withPullRequest([{ findings: [], verdicts: [{ thread: "PRRT_1", verdict: "fixed" }] }], async (fixture) => {
    const head = fixture.gh().head;
    writeEarlierEpisode(fixture.worktree, head);
    fixture.setGh({
      ...fixture.gh(),
      threads: [{ id: "PRRT_1", isResolved: false, path: FILE, line: 2, comments: [{ id: "PRRC_1", databaseId: 9001, body: renderComment(FINDING), createdAt: "2026-10-05T07:13:05Z" }] }],
    });

    const status = squizStatus(fixture.worktree, githubVenue);
    assert.equal(status.stderr, "");
    assert.match(
      status.stdout,
      new RegExp(`\\n#41 +${head.slice(0, 7)} +— +reviewed .* 1 thread open +detached +\\. +pi --session-dir \\.squiz/41/rounds/1/session --session 0193f2c4\\n$`, "u"),
      `squiz status did not read the earlier episode:\n${status.stdout}`,
    );

    const again = await review(fixture);
    assert.equal(again.exit, 2, `${again.stdout}${again.stderr}`);
    assert.deepEqual(again.stdout.split("\n").slice(0, 2), [
      `Full output, to read where this is cut short: ${join(fixture.worktree, ".squiz", "41", "review.txt")}`,
      `Squiz already reviewed PR #41 at ${head.slice(0, 7)}: round 1 of 3, 1 new finding.`,
    ]);
    assert.equal(started(fixture), 0, "a run on a state already reviewed started a reviewer");

    const pushed = fixture.push();
    const next = await review(fixture);
    assert.equal(next.exit, 0, `${next.stdout}${next.stderr}\n${hostLog(fixture.episode)}`);
    assert.equal(next.stdout.split("\n")[1], `Squiz reviewed PR #41 at ${pushed.slice(0, 7)}: round 2 of 3, no new findings.`);
    assert.equal(stateOf(fixture.episode).rounds.length, 2, "the host did not count the round the earlier squiz ran");
    assert.match(hostLog(fixture.episode), /^2026-11-07T08:12:49\.187Z round 1: reviewing [0-9a-f]{7}\n(?:.*\n)*.* round 2: reviewing /u, "the host wrote a log of its own");
    assert.ok(existsSync(join(fixture.episode.directory, "rounds", "2", "prompt.md")), "round 2 was not kept beside round 1");
    assert.ok(existsSync(join(fixture.episode.directory, "notes", "60517e1f-e1dc-49b1-8e39-6fcbe686f3fb", "1794039169-0001")), "the waiting note went");
  });
});

test("#832: a push after a clean close starts a new episode in the same worktree, whose round 1 reviews the new head and posts its own summary", async () => {
  const starts: PlannedStart[] = [
    { findings: [], verdicts: [] },
    { findings: [FINDING], verdicts: [] },
  ];
  await withPullRequest(starts, async (fixture) => {
    const first = await review(fixture);
    const closedAt = fixture.gh().head;
    assert.equal(first.exit, 0, `${first.stdout}${first.stderr}\n${hostLog(fixture.episode)}`);

    const pushed = fixture.push();
    const second = await review(fixture);

    assert.equal(second.exit, 2, `${second.stdout}${second.stderr}\n${hostLog(fixture.episode)}`);
    assert.equal(
      second.stdout.split("\n")[1],
      `Squiz reviewed PR #41 at ${pushed.slice(0, 7)}: round 1 of 3, 1 new finding.`,
      "the run must report a round on the new head, never the close of the old one",
    );
    assert.equal(started(fixture), 2, "no round ran on the head pushed after the clean close");
    const live = stateOf(fixture.episode);
    assert.deepEqual(live.records?.map((record) => [record.head, record.status]), [[pushed, "reviewed"]]);
    assert.equal(live.rounds.length, 1, "the new episode must have a round cap of its own");

    const [found, ...more] = archivesIn(fixture.episode);
    assert.deepEqual(more, []);
    const archive = found ?? assert.fail("the closed episode was not archived");
    const closed = stateOf(archive);
    assert.deepEqual(closed.records?.map((record) => [record.head, record.status]), [[closedAt, "reviewed"]]);
    assert.ok(existsSync(join(archive.directory, "rounds", "1", "prompt.md")), "the closed episode's round went with it");

    const status = squizStatus(fixture.worktree, githubVenue);
    assert.match(status.stdout, new RegExp(`#41 +${pushed.slice(0, 7)} .* 1 thread open `, "u"));
    assert.match(status.stdout, new RegExp(`#41 +${closedAt.slice(0, 7)} .* nothing open, review closed `, "u"));
  });
});

test("#832: a new episode after a clean close posts its own summary when it closes", async () => {
  await withPullRequest([{ findings: [], verdicts: [] }, { findings: [], verdicts: [] }], async (fixture) => {
    const first = await review(fixture);
    assert.equal(first.exit, 0, `${first.stdout}${first.stderr}\n${hostLog(fixture.episode)}`);
    const pushed = fixture.push();

    const second = await review(fixture);

    assert.equal(second.exit, 0, `${second.stdout}${second.stderr}\n${hostLog(fixture.episode)}`);
    assert.equal(second.stdout.split("\n")[1], `Squiz reviewed PR #41 at ${pushed.slice(0, 7)}: round 1 of 3, no new findings.`);
    assert.equal(fixture.gh().issueComments.length, 2, "the new episode posted no summary of its own");
  });
});

test("#832: new replies after a clean close, with the same head, start nothing, and the run names the head the close was about", async () => {
  const starts: PlannedStart[] = [
    { findings: [FINDING], verdicts: [] },
    { findings: [], verdicts: [{ thread: "PRRT_1", verdict: "withdrawn", reason: "The header already says it." }] },
  ];
  await withPullRequest(starts, async (fixture) => {
    const reply = (id: string, databaseId: number): void => {
      const gh = fixture.gh();
      gh.threads[0]?.comments.push({ id, databaseId, body: renderReply("The line is a fixture."), createdAt: "2026-10-05T07:20:00Z" });
      fixture.setGh(gh);
    };
    assert.equal((await review(fixture)).exit, 2);
    reply("PRRC_reply", 9500);
    const closing = await review(fixture);
    assert.equal(closing.exit, 0, `${closing.stdout}${closing.stderr}\n${hostLog(fixture.episode)}`);
    const head = fixture.gh().head.slice(0, 7);

    reply("PRRC_again", 9501);
    const after = await review(fixture);

    assert.equal(after.exit, 0, `${after.stdout}${after.stderr}\n${hostLog(fixture.episode)}`);
    assert.equal(
      after.stdout.split("\n")[1],
      `Squiz's review of PR #41 closed at ${head} after 2 rounds, with nothing open. Only a new head commit starts another review in this worktree.`,
    );
    assert.equal(started(fixture), 2, "a reply alone after a clean close started a round");
    assert.deepEqual(archivesIn(fixture.episode), []);
  });
});

/** Give the fixture's worktree a remote it has pushed its branch to, so that `@{push}` names a commit. */
function pushedToARemote(fixture: Fixture): (args: readonly string[]) => string {
  const remote = `${fixture.worktree}.remote.git`;
  execFileSync("git", ["init", "--quiet", "--bare", remote]);
  const git = (args: readonly string[]): string => execFileSync("git", args, { cwd: fixture.worktree, encoding: "utf8" }).trim();
  git(["remote", "add", "origin", remote]);
  git(["push", "--quiet", "--set-upstream", "origin", BRANCH]);
  return git;
}

test("#852: a run straight after a push, which GitHub still answers with the closed review's head, reviews the pushed commit rather than exiting 0 on the close", async () => {
  await withPullRequest([{ findings: [], verdicts: [] }, { findings: [], verdicts: [] }], async (fixture) => {
    const git = pushedToARemote(fixture);
    const first = await review(fixture);
    assert.equal(first.exit, 0, `${first.stdout}${first.stderr}\n${hostLog(fixture.episode)}`);
    const old = fixture.gh().head;

    const pushed = fixture.commit();
    git(["push", "--quiet"]);
    fixture.setGh({ ...fixture.gh(), head: pushed, staleHeads: [old] });
    const second = await review(fixture);

    assert.equal(
      second.stdout.split("\n")[1],
      `Squiz reviewed PR #41 at ${pushed.slice(0, 7)}: round 1 of 3, no new findings.`,
      `the run reported a review of a head it had not reviewed:\n${second.stdout}${second.stderr}\n${hostLog(fixture.episode)}`,
    );
    assert.equal(second.exit, 0);
    assert.equal(started(fixture), 2, "no round ran on the pushed commit");
  });
});

// The hook exits 0 on every path, so only the state it queued and the note the round wrote tell a working Stop from one that did nothing.
test("#910: a Stop under the GitHub venue queues its state, a round reviews it, and its owner gets a note carrying the thread the round opened", async () => {
  await withPullRequest([{ findings: [FINDING], verdicts: [] }], async (fixture) => {
    const owner = "60517e1f-e1dc-49b1-8e39-6fcbe686f3fb";
    const payload = JSON.stringify({ session_id: owner, cwd: fixture.worktree, hook_event_name: "Stop", stop_hook_active: false });
    await runHook({
      stdin: Readable.from([payload]),
      environment: {},
      trigger: (request) => trigger({ ...request, host: (key) => ({ command: process.execPath, args: [hostFixture, key, fixture.planFile] }) }),
    });

    const lock = join(fixture.episode.directory, "host.lock");
    for (let waited = 0; waited < 300 && (existsSync(lock) || !(stateOf(fixture.episode).records ?? []).some((record) => record.status === "reviewed")); waited += 1) await sleep(100);
    const [record] = stateOf(fixture.episode).records ?? [];
    assert.ok(record?.status === "reviewed" && record.result === "exited" && record.exitStatus === 2, `the Stop's state was recorded as ${JSON.stringify(record)}\n${hostLog(fixture.episode)}`);
    assert.equal(record.owner?.sessionId, owner, "the state was not recorded as the Stop's session's");
    const listed = waitingNotes(join(fixture.episode.directory, "notes"), owner);
    assert.ok(listed.outcome === "listed", `the notes were not listed: ${JSON.stringify(listed)}`);
    const [note] = listed.notes;
    assert.ok(listed.notes.length === 1 && note?.outcome === "read", `the owner has notes ${JSON.stringify(listed.notes)}\n${hostLog(fixture.episode)}`);
    assert.match(note.fields["text"] ?? "", /^Squiz reviewed PR #41 at [0-9a-f]{7}: 1 thread is open:\n\nPRRT_1 src\/ui\/card\.ts:2 high — The new line says nothing/u);
  });
});

test("#852: commits not yet pushed leave the run on the head GitHub reports, and a closed review there exits 0 at once", async () => {
  await withPullRequest([{ findings: [], verdicts: [] }], async (fixture) => {
    pushedToARemote(fixture);
    const first = await review(fixture);
    assert.equal(first.exit, 0, `${first.stdout}${first.stderr}\n${hostLog(fixture.episode)}`);
    const head = fixture.gh().head;

    fixture.commit();
    const second = await review(fixture);

    assert.equal(second.exit, 0, `${second.stdout}${second.stderr}`);
    assert.equal(
      second.stdout.split("\n")[1],
      `Squiz's review of PR #41 closed at ${head.slice(0, 7)} after 1 round, with nothing open. Only a new head commit starts another review in this worktree.`,
    );
    assert.equal(started(fixture), 1);
  });
});

/**
 * A `copilot` that records the token in its environment beside itself, then
 * fails as a Copilot with no login does, or finishes a review with nothing
 * found, as the `copilot-mode` file beside it says.
 */
const COPILOT = String.raw`"use strict";
const fs = require("node:fs");
const path = require("node:path");
const here = path.dirname(process.argv[1]);
const argv = process.argv.slice(2);
const after = (flag) => argv[argv.indexOf(flag) + 1];
fs.writeFileSync(path.join(here, "copilot-token-seen"), process.env.COPILOT_GITHUB_TOKEN ?? "unset");
if (fs.readFileSync(path.join(here, "copilot-mode"), "utf8").trim() === "fail") {
  process.stderr.write("Error: No authentication information found.\n");
  process.exit(1);
}
const [server] = Object.values(JSON.parse(after("--additional-mcp-config")).mcpServers);
fs.appendFileSync(server.env.SQUIZ_REPORTS, JSON.stringify({ type: "finish" }) + "\n");
fs.writeFileSync(after("--usage-output-file"), JSON.stringify({ totalNanoAiu: 5, modelMetrics: { "gpt-6-astra": { requests: { count: 1 }, usage: { inputTokens: 10, outputTokens: 2 } } } }));
`;

const PLANTED = "gho_planted914";

type CopilotRound = { readonly printed: Awaited<ReturnType<typeof review>>; readonly log: string; readonly seen: string; readonly comments: readonly string[] };

/**
 * One `squiz review` whose round runs the real Copilot adapter, under a HOME of
 * the test's own whose default token file holds `tokenFile`. The test's HOME
 * is put back afterwards, so no test reads the user's own token file.
 */
async function copilotRound(tokenFile: string, mode: "fail" | "pass"): Promise<CopilotRound> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "squiz-review-e2e-home-")));
  mkdirSync(join(home, ".config", "squiz"), { recursive: true });
  writeFileSync(join(home, ".config", "squiz", "copilot-token"), tokenFile, "utf8");
  const originalHome = process.env["HOME"];
  process.env["HOME"] = home;
  let ran: CopilotRound | undefined;
  try {
    await withPullRequest([], async (fixture) => {
      const bin = join(fixture.worktree, "..", "bin");
      standIn(bin, "copilot", COPILOT, "node");
      writeFileSync(join(bin, "copilot-mode"), mode, "utf8");
      const plan = JSON.parse(readFileSync(fixture.planFile, "utf8")) as Plan;
      writeFileSync(fixture.planFile, JSON.stringify({ ...plan, copilot: true }), "utf8");
      const printed = await review(fixture);
      const seenFile = join(bin, "copilot-token-seen");
      ran = { printed, log: hostLog(fixture.episode), seen: existsSync(seenFile) ? readFileSync(seenFile, "utf8") : "never started", comments: fixture.gh().issueComments };
    });
  } finally {
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    rmSync(home, { recursive: true, force: true });
  }
  assert.ok(ran !== undefined);
  return ran;
}

function assertNoToken(ran: CopilotRound): void {
  const outputs = { stdout: ran.printed.stdout, stderr: ran.printed.stderr, "host.log": ran.log, comments: ran.comments.join("\n") };
  for (const [name, output] of Object.entries(outputs)) assert.ok(!output.includes(PLANTED), `the token is in ${name}:\n${output}`);
}

for (const mode of ["fail", "pass"] as const) {
  test(`#914: a Copilot round signs in with the default token file, and the token reaches no output when the reviewer ${mode === "fail" ? "fails" : "finds nothing"}`, async () => {
    const ran = await copilotRound(`${PLANTED}\n`, mode);

    assertNoToken(ran);
    assert.equal(ran.printed.exit, mode === "fail" ? 1 : 0, `${ran.printed.stdout}${ran.printed.stderr}\n${ran.log}`);
    assert.equal(ran.seen, PLANTED, "Copilot was not signed in from the default file");
    assert.match(ran.comments[0] ?? "", mode === "fail" ? /^\*\*Squiz review failed/u : /\*\*Rounds\*\*/u, "the round posted no comment to search");
  });
}

test("#914: a default token file that cannot be used does not fail the round, which runs Copilot without its token", async () => {
  const ran = await copilotRound(`${PLANTED} ${PLANTED}\n`, "pass");

  assertNoToken(ran);
  assert.equal(ran.printed.exit, 0, `${ran.printed.stdout}${ran.printed.stderr}\n${ran.log}`);
  assert.notEqual(ran.seen, "never started");
  assert.ok(!ran.seen.includes(PLANTED), "Copilot was given the unusable file's contents");
});

test("#913: a round whose only finding is about the change as a whole leaves a thread on the file it names open, which squiz reply answers and the next round rules on", async () => {
  const change: Finding = {
    scope: "change",
    file: FILE,
    severity: "medium",
    headline: "The change duplicates the scheduler",
    reasoning: ["Two schedulers drift apart."],
    suggestedFix: "Use the one there is.",
  };
  const starts: PlannedStart[] = [
    { findings: [change], verdicts: [] },
    { findings: [], verdicts: [{ thread: "PRRT_1", verdict: "fixed" }] },
  ];
  await withPullRequest(starts, async (fixture) => {
    const first = await review(fixture);
    assert.equal(first.exit, 2, `a finding about the whole change left nothing open (#889):\n${first.stdout}${first.stderr}\n${hostLog(fixture.episode)}`);
    const [thread] = fixture.gh().threads;
    assert.equal(thread?.path, FILE, `the finding was not posted on the file it names: ${JSON.stringify(fixture.gh())}`);
    assert.equal(thread.subjectType, "FILE", "the finding was posted on a line rather than on the file");
    assert.match(first.stdout, /^PRRT_1 src\/ui\/card\.ts \(whole file\) medium — The change duplicates the scheduler$/mu);

    const replied = spawnSync(squiz, ["reply", "PRRT_1", "There is one scheduler now."], { cwd: fixture.worktree, encoding: "utf8" });
    assert.equal(replied.stdout, "replied in PRRT_1 on #41\n", replied.stderr);
    fixture.push();

    const second = await review(fixture);
    assert.equal(second.exit, 0, `${second.stdout}${second.stderr}\n${hostLog(fixture.episode)}`);
    const comments = fixture.gh().threads[0]?.comments.map((comment) => comment.body.split("\n", 1)[0]);
    assert.deepEqual(comments, ["**Squiz reviewer · medium — The change duplicates the scheduler**", "**Squiz coding agent**", "**Squiz reviewer · fixed**"]);
    assert.equal(fixture.gh().threads[0]?.isResolved, true, "the next round's ruling was not applied to the thread");
  });
});
