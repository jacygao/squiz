/**
 * The round host is driven against a real git work tree, a fake `gh` on `PATH`
 * and the real round, whose reviewer is a process the round starts itself.
 *
 * The round is the real one because the failure most worth catching here is
 * between the two: a host that holds the episode's lock and a round that takes
 * the same lock for itself review nothing, and say only that a round is running.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { defaultConfig, type Config } from "../config/config.ts";
import type { Finding } from "../findings/finding.ts";
import { type Adapter, type ParsedRun, type RoundCost } from "../reviewers/adapter.ts";
import { deadlineIn } from "../reviewers/deadline.ts";
import { identityOf, type ProcessIdentity } from "../sessions/process.ts";
import { readState, writeState, type EpisodeState } from "../loop/episode-state.ts";
import { episodeAt, type Episode } from "../loop/episode.ts";
import { putRecord, type StateRecord } from "../loop/state-record.ts";
import { updateState } from "../loop/state-update.ts";
import { standIn } from "../testing/stand-in.ts";
import { runHost, type HostEnd, type HostSetup } from "./host.ts";

const BRANCH = "review-me";
const PULL_REQUEST = 142;
const HEAD_SHA = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";
const TRACKED = "src/ui/card.ts";
const COST: RoundCost = { dollars: 0.04, tokens: 1200, messages: 3 };

const DIFF = `
diff --git a/src/ui/card.ts b/src/ui/card.ts
index d3d0cb2..6db135b 100644
--- a/src/ui/card.ts
+++ b/src/ui/card.ts
@@ -85,7 +85,7 @@
 // line 85
 // line 86
 // line 87
-// line 88
+// line 88 CHANGED
 // line 89
 // line 90
 // line 91
`.slice(1);

type Kind = "prlist" | "diff" | "threads" | "create" | "lookup" | "summary" | "failure";

/** One state of the pull request, queued. */
function queued(head: string, activity: string | null = null): StateRecord {
  return { head, activity, status: "queued" };
}

/** What a run of the host left behind, read before the fixture is removed. */
type Hosted = {
  readonly end: HostEnd;
  readonly state: EpisodeState | null;
  /** host.log as it stands, or the empty string where the host wrote none. */
  readonly log: string;
  readonly kinds: readonly Kind[];
  /** How many reviewer processes the rounds started. */
  readonly started: number;
  /** The episode's state as each reviewer started, one entry per start. */
  readonly stateWhenStarted: readonly (EpisodeState | null)[];
  /** Whether the worktree's directory is there once the host has exited. */
  readonly worktreeLeft: boolean;
};

type Arrangement = {
  /** The records on file before the host starts, oldest first. */
  readonly records?: readonly StateRecord[];
  readonly rounds?: readonly RoundCost[];
  readonly closeReported?: boolean;
  /** What each reviewer start reports, in order. An empty review where there is none. */
  readonly findings?: readonly (readonly Finding[])[];
  readonly config?: Partial<Config>;
  /** The pull request `gh pr list` answers with, where it is not the host's. */
  readonly listedNumber?: number;
  /** Run as the reviewer starts, with the start's index from 0. */
  readonly onStart?: (index: number, episode: Episode) => void;
  /** Run before the host starts. */
  readonly before?: (episode: Episode) => void;
  readonly host?: Partial<Pick<HostSetup, "update">>;
};

async function host(arranged: Arrangement): Promise<Hosted> {
  const root = await mkdtemp(join(tmpdir(), "squiz-host-"));
  const worktree = join(root, "tree");
  const binaries = join(root, "bin");
  const previous = process.env["PATH"];
  try {
    await mkdir(worktree);
    await mkdir(binaries);
    git(worktree, ["init", "--quiet", "--initial-branch", BRANCH]);
    git(worktree, ["config", "user.email", "squiz@example.invalid"]);
    git(worktree, ["config", "user.name", "Squiz"]);
    await writeFile(join(worktree, ".gitignore"), ".squiz/\n", "utf8");
    await mkdir(join(worktree, "src", "ui"), { recursive: true });
    await writeFile(join(worktree, TRACKED), "// line 1\n", "utf8");
    git(worktree, ["add", "."]);
    git(worktree, ["commit", "--quiet", "--message", "the change under review"]);

    const episode = episodeAt(worktree, PULL_REQUEST);
    const charterFile = join(root, "charter.md");
    await writeFile(charterFile, "What a good review is.\n", "utf8");
    await writeFake(binaries, answers(arranged.listedNumber ?? PULL_REQUEST));
    process.env["PATH"] = `${binaries}:${previous ?? ""}`;

    if (arranged.records !== undefined || arranged.rounds !== undefined) {
      const written = writeState(episode, {
        rounds: arranged.rounds ?? [],
        spentOutsideRounds: { dollars: 0, tokens: 0, messages: 0 },
        ...(arranged.closeReported === undefined ? {} : { closeReported: arranged.closeReported }),
        records: arranged.records ?? [],
      });
      assert.equal(written.outcome, "written", "the fixture's own state file must be written");
    }
    arranged.before?.(episode);

    let started = 0;
    const stateWhenStarted: (EpisodeState | null)[] = [];
    const adapter: Adapter = {
      confine: () => ({ outcome: "prepared", environment: {} }),
      argv: (invocation) => {
        const read = readState(episode);
        stateWhenStarted.push(read.outcome === "read" ? read.state : null);
        arranged.onStart?.(started, episode);
        started += 1;
        return {
          command: "/bin/sh",
          args: ["-c", "exit 0"],
          directory: invocation.directory,
          stdin: "/dev/null",
          environment: {},
        };
      },
      parse: async (stdout): Promise<ParsedRun> => {
        for await (const chunk of stdout) void chunk;
        return {
          cost: COST,
          result: { kind: "reviewed", findings: arranged.findings?.[started - 1] ?? [], verdicts: [] },
        };
      },
      grants: { read: ["read"], deep: ["read", "bash"] },
    };

    const end = await runHost({
      worktree,
      pullRequest: PULL_REQUEST,
      round: { config: { ...defaultConfig, timeout: 5, ...arranged.config }, adapter, charterFile },
      ...arranged.host,
    });

    const read = existsSync(worktree) ? readState(episode) : ({ outcome: "absent" } as const);
    const logFile = join(episode.directory, "host.log");
    return {
      end,
      state: read.outcome === "read" ? read.state : null,
      log: existsSync(logFile) ? readFileSync(logFile, "utf8") : "",
      kinds: lines(join(binaries, "kinds")) as Kind[],
      started,
      stateWhenStarted,
      worktreeLeft: existsSync(worktree),
    };
  } finally {
    if (previous === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previous;
    await rm(root, { recursive: true, force: true });
  }
}

function git(directory: string, args: readonly string[]): void {
  execFileSync("git", [...args], { cwd: directory, stdio: "ignore" });
}

function lines(path: string): readonly string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((line) => line !== "");
}

function ownIdentity(): ProcessIdentity {
  const read = identityOf(process.pid, 5_000);
  assert.equal(read.outcome, "read", `this process's identity was not read: ${JSON.stringify(read)}`);
  return read.outcome === "read" ? read.identity : { pid: 0, startedAt: 0 };
}

function included(status: string, body: string): string {
  return `HTTP/2.0 ${status}\nContent-Type: application/json; charset=utf-8\r\n\r\n${body}`;
}

function answers(listed: number): Partial<Record<Kind, string>> {
  return {
    prlist: JSON.stringify([
      {
        number: listed,
        id: "PR_pull",
        baseRefName: "main",
        headRefName: BRANCH,
        headRefOid: HEAD_SHA,
        body: "What this changes.",
      },
    ]),
    diff: DIFF,
    threads: included(
      "200 OK",
      JSON.stringify({ data: { node: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } }),
    ),
    create: included(
      "201 Created",
      JSON.stringify({ id: 9001, node_id: "PRRC_9001", html_url: `https://github.com/o/r/pull/${listed}#discussion_r9001` }),
    ),
    lookup: included(
      "200 OK",
      JSON.stringify({
        data: {
          node: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ id: "PRRT_new", comments: { nodes: [{ databaseId: 9001 }] } }],
              },
            },
          },
        },
      }),
    ),
    summary: included(
      "201 Created",
      JSON.stringify({ id: 21, node_id: "IC_21", html_url: `https://github.com/o/r/pull/${listed}#issuecomment-21` }),
    ),
    failure: included(
      "201 Created",
      JSON.stringify({ id: 22, node_id: "IC_22", html_url: `https://github.com/o/r/pull/${listed}#issuecomment-22` }),
    ),
  };
}

async function writeFake(directory: string, answered: Partial<Record<Kind, string>>): Promise<void> {
  standIn(directory, "gh", GH_SCRIPT);
  for (const [kind, answer] of Object.entries(answered)) {
    await writeFile(join(directory, `answer-${kind}`), answer, "utf8");
  }
}

/** A `gh` that answers by which call it was asked for, and records the kind of each. */
const GH_SCRIPT = [
  "#!/bin/sh",
  'dir="${0%/*}"',
  'case " $* " in *" --input "*) body=$(cat) ;; *) body="" ;; esac',
  'request="$* $body"',
  "kind=unknown",
  'case "$request" in',
  "  *'PullRequestReviewComment'*) kind=lookup ;;",
  "  *'reviewThreads(first:100'*) kind=threads ;;",
  "  *'/issues/'*'/comments'*'Squiz review failed'*) kind=failure ;;",
  "  *'/issues/'*'/comments'*) kind=summary ;;",
  "  *'--method POST'*) kind=create ;;",
  "  *'pr list'*) kind=prlist ;;",
  "  *'v3.diff'*) kind=diff ;;",
  "esac",
  'printf \'%s\\n\' "$kind" >> "$dir/kinds"',
  'answer="$dir/answer-$kind"',
  'if [ ! -f "$answer" ]; then',
  '  printf \'no answer fixtured for %s\\n\' "$kind" >&2',
  "  exit 1",
  "fi",
  'cat "$answer"',
  "",
].join("\n");

function finding(headline: string): Finding {
  return {
    scope: "line",
    file: TRACKED,
    line: 88,
    severity: "high",
    headline,
    reasoning: ["The caller reads the old value."],
    suggestedFix: "Rename it.",
  };
}

function recordsOf(state: EpisodeState | null): readonly StateRecord[] {
  return state?.records ?? [];
}

/** Queue `record` the way a trigger does: under the state lock. */
function queueNow(episode: Episode, record: StateRecord): void {
  const written = updateState(
    episode,
    (state) => ({ ...state, records: putRecord(state.records ?? [], record) }),
    { until: deadlineIn(5_000) },
  );
  assert.equal(written.outcome, "written", `the fixture could not queue a state: ${JSON.stringify(written)}`);
}

test("a round the host runs reviews, rather than finding the host's own lock and reporting a round already running", async () => {
  const ran = await host({ records: [queued("aaaaaaa1")] });

  assert.equal(ran.started, 1, `the reviewer should have started once; the log says:\n${ran.log}`);
  const [record] = recordsOf(ran.state);
  assert.equal(record?.status, "reviewed", `the state is recorded as ${JSON.stringify(record)}`);
  assert.doesNotMatch(ran.log, /already running/u);
  assert.deepEqual(ran.end, { outcome: "nothing queued" });
});

test("the reviewing record names the host and the round's number before the reviewer starts", async () => {
  const self = ownIdentity();
  const ran = await host({ records: [queued("aaaaaaa1")], rounds: [COST] });

  const [atStart] = ran.stateWhenStarted;
  const [record] = recordsOf(atStart ?? null);
  assert.equal(record?.status, "reviewing", `as the reviewer started the state was ${JSON.stringify(record)}`);
  assert.ok(record?.status === "reviewing");
  assert.deepEqual(record.host, self);
  assert.deepEqual(record.round, { number: 2 });
});

test("a finished round's record keeps its number, its times and where its reviewer ran", async () => {
  const before = Math.floor(Date.now() / 1_000);
  const ran = await host({ records: [queued("aaaaaaa1")] });
  const after = Math.ceil(Date.now() / 1_000);

  const [record] = recordsOf(ran.state);
  assert.ok(record?.status === "reviewed", `recorded as ${JSON.stringify(record)}`);
  assert.equal(record.round?.number, 1);
  assert.deepEqual(record.round?.reviewer, { backend: "detached" });
  assert.ok((record.round?.startedAt ?? 0) >= before && (record.round?.endedAt ?? Infinity) <= after);
});

test("a state queued while a round runs is reviewed before the host exits", async () => {
  const ran = await host({
    records: [queued("aaaaaaa1")],
    // The first round leaves a thread open, so the second has something to do
    // and the episode stays open between them.
    findings: [[finding("The name says nothing.")], []],
    onStart: (index, episode) => {
      if (index === 0) queueNow(episode, queued("bbbbbbb2"));
    },
  });

  assert.equal(ran.started, 2, `the queued state was not reviewed; the log says:\n${ran.log}`);
  const statuses = recordsOf(ran.state).map((record) => [record.head, record.status]);
  assert.deepEqual(statuses, [
    ["aaaaaaa1", "reviewed"],
    ["bbbbbbb2", "reviewed"],
  ]);
  const [first, second] = recordsOf(ran.state);
  assert.ok(first?.status === "reviewed" && first.result === "exited");
  assert.equal(first.exitStatus, 2);
  assert.ok(second?.status === "reviewed" && second.result === "exited");
  assert.equal(second.exitStatus, 0);
});

test("a round that leaves nothing open with a state queued behind it is reviewed clean with the episode open, and posts no summary", async () => {
  const ran = await host({ records: [queued("aaaaaaa1"), queued("bbbbbbb2")] });

  assert.equal(ran.started, 2);
  const [first, second] = recordsOf(ran.state);
  assert.ok(first?.status === "reviewed", `the first state is ${JSON.stringify(first)}`);
  assert.equal(first.result, "clean, episode open");
  assert.ok(second?.status === "reviewed" && second.result === "exited");
  assert.equal(second.exitStatus, 0);
  assert.equal(ran.kinds.filter((kind) => kind === "summary").length, 1, `gh was asked for ${ran.kinds.join(", ")}`);
  assert.equal(ran.state?.closeReported, true);
});

test("a round that closes at the cap records each state queued behind it as not reviewed, and reviews none of them", async () => {
  const ran = await host({ records: [queued("aaaaaaa1"), queued("bbbbbbb2")], config: { rounds: 1 } });

  assert.equal(ran.started, 1);
  const [first, second] = recordsOf(ran.state);
  assert.ok(first?.status === "reviewed" && first.result === "exited");
  assert.deepEqual(second, {
    head: "bbbbbbb2",
    activity: null,
    status: "not reviewed",
    reason: "the episode closed at the round cap, after reviewing aaaaaaa",
  });
});

test("the host runs no round for an episode whose close is recorded, and records its queued states not reviewed", async () => {
  const ran = await host({ records: [queued("aaaaaaa1")], rounds: [COST], closeReported: true });

  assert.equal(ran.started, 0);
  assert.deepEqual(ran.kinds, [], "nothing should have been asked of GitHub");
  const [record] = recordsOf(ran.state);
  assert.equal(record?.status, "not reviewed", `recorded as ${JSON.stringify(record)}`);
});

test("a host whose pull request is not the branch's records the state failed, and runs no reviewer", async () => {
  const ran = await host({ records: [queued("aaaaaaa1")], listedNumber: 143 });

  assert.equal(ran.started, 0);
  const [record] = recordsOf(ran.state);
  assert.ok(record?.status === "failed", `recorded as ${JSON.stringify(record)}`);
  assert.match(record.reason, /#143/u);
  assert.equal(record.round?.reviewer, undefined);
  assert.deepEqual(ran.kinds, ["prlist"], "nothing should have been posted on the other pull request");
});

test("a host that finds the lock held by a live process exits at once and changes nothing", async () => {
  const holder = spawn("/bin/sh", ["-c", "sleep 30"], { stdio: "ignore" });
  try {
    const pid = holder.pid ?? assert.fail("the holder did not start");
    const read = identityOf(pid, 5_000);
    assert.ok(read.outcome === "read");
    const ran = await host({
      records: [queued("aaaaaaa1")],
      before: (episode) => {
        mkdirSync(episode.directory, { recursive: true });
        writeFileSync(join(episode.directory, "host.lock"), `${JSON.stringify(read.identity)}\n`, "utf8");
      },
    });

    assert.deepEqual(ran.end, { outcome: "lock held", holder: read.identity });
    assert.equal(ran.started, 0);
    assert.deepEqual(recordsOf(ran.state), [queued("aaaaaaa1")]);
  } finally {
    holder.kill("SIGKILL");
  }
});

test("a reviewing record that cannot be written runs no review, and the state is recorded failed", async () => {
  let calls = 0;
  const ran = await host({
    records: [queued("aaaaaaa1")],
    host: {
      // The first write is the reviewing record's.
      update: (episode, change, options) => {
        calls += 1;
        return calls === 1 ? { outcome: "failed", reason: "the disk said no" } : updateState(episode, change, options);
      },
    },
  });

  assert.equal(ran.started, 0);
  const [record] = recordsOf(ran.state);
  assert.ok(record?.status === "failed", `recorded as ${JSON.stringify(record)}`);
  assert.match(record.reason, /the disk said no/u);
  assert.match(ran.log, /the disk said no/u);
});

test("a reviewing record that cannot be written, with a failed record that cannot be written either, is reported in host.log", async () => {
  const ran = await host({
    records: [queued("aaaaaaa1")],
    host: { update: () => ({ outcome: "failed", reason: "the disk said no" }) },
  });

  assert.equal(ran.started, 0);
  assert.deepEqual(recordsOf(ran.state), [queued("aaaaaaa1")]);
  assert.equal(ran.end.outcome, "state unwritable");
  assert.match(ran.log, /could not be recorded failed/u);
});

test("a host whose worktree is gone exits, and makes nothing where it was", async () => {
  const ran = await host({
    records: [queued("aaaaaaa1")],
    before: (episode) => rmSync(episode.worktree, { recursive: true, force: true }),
  });

  assert.deepEqual(ran.end, { outcome: "worktree gone" });
  assert.equal(ran.started, 0);
  assert.equal(ran.worktreeLeft, false, "the host made the worktree's directory again");
});

test("a host whose worktree goes during a round takes nothing more", async () => {
  const ran = await host({
    records: [queued("aaaaaaa1")],
    onStart: (_index, episode) => {
      queueNow(episode, queued("bbbbbbb2"));
      rmSync(episode.worktree, { recursive: true, force: true });
    },
  });

  assert.deepEqual(ran.end, { outcome: "worktree gone" });
  assert.equal(ran.started, 1);
});

test("the host writes what it did to host.log", async () => {
  const ran = await host({ records: [queued("aaaaaaa1")] });

  assert.match(ran.log, /aaaaaaa/u);
  assert.match(ran.log, /nothing is left queued/u);
});

