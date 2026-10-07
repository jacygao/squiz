/**
 * The round host is driven against a real git work tree, a fake `gh` on `PATH`
 * and the real round, whose reviewer is a process the round starts itself.
 *
 * The round is the real one because the failure most worth catching here is
 * between the two: a host that holds the episode's lock and a round that takes
 * the same lock for itself review nothing, and say only that a round is running.
 *
 * A state is a real commit of the work tree. `push` commits again and has `gh`
 * report the new commit as the pull request's head, which is how a test moves
 * the pull request on while the host runs.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { defaultConfig, type Config } from "../config/config.ts";
import type { Finding } from "../findings/finding.ts";
import { type Adapter, type ParsedRun, type RoundCost } from "../reviewers/adapter.ts";
import { deadlineIn } from "../reviewers/deadline.ts";
import { startChild } from "../sessions/child.ts";
import { identityOf, type ProcessIdentity } from "../sessions/process.ts";
import { readState, writeState, type EpisodeState } from "../loop/episode-state.ts";
import { episodeAt, type Episode } from "../loop/episode.ts";
import { putRecord, type Owner, type StateRecord } from "../loop/state-record.ts";
import { updateState } from "../loop/state-update.ts";
import { waitingNotes, type NoteFields } from "../sessions/notes.ts";
import { standIn } from "../testing/stand-in.ts";
import { runHost, type HostEnd, type HostSetup } from "./host.ts";

const BRANCH = "review-me";
const PULL_REQUEST = 142;
const TRACKED = "src/ui/card.ts";
const COST: RoundCost = { dollars: 0.04, tokens: 1200, messages: 3 };
const queueRacer = fileURLToPath(new URL("queue-racer.ts", import.meta.url));

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

/** One state of the pull request, queued, with the owner its trigger recorded where it had one. */
function queued(head: string, activity: string | null = null, owner?: Owner): StateRecord {
  return { head, activity, ...(owner === undefined ? {} : { owner }), status: "queued" };
}

const MAIN: Owner = { sessionId: "60517e1f-e1dc-49b1-8e39-6fcbe686f3fb" };
const PARENT: Owner = { sessionId: "7a2c9e41-0b3d-4f85-a6e2-1c9d8b7f6e50", subagent: "a402ef8f56c1b2ed1" };

/** What a test can do to the pull request and its episode while the host runs. */
type Fixture = {
  readonly episode: Episode;
  /** Where the fake `gh` keeps its answers. */
  readonly binaries: string;
  /** The pull request's head as `gh` reports it now. */
  readonly head: () => string;
  /** Commit again, have `gh` report the new commit as the head, and return it. */
  readonly push: () => string;
};

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
  /** The commit checked out where each reviewer started, one entry per start. */
  readonly reviewedCommits: readonly string[];
  /** The pull request's head before the host started. */
  readonly firstHead: string;
  /** Whether the worktree's directory is there once the host has exited. */
  readonly worktreeLeft: boolean;
  /** What the run beside the summary request printed, empty where none ran. */
  readonly summaryHook: string;
  /** The notes waiting in the episode's notes/, by session id. */
  readonly notes: Readonly<Record<string, readonly NoteFields[]>>;
  /** How many notes each session has in delivered/. */
  readonly delivered: Readonly<Record<string, number>>;
  /** Each round's resume.txt, by its round's number, where it wrote one. */
  readonly resumes: Readonly<Record<string, string>>;
};

type Arrangement = {
  /** The records on file before the host starts, oldest first. */
  readonly records?: (fixture: Fixture) => readonly StateRecord[];
  readonly rounds?: readonly RoundCost[];
  readonly closeReported?: boolean;
  /** What each reviewer start reports, in order. An empty review where there is none. */
  readonly findings?: readonly (readonly Finding[])[];
  /** Where given, every reviewer start completes no message, for this reason. */
  readonly incomplete?: string;
  readonly config?: Partial<Config>;
  /** The pull request `gh pr list` answers with, where it is not the host's. */
  readonly listedNumber?: number;
  /** Run as the reviewer starts, with the start's index from 0. */
  readonly onStart?: (index: number, fixture: Fixture) => void;
  /** Run before the host starts. */
  readonly before?: (fixture: Fixture) => void;
  readonly host?: Partial<Pick<HostSetup, "update">>;
  /** What the reviewer runs, as a script for `/bin/sh -c`, with the state file as `$1`. It exits at once where none is given. */
  readonly reviewer?: string;
  /** What every round runs with, over what the fixture gives it. */
  readonly round?: Partial<HostSetup["round"]>;
  /** The adapter's resume, where it has one. */
  readonly resume?: Adapter["resume"];
};

async function host(arranged: Arrangement): Promise<Hosted> {
  const root = await mkdtemp(join(tmpdir(), "squiz-host-"));
  const worktree = join(root, "tree");
  const binaries = join(root, "bin");
  const previous = process.env["PATH"];
  const previousTemporary = process.env["TMPDIR"];
  try {
    await mkdir(worktree);
    await mkdir(binaries);
    // Snapshots go in the temporary directory, and one a host leaves goes with the fixture.
    await mkdir(join(root, "temporary"));
    process.env["TMPDIR"] = join(root, "temporary");
    git(worktree, ["init", "--quiet", "--initial-branch", BRANCH]);
    git(worktree, ["config", "user.email", "squiz@example.invalid"]);
    git(worktree, ["config", "user.name", "Squiz"]);
    await writeFile(join(worktree, ".gitignore"), ".squiz/\n", "utf8");
    await mkdir(join(worktree, "src", "ui"), { recursive: true });
    await writeFile(join(worktree, TRACKED), "// line 1\n", "utf8");
    git(worktree, ["add", "."]);
    git(worktree, ["commit", "--quiet", "--message", "the change under review"]);

    const listed = arranged.listedNumber ?? PULL_REQUEST;
    const episode = episodeAt(worktree, PULL_REQUEST);
    const charterFile = join(root, "charter.md");
    await writeFile(charterFile, "What a good review is.\n", "utf8");
    standIn(binaries, "gh", GH_SCRIPT);
    for (const [kind, answer] of Object.entries(answers(listed))) {
      writeFileSync(join(binaries, `answer-${kind}`), answer, "utf8");
    }
    const answerHead = (head: string): void => writeFileSync(join(binaries, "answer-prlist"), prList(listed, head), "utf8");
    const head = (): string => execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim();
    answerHead(head());
    const fixture: Fixture = {
      episode,
      binaries,
      head,
      push: () => {
        appendFileSync(join(worktree, TRACKED), "// one more line\n", "utf8");
        git(worktree, ["commit", "--quiet", "--all", "--message", "a push"]);
        answerHead(head());
        return head();
      },
    };
    const firstHead = head();
    process.env["PATH"] = `${binaries}:${previous ?? ""}`;

    if (arranged.records !== undefined || arranged.rounds !== undefined) {
      const written = writeState(episode, {
        rounds: arranged.rounds ?? [],
        spentOutsideRounds: { dollars: 0, tokens: 0, messages: 0 },
        ...(arranged.closeReported === undefined ? {} : { closeReported: arranged.closeReported }),
        records: arranged.records?.(fixture) ?? [],
      });
      assert.equal(written.outcome, "written", "the fixture's own state file must be written");
    }
    arranged.before?.(fixture);

    let started = 0;
    const stateWhenStarted: (EpisodeState | null)[] = [];
    const reviewedCommits: string[] = [];
    const adapter: Adapter = {
      confine: () => ({ outcome: "prepared", environment: {} }),
      argv: (invocation) => {
        const read = readState(episode);
        stateWhenStarted.push(read.outcome === "read" ? read.state : null);
        reviewedCommits.push(
          execFileSync("git", ["rev-parse", "HEAD"], { cwd: invocation.directory, encoding: "utf8" }).trim(),
        );
        arranged.onStart?.(started, fixture);
        started += 1;
        return {
          command: "/bin/sh",
          args: ["-c", arranged.reviewer ?? "exit 0", "reviewer", episode.stateFile],
          directory: invocation.directory,
          stdin: "/dev/null",
          environment: {},
        };
      },
      parse: async (stdout): Promise<ParsedRun> => {
        for await (const chunk of stdout) void chunk;
        if (arranged.incomplete !== undefined) {
          return { cost: COST, result: { kind: "incomplete", reason: arranged.incomplete } };
        }
        return {
          cost: COST,
          result: { kind: "reviewed", findings: arranged.findings?.[started - 1] ?? [], verdicts: [] },
        };
      },
      grants: { read: ["read"], deep: ["read", "bash"] },
      ...(arranged.resume === undefined ? {} : { resume: arranged.resume }),
    };

    const end = await runHost({
      worktree,
      pullRequest: PULL_REQUEST,
      round: { config: { ...defaultConfig, timeout: 5, ...arranged.config }, adapter, charterFile, ...arranged.round },
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
      reviewedCommits,
      firstHead,
      worktreeLeft: existsSync(worktree),
      summaryHook: existsSync(join(binaries, "on-summary.out")) ? readFileSync(join(binaries, "on-summary.out"), "utf8") : "",
      notes: notesIn(episode),
      delivered: deliveredIn(episode),
      resumes: resumesIn(episode),
    };
  } finally {
    if (previous === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previous;
    if (previousTemporary === undefined) delete process.env["TMPDIR"];
    else process.env["TMPDIR"] = previousTemporary;
    await rm(root, { recursive: true, force: true });
  }
}

function notesIn(episode: Episode): Record<string, readonly NoteFields[]> {
  const directory = join(episode.directory, "notes");
  const notes: Record<string, readonly NoteFields[]> = {};
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return notes;
  for (const session of readdirSync(directory)) {
    const listed = waitingNotes(directory, session);
    assert.ok(listed.outcome === "listed", `the notes for ${session} were not listed: ${JSON.stringify(listed)}`);
    notes[session] = listed.notes.map((note) => {
      assert.ok(note.outcome === "read", `a note for ${session} did not read: ${JSON.stringify(note)}`);
      return note.fields;
    });
  }
  return notes;
}

function deliveredIn(episode: Episode): Record<string, number> {
  const directory = join(episode.directory, "notes");
  const delivered: Record<string, number> = {};
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return delivered;
  for (const session of readdirSync(directory)) {
    const moved = join(directory, session, "delivered");
    if (existsSync(moved)) delivered[session] = readdirSync(moved).length;
  }
  return delivered;
}

/**
 * The environment of a tmux server of the test's own, reading no configuration
 * and killed when the test ends. Nothing in it names the owner's tmux or Herdr.
 */
function privateTmux(t: TestContext): Record<string, string | undefined> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("HERDR_") && !name.startsWith("TMUX")),
  );
  const socketName = `squiz-host-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const tmux = (...args: string[]): string => {
    const result = spawnSync("tmux", ["-L", socketName, "-f", "/dev/null", ...args], {
      encoding: "utf8",
      env: environment,
      timeout: 10_000,
    });
    assert.equal(result.status, 0, `tmux ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  tmux("new-session", "-d", "-s", "main");
  const [socketPath = "", serverPid] = tmux("display", "-p", "-t", "main", "#{socket_path}\t#{pid}").split("\t");
  t.after(() => {
    spawnSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore", timeout: 10_000 });
    rmSync(socketPath, { force: true });
  });
  return { ...environment, TMUX: `${socketPath},${serverPid},0` };
}

function resumesIn(episode: Episode): Record<string, string> {
  const directory = join(episode.directory, "rounds");
  const resumes: Record<string, string> = {};
  if (!existsSync(directory)) return resumes;
  for (const round of readdirSync(directory)) {
    const file = join(directory, round, "resume.txt");
    if (existsSync(file)) resumes[round] = readFileSync(file, "utf8");
  }
  return resumes;
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

function prList(listed: number, head: string): string {
  return JSON.stringify([
    { number: listed, id: "PR_pull", baseRefName: "main", headRefName: BRANCH, headRefOid: head, body: "What this changes." },
  ]);
}

function answers(listed: number): Partial<Record<Kind, string>> {
  return {
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

/**
 * A `gh` that answers by which call it was asked for, and records the kind of
 * each. Where `on-<kind>.sh` sits beside it, that runs before the answer.
 */
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
  'if [ -f "$dir/on-$kind.sh" ]; then sh "$dir/on-$kind.sh" >> "$dir/on-$kind.out" 2>&1; fi',
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

/** Queue `record` under the state lock, as a trigger does. */
function queueNow(episode: Episode, record: StateRecord): void {
  const written = updateState(
    episode,
    (state) => ({ ...state, records: putRecord(state.records ?? [], record) }),
    { until: deadlineIn(5_000) },
  );
  assert.equal(written.outcome, "written", `the fixture could not queue a state: ${JSON.stringify(written)}`);
}

/** The head now, queued. */
const atHead = (fixture: Fixture): readonly StateRecord[] => [queued(fixture.head())];

test("a round the host runs reviews, rather than finding the host's own lock and reporting a round already running", async () => {
  const ran = await host({ records: atHead });

  assert.equal(ran.started, 1, `the reviewer should have started once; the log says:\n${ran.log}`);
  const [record] = recordsOf(ran.state);
  assert.equal(record?.status, "reviewed", `the state is recorded as ${JSON.stringify(record)}`);
  assert.doesNotMatch(ran.log, /already running/u);
  assert.deepEqual(ran.end, { outcome: "nothing queued" });
});

test("the reviewing record names the host and the round's number before the reviewer starts", async () => {
  const self = ownIdentity();
  const ran = await host({ records: atHead, rounds: [COST] });

  const [atStart] = ran.stateWhenStarted;
  const [record] = recordsOf(atStart ?? null);
  assert.equal(record?.status, "reviewing", `as the reviewer started the state was ${JSON.stringify(record)}`);
  assert.ok(record?.status === "reviewing");
  assert.deepEqual(record.host, self);
  assert.deepEqual(record.round, { number: 2 });
});

test("a finished round's record keeps its number, its times and where its reviewer ran", async () => {
  const before = Math.floor(Date.now() / 1_000);
  const ran = await host({ records: atHead });
  const after = Math.ceil(Date.now() / 1_000);

  const [record] = recordsOf(ran.state);
  assert.ok(record?.status === "reviewed", `recorded as ${JSON.stringify(record)}`);
  assert.equal(record.round?.number, 1);
  assert.deepEqual(record.round?.reviewer, { backend: "detached" });
  assert.ok((record.round?.startedAt ?? 0) >= before && (record.round?.endedAt ?? Infinity) <= after);
});

test("the reviewing record names the reviewer's session as soon as the reviewer starts", async (t) => {
  const seen = mkdtempSync(join(tmpdir(), "squiz-host-seen-"));
  t.after(() => rmSync(seen, { recursive: true, force: true }));
  const before = Math.floor(Date.now() / 1_000);
  // The reviewer copies the state file once it names a reviewer, and gives up
  // after five seconds, so a record written only after it exits is never seen.
  const ran = await host({
    records: atHead,
    reviewer: [
      `echo $$ > '${join(seen, "pid")}'`,
      "i=0",
      'while [ $i -lt 100 ]; do',
      `  if grep -q '"reviewer"' "$1"; then cp "$1" '${join(seen, "state.json")}'; exit 0; fi`,
      "  sleep 0.05; i=$((i + 1))",
      "done",
    ].join("\n"),
  });

  assert.ok(existsSync(join(seen, "state.json")), `no reviewing record named the reviewer while it ran; the log says:\n${ran.log}`);
  const [record] = (JSON.parse(readFileSync(join(seen, "state.json"), "utf8")) as EpisodeState).records ?? [];
  assert.ok(record?.status === "reviewing" && record.reviewer !== undefined, `the record was ${JSON.stringify(record)}`);
  const { reviewer } = record;
  assert.equal(reviewer.backend, "detached");
  assert.equal(reviewer.pane, undefined);
  assert.equal(reviewer.process.pid, Number(readFileSync(join(seen, "pid"), "utf8").trim()));
  assert.ok(reviewer.boundEndsAt >= before + 5, `the bound ends at ${reviewer.boundEndsAt}, under five seconds from ${before}`);
  assert.match(reviewer.snapshot, /\/squiz-\d+\/[0-9a-f]{16}-142\/rounds\/1\/tree$/u);
  assert.ok(reviewer.snapshot.startsWith(tmpdir()), `${reviewer.snapshot} is not in the temporary directory`);
});

test("a round writes the command that resumes its reviewer's session to its resume.txt", async () => {
  const asked: string[] = [];
  const ran = await host({
    records: atHead,
    resume: (sessionDirectory, spelled) => {
      asked.push(sessionDirectory);
      return ["pi", "--session-dir", spelled, "--session", "0193f2c4"];
    },
  });

  assert.deepEqual(ran.resumes, { "1": "pi --session-dir .squiz/142/rounds/1/session --session 0193f2c4\n" });
  assert.match(asked[0] ?? "", /^\/.*\/\.squiz\/142\/rounds\/1\/session$/u, "the session was looked for somewhere else");
});

test("the reviewer's tab opens in the Herdr workspace the state's record names", async () => {
  const workspaces: (string | undefined)[] = [];
  const ran = await host({
    records: (fixture) => [{ ...queued(fixture.head()), herdrWorkspace: "w7" }],
    round: {
      sessionEnvironment: { HERDR_SOCKET_PATH: "/nowhere/herdr.sock" },
      sessionBackends: {
        herdr: (command) => {
          workspaces.push(command.workspace);
          return { outcome: "refused", reason: "a stand-in for Herdr" };
        },
        tmux: () => ({ outcome: "refused", reason: "not asked" }),
        child: startChild,
      },
    },
  });

  assert.deepEqual(workspaces, ["w7"], `the log says:\n${ran.log}`);
});

const tmuxInstalled = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

test("a finished round's record keeps the tmux window its reviewer ran in", { skip: tmuxInstalled ? false : "tmux is not installed" }, async (t) => {
  const environment = privateTmux(t);
  const ran = await host({ records: atHead, reviewer: "sleep 1", round: { sessionEnvironment: environment } });

  const [record] = recordsOf(ran.state);
  assert.ok(record?.status === "reviewed", `recorded as ${JSON.stringify(record)}; the log says:\n${ran.log}`);
  assert.equal(record.round?.reviewer.backend, "tmux");
  assert.match(record.round?.reviewer.pane ?? "", /^@\d+$/u);
});

test("a state queued while a round runs is reviewed before the host exits", async () => {
  let pushed = "";
  const ran = await host({
    records: atHead,
    // The first round leaves a thread open, so the second has something to do
    // and the episode stays open between them.
    findings: [[finding("The name says nothing.")], []],
    onStart: (index, fixture) => {
      if (index !== 0) return;
      pushed = fixture.push();
      queueNow(fixture.episode, queued(pushed));
    },
  });

  assert.equal(ran.started, 2, `the queued state was not reviewed; the log says:\n${ran.log}`);
  const statuses = recordsOf(ran.state).map((record) => [record.head, record.status]);
  assert.deepEqual(statuses, [
    [ran.firstHead, "reviewed"],
    [pushed, "reviewed"],
  ]);
  const [first, second] = recordsOf(ran.state);
  assert.ok(first?.status === "reviewed" && first.result === "exited");
  assert.equal(first.exitStatus, 2);
  assert.ok(second?.status === "reviewed" && second.result === "exited");
  assert.equal(second.exitStatus, 0);
});

test("a round that leaves nothing open with a state queued behind it is reviewed clean with the episode open, and posts no summary", async () => {
  const ran = await host({
    records: atHead,
    onStart: (index, fixture) => {
      if (index === 0) queueNow(fixture.episode, queued(fixture.push()));
    },
  });

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
  let pushed = "";
  const ran = await host({
    records: atHead,
    config: { rounds: 1 },
    onStart: (index, fixture) => {
      if (index !== 0) return;
      pushed = fixture.push();
      queueNow(fixture.episode, queued(pushed));
    },
  });

  assert.equal(ran.started, 1);
  const [first, second] = recordsOf(ran.state);
  assert.ok(first?.status === "reviewed" && first.result === "exited");
  assert.deepEqual(second, {
    head: pushed,
    activity: null,
    status: "not reviewed",
    reason: `the episode closed at the round cap, after reviewing ${ran.firstHead.slice(0, 7)}`,
  });
});

test("a state superseded by a later commit is recorded not reviewed, and only the newest commit is reviewed, against its own state (#402)", async () => {
  let older = "";
  let newer = "";
  const ran = await host({
    records: (fixture) => {
      older = fixture.head();
      newer = fixture.push();
      return [queued(older), queued(newer)];
    },
  });

  assert.equal(ran.started, 1, `the reviewer should have run once, on the newest commit; the log says:\n${ran.log}`);
  assert.deepEqual(ran.reviewedCommits, [newer], "the reviewer read a commit other than the state it was recorded against");
  const [first, second] = recordsOf(ran.state);
  assert.deepEqual(first, {
    head: older,
    activity: null,
    status: "not reviewed",
    reason: `superseded by ${newer.slice(0, 7)}`,
    supersededBy: { head: newer, activity: null },
  });
  assert.ok(second?.status === "reviewed", `the newest state is recorded as ${JSON.stringify(second)}`);
});

test("a state superseded by a later reply on the same commit is recorded not reviewed (#402)", async () => {
  const ran = await host({
    // The fake lists no replies, so the latest activity is none.
    records: (fixture) => [queued(fixture.head(), "PRRC_withdrawn"), queued(fixture.head())],
  });

  assert.equal(ran.started, 1);
  const [first, second] = recordsOf(ran.state);
  assert.ok(first?.status === "not reviewed", `the older state is recorded as ${JSON.stringify(first)}`);
  assert.equal(first.reason, `superseded by ${ran.firstHead.slice(0, 7)} with different replies`);
  // The reason names the successor by its commit alone, which another state can share.
  assert.deepEqual(first.supersededBy, { head: ran.firstHead, activity: null });
  assert.equal(second?.status, "reviewed");
});

test("a state queued while the summary is being posted is reviewed or refused, and never stopped by a close it arrived before (#405)", async () => {
  const ran = await host({
    records: atHead,
    before: (fixture) => {
      // A push and its trigger, landing while the summary request is in flight.
      const worktree = fixture.episode.worktree;
      writeFileSync(
        join(fixture.binaries, "on-summary.sh"),
        [
          `cd '${worktree}' || exit 1`,
          "git commit --quiet --allow-empty --message 'a push during the summary'",
          'sha=$(git rev-parse HEAD)',
          `printf '[{"number":${PULL_REQUEST},"id":"PR_pull","baseRefName":"main","headRefName":"${BRANCH}","headRefOid":"%s","body":"x"}]' "$sha" > '${fixture.binaries}/answer-prlist'`,
          `'${process.execPath}' '${queueRacer}' '${worktree}' ${PULL_REQUEST} "$sha"`,
          "",
        ].join("\n"),
        "utf8",
      );
    },
  });

  assert.match(ran.summaryHook, /^(queued|closed)$/mu, `the trigger during the summary did not run: ${ran.summaryHook}`);
  const stopped = recordsOf(ran.state).filter((record) => record.status === "not reviewed");
  assert.deepEqual(stopped, [], "a state queued before the close was recorded was stopped by it");
});

test("the host runs no round for an episode whose close is recorded, and records its queued states not reviewed", async () => {
  const ran = await host({ records: atHead, rounds: [COST], closeReported: true });

  assert.equal(ran.started, 0);
  assert.deepEqual(ran.kinds, [], "nothing should have been asked of GitHub");
  const [record] = recordsOf(ran.state);
  assert.equal(record?.status, "not reviewed", `recorded as ${JSON.stringify(record)}`);
});

test("a reviewed round's record counts the threads its findings opened", async () => {
  const ran = await host({ records: atHead, findings: [[finding("The name says nothing.")]] });

  const [record] = recordsOf(ran.state);
  assert.ok(record?.status === "reviewed", `recorded as ${JSON.stringify(record)}`);
  assert.equal(record.newFindings, 1);
});

test("a round that closes at the cap with a thread open records the cap as what closed it", async () => {
  const ran = await host({ records: atHead, config: { rounds: 1 }, findings: [[finding("The name says nothing.")]] });

  const [record] = recordsOf(ran.state);
  assert.ok(record?.status === "reviewed" && record.result === "exited", `recorded as ${JSON.stringify(record)}`);
  assert.equal(record.exitStatus, 3);
  assert.equal(record.closedAt, "round cap");
});

test("a failed round records what squiz review prints after its reason, ending where its failure comment went", async () => {
  const ran = await host({ records: atHead, incomplete: "the provider refused the credential" });

  const [record] = recordsOf(ran.state);
  assert.ok(record?.status === "failed", `recorded as ${JSON.stringify(record)}`);
  assert.equal(record.lines?.at(-1), `the failure is posted on PR #${PULL_REQUEST}`);
});

test("a host whose pull request is not the branch's records the state failed, and runs no reviewer", async () => {
  const ran = await host({ records: atHead, listedNumber: 143 });

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
      records: atHead,
      before: ({ episode }) => {
        mkdirSync(episode.directory, { recursive: true });
        writeFileSync(join(episode.directory, "host.lock"), `${JSON.stringify(read.identity)}\n`, "utf8");
      },
    });

    assert.deepEqual(ran.end, { outcome: "lock held", holder: read.identity });
    assert.equal(ran.started, 0);
    assert.deepEqual(recordsOf(ran.state), [queued(ran.firstHead)]);
  } finally {
    holder.kill("SIGKILL");
  }
});

test("a reviewing record that cannot be written runs no review, and the state is recorded failed", async () => {
  let calls = 0;
  const ran = await host({
    records: atHead,
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
    records: atHead,
    host: { update: () => ({ outcome: "failed", reason: "the disk said no" }) },
  });

  assert.equal(ran.started, 0);
  assert.deepEqual(recordsOf(ran.state), [queued(ran.firstHead)]);
  assert.equal(ran.end.outcome, "state unwritable");
  assert.match(ran.log, /could not be recorded failed/u);
});

test("a host whose worktree is gone exits, and makes nothing where it was", async () => {
  const ran = await host({
    records: atHead,
    before: ({ episode }) => rmSync(episode.worktree, { recursive: true, force: true }),
  });

  assert.deepEqual(ran.end, { outcome: "worktree gone" });
  assert.equal(ran.started, 0);
  assert.equal(ran.worktreeLeft, false, "the host made the worktree's directory again");
});

test("a host whose worktree goes during a round takes nothing more", async () => {
  const ran = await host({
    records: atHead,
    onStart: (_index, fixture) => {
      queueNow(fixture.episode, queued(fixture.push()));
      rmSync(fixture.episode.worktree, { recursive: true, force: true });
    },
  });

  assert.deepEqual(ran.end, { outcome: "worktree gone" });
  assert.equal(ran.started, 1);
});

test("the host writes what it did to host.log", async () => {
  const ran = await host({ records: atHead });

  assert.match(ran.log, new RegExp(ran.firstHead.slice(0, 7), "u"));
  assert.match(ran.log, /nothing is left queued/u);
});

/** The one note waiting for `owner`, failing where there is not exactly one. */
function onlyNote(ran: Hosted, owner: Owner): NoteFields {
  const notes = ran.notes[owner.sessionId] ?? [];
  assert.equal(notes.length, 1, `${owner.sessionId} should have one note; notes/ holds ${JSON.stringify(ran.notes)}`);
  return notes[0] ?? {};
}

test("a round that leaves threads open writes its owner a note naming the pull request, the head and the subagent, which points to squiz review", async () => {
  const ran = await host({
    records: (fixture) => [queued(fixture.head(), null, PARENT)],
    findings: [[finding("The name says nothing.")]],
  });

  const short = ran.firstHead.slice(0, 7);
  assert.deepEqual(onlyNote(ran, PARENT), {
    to: PARENT.sessionId,
    pr: String(PULL_REQUEST),
    head: ran.firstHead,
    subagent: "a402ef8f56c1b2ed1",
    text: `Squiz reviewed PR #${PULL_REQUEST} at ${short}, the work of subagent a402ef8f56c1b2ed1: 1 thread is open. Run \`squiz review ${PULL_REQUEST}\` to read it.`,
  });
});

test("a round that closes the episode with nothing open writes its owner a note with no subagent field, which points to squiz review", async () => {
  const ran = await host({ records: (fixture) => [queued(fixture.head(), null, MAIN)] });

  const short = ran.firstHead.slice(0, 7);
  assert.deepEqual(onlyNote(ran, MAIN), {
    to: MAIN.sessionId,
    pr: String(PULL_REQUEST),
    head: ran.firstHead,
    text: `Squiz reviewed PR #${PULL_REQUEST} at ${short}: nothing is open, and the episode has closed. Run \`squiz review ${PULL_REQUEST}\` to read the close.`,
  });
});

test("a round that closes the episode with threads open writes its owner a note counting them", async () => {
  const ran = await host({
    records: (fixture) => [queued(fixture.head(), null, MAIN)],
    config: { rounds: 1 },
    findings: [[finding("The name says nothing.")]],
  });

  const short = ran.firstHead.slice(0, 7);
  assert.equal(
    onlyNote(ran, MAIN)["text"],
    `Squiz reviewed PR #${PULL_REQUEST} at ${short}: the episode has closed with 1 thread open. Run \`squiz review ${PULL_REQUEST}\` to read it.`,
  );
});

test("a state with no owner recorded gets no note", async () => {
  const ran = await host({ records: atHead, findings: [[finding("The name says nothing.")]] });

  assert.equal(recordsOf(ran.state)[0]?.status, "reviewed");
  assert.deepEqual(ran.notes, {});
});

test("a round reviewed clean with the episode open writes no note for its state's owner", async () => {
  const ran = await host({
    records: (fixture) => [queued(fixture.head(), null, PARENT)],
    onStart: (index, fixture) => {
      if (index === 0) queueNow(fixture.episode, queued(fixture.push(), null, MAIN));
    },
  });

  const [first] = recordsOf(ran.state);
  assert.ok(first?.status === "reviewed" && first.result === "clean, episode open", `recorded as ${JSON.stringify(first)}`);
  assert.equal(ran.notes[PARENT.sessionId], undefined, `the clean state's owner was noted: ${JSON.stringify(ran.notes)}`);
  assert.match(onlyNote(ran, MAIN)["text"] ?? "", /the episode has closed/u);
});

test("a failed round writes its owner a note giving the reason, naming squiz status and saying how it is retried, and records that it did", async () => {
  const ran = await host({ records: (fixture) => [queued(fixture.head(), null, MAIN)], listedNumber: 143 });

  const [record] = recordsOf(ran.state);
  assert.ok(record?.status === "failed", `recorded as ${JSON.stringify(record)}`);
  assert.equal(record.ownerNoted, true);
  const short = ran.firstHead.slice(0, 7);
  assert.equal(
    onlyNote(ran, MAIN)["text"],
    `Squiz could not review PR #${PULL_REQUEST} at ${short}: ${record.reason}. \`squiz status\` lists it. A new commit, or running \`squiz review ${PULL_REQUEST}\` once, retries it.`,
  );
});

/**
 * A round that reviews, finds one finding and cannot post it, which fails the
 * round after the round is counted.
 */
function postingRefused(config: Partial<Config>): Arrangement {
  return {
    records: (fixture) => [queued(fixture.head(), null, MAIN)],
    config,
    findings: [[finding("The name says nothing.")]],
    before: (fixture) => rmSync(join(fixture.binaries, "answer-create")),
  };
}

test("#622: a failed round that was the last the round cap allows tells its owner the review is closed", async () => {
  const ran = await host(postingRefused({ rounds: 1 }));

  const [record] = recordsOf(ran.state);
  assert.ok(record?.status === "failed", `recorded as ${JSON.stringify(record)}`);
  const short = ran.firstHead.slice(0, 7);
  assert.equal(
    onlyNote(ran, MAIN)["text"],
    `Squiz could not review PR #${PULL_REQUEST} at ${short}: round 1 found 1 finding and could not post it to PR #${PULL_REQUEST}. ` +
      "`squiz status` lists it. The review is closed: it has run 1 round, and the round cap allows 1. No round runs again. " +
      `A new commit, or running \`squiz review ${PULL_REQUEST}\`, posts its summary.`,
  );
});

test("#622: a failed round that reached the token bound tells its owner the review is closed", async () => {
  const ran = await host(postingRefused({ tokens: 1_000 }));

  const short = ran.firstHead.slice(0, 7);
  assert.equal(
    onlyNote(ran, MAIN)["text"],
    `Squiz could not review PR #${PULL_REQUEST} at ${short}: round 1 found 1 finding and could not post it to PR #${PULL_REQUEST}. ` +
      "`squiz status` lists it. The review is closed: it reached the token bound of 1,000 tokens. No round runs again. " +
      `A new commit, or running \`squiz review ${PULL_REQUEST}\`, posts its summary.`,
  );
});

test("#622: a failed attempt that reached the token bound before any round ran promises its owner no summary", async () => {
  const ran = await host({
    records: (fixture) => [queued(fixture.head(), null, MAIN)],
    config: { tokens: 1_000 },
    incomplete: "the provider refused the credential",
  });

  const [record] = recordsOf(ran.state);
  assert.ok(record?.status === "failed", `recorded as ${JSON.stringify(record)}`);
  const short = ran.firstHead.slice(0, 7);
  assert.equal(
    onlyNote(ran, MAIN)["text"],
    `Squiz could not review PR #${PULL_REQUEST} at ${short}: ${record.reason}. \`squiz status\` lists it. ` +
      "The review is closed: it reached the token bound of 1,000 tokens. No round runs again.",
  );
});

test("a failed state with no owner recorded is recorded as not noted", async () => {
  const ran = await host({ records: atHead, listedNumber: 143 });

  const [record] = recordsOf(ran.state);
  assert.ok(record?.status === "failed", `recorded as ${JSON.stringify(record)}`);
  assert.equal(record.ownerNoted, false);
  assert.deepEqual(ran.notes, {});
});

test("a state that fails, is queued again by squiz review and fails again gets one note", async () => {
  let requeued = false;
  const ran = await host({
    records: (fixture) => [queued(fixture.head(), null, MAIN)],
    listedNumber: 143,
    host: {
      update: (episode, change, options) => {
        const written = updateState(episode, change, options);
        const read = readState(episode);
        const [record] = read.outcome === "read" ? recordsOf(read.state) : [];
        if (!requeued && record?.status === "failed") {
          requeued = true;
          // As `squiz review` queues a failed state again: with no owner, because it records none.
          queueNow(episode, queued(record.head));
        }
        return written;
      },
    },
  });

  assert.equal(requeued, true, "the fixture never queued the failed state again");
  assert.equal(ran.log.match(/ failed: /gu)?.length, 2, `the state should have failed twice; the log says:\n${ran.log}`);
  assert.equal(ran.notes[MAIN.sessionId]?.length, 1, `notes/ holds ${JSON.stringify(ran.notes)}`);
});

test("a reviewing record that cannot be written leaves the state failed, and its owner a note", async () => {
  let calls = 0;
  const ran = await host({
    records: (fixture) => [queued(fixture.head(), null, MAIN)],
    host: {
      update: (episode, change, options) => {
        calls += 1;
        return calls === 1 ? { outcome: "failed", reason: "the disk said no" } : updateState(episode, change, options);
      },
    },
  });

  const [record] = recordsOf(ran.state);
  assert.ok(record?.status === "failed" && record.ownerNoted, `recorded as ${JSON.stringify(record)}`);
  assert.match(onlyNote(ran, MAIN)["text"] ?? "", /the disk said no/u);
});

test("each state a close leaves not reviewed gets a note for its owner saying why", async () => {
  let pushed = "";
  const ran = await host({
    records: atHead,
    config: { rounds: 1 },
    onStart: (index, fixture) => {
      if (index !== 0) return;
      pushed = fixture.push();
      queueNow(fixture.episode, queued(pushed, null, PARENT));
    },
  });

  assert.deepEqual(onlyNote(ran, PARENT), {
    to: PARENT.sessionId,
    pr: String(PULL_REQUEST),
    head: pushed,
    subagent: "a402ef8f56c1b2ed1",
    text: `Squiz did not review PR #${PULL_REQUEST} at ${pushed.slice(0, 7)}, the work of subagent a402ef8f56c1b2ed1: the episode closed at the round cap, after reviewing ${ran.firstHead.slice(0, 7)}.`,
  });
});

test("a superseded state's owner gets a note naming the state that superseded it", async () => {
  let older = "";
  let newer = "";
  const ran = await host({
    records: (fixture) => {
      older = fixture.head();
      newer = fixture.push();
      return [queued(older, null, MAIN), queued(newer)];
    },
  });

  assert.equal(
    onlyNote(ran, MAIN)["text"],
    `Squiz did not review PR #${PULL_REQUEST} at ${older.slice(0, 7)}: superseded by ${newer.slice(0, 7)}.`,
  );
});

test("a state queued on a closed episode gets a note naming it as the state with different replies where its commit repeats", async () => {
  const ran = await host({
    records: (fixture) => [queued(fixture.head(), null, PARENT), queued(fixture.head(), "PRRC_reply", MAIN)],
    rounds: [COST],
    closeReported: true,
  });

  const short = ran.firstHead.slice(0, 7);
  assert.equal(
    onlyNote(ran, MAIN)["text"],
    `Squiz did not review PR #${PULL_REQUEST} at ${short} with different replies: the episode had closed before a round took this state.`,
  );
  assert.equal(ran.notes[PARENT.sessionId]?.length, 1);
});

test("the note is written only once the result it points to is recorded", async () => {
  const notesBeforeEachWrite: number[] = [];
  const ran = await host({
    records: (fixture) => [queued(fixture.head(), null, MAIN)],
    findings: [[finding("The name says nothing.")]],
    host: {
      // Counted once the change has run and before the file takes it, which is
      // the last moment a note could be there without its result.
      update: (episode, change, options) =>
        updateState(
          episode,
          (state) => {
            const next = change(state);
            notesBeforeEachWrite.push(Object.values(notesIn(episode)).flat().length);
            return next;
          },
          options,
        ),
    },
  });

  assert.deepEqual(notesBeforeEachWrite, [0, 0, 0], "a note was there before the result it points to was written");
  assert.equal(ran.notes[MAIN.sessionId]?.length, 1);
});

test("a result that cannot be recorded writes no note", async () => {
  let calls = 0;
  const ran = await host({
    records: (fixture) => [queued(fixture.head(), null, MAIN)],
    findings: [[finding("The name says nothing.")]],
    host: {
      // The first write is the reviewing record's, the second the reviewer's
      // session, and the third the result's, which fails as a disk does: after
      // the change has been worked out.
      update: (episode, change, options) => {
        calls += 1;
        if (calls !== 3) return updateState(episode, change, options);
        const read = readState(episode);
        if (read.outcome === "read") change(read.state);
        return { outcome: "failed", reason: "the disk said no" };
      },
    },
  });

  assert.equal(ran.end.outcome, "state unwritable");
  assert.deepEqual(ran.notes, {});
});

/** A socket that reads each connection to its end, standing in for an owner session. */
async function ownerSocket(): Promise<{ readonly path: string; readonly received: () => readonly string[]; readonly close: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "squiz-owner-"));
  const path = join(directory, "s.sock");
  const received: string[] = [];
  const server = createServer((socket) => {
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (text += chunk));
    socket.on("end", () => received.push(text));
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return {
    path,
    received: () => received,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("a subagent's note is posted to the socket its hook recorded, the parent's, and moved into delivered/", async () => {
  const socket = await ownerSocket();
  try {
    const owner: Owner = { ...PARENT, messagingSocket: socket.path };
    const ran = await host({
      records: (fixture) => [queued(fixture.head(), null, owner)],
      findings: [[finding("The name says nothing.")]],
    });

    const text = `Squiz reviewed PR #${PULL_REQUEST} at ${ran.firstHead.slice(0, 7)}, the work of subagent a402ef8f56c1b2ed1: 1 thread is open. Run \`squiz review ${PULL_REQUEST}\` to read it.`;
    assert.deepEqual(socket.received(), [`${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`]);
    assert.deepEqual(ran.notes[PARENT.sessionId], [], `notes/ holds ${JSON.stringify(ran.notes)}`);
    assert.equal(ran.delivered[PARENT.sessionId], 1);
    assert.match(ran.log, /woke its owner/u);
  } finally {
    await socket.close();
  }
});

test("a note whose owner's socket has gone stays waiting, host.log says why, and the result is unchanged", async () => {
  const gone = join(tmpdir(), `squiz-gone-${process.pid}.sock`);
  const ran = await host({
    records: (fixture) => [queued(fixture.head(), null, { ...MAIN, messagingSocket: gone })],
    findings: [[finding("The name says nothing.")]],
  });

  const [record] = recordsOf(ran.state);
  assert.ok(record?.status === "reviewed" && record.result === "exited" && record.exitStatus === 2, `recorded as ${JSON.stringify(record)}`);
  assert.deepEqual(ran.end, { outcome: "nothing queued" });
  assert.equal(ran.notes[MAIN.sessionId]?.length, 1, `notes/ holds ${JSON.stringify(ran.notes)}`);
  assert.match(ran.log, new RegExp(`did not wake its owner: the post to ${gone} did not arrive`, "u"));
});

test("a note that cannot be written is reported in host.log, and changes neither the result nor what the host does next", async () => {
  const ran = await host({
    records: (fixture) => [queued(fixture.head(), null, MAIN)],
    findings: [[finding("The name says nothing.")]],
    before: ({ episode }) => {
      mkdirSync(episode.directory, { recursive: true });
      // A file where the notes directory goes refuses every note.
      writeFileSync(join(episode.directory, "notes"), "", "utf8");
    },
  });

  const [record] = recordsOf(ran.state);
  assert.ok(record?.status === "reviewed" && record.result === "exited", `recorded as ${JSON.stringify(record)}`);
  assert.equal(record.exitStatus, 2);
  assert.deepEqual(ran.end, { outcome: "nothing queued" });
  assert.match(ran.log, /the note for 60517e1f-e1dc-49b1-8e39-6fcbe686f3fb was not written/u);
});

