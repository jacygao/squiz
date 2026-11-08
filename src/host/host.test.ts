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
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { defaultConfig, type Config } from "../config/config.ts";
import { renderComment } from "../findings/comment.ts";
import type { Finding } from "../findings/finding.ts";
import { type Adapter, type ParsedRun, type RoundCost, type ThreadVerdict } from "../reviewers/adapter.ts";
import { deadlineIn } from "../reviewers/deadline.ts";
import { startChild } from "../sessions/child.ts";
import { lockHolder } from "../sessions/lock-file.ts";
import { identityOf, stillRunning, type ProcessIdentity } from "../sessions/process.ts";
import { readState, writeState, type EpisodeState, type RoundRecord } from "../loop/episode-state.ts";
import type { Episode } from "../loop/episode.ts";
import { archivesIn, githubEpisode } from "../testing/episode.ts";
import { putRecord, type Owner, type StateKey, type StateRecord } from "../loop/state-record.ts";
import type { CleanClose, Rulings } from "../loop/episode-state.ts";
import { updateState } from "../loop/state-update.ts";
import { waitingNotes, type NoteFields } from "../sessions/notes.ts";
import { squizStatus } from "../review/status.ts";
import { standIn } from "../testing/stand-in.ts";
import { githubVenue } from "../venues/github/venue.ts";
import type { Change, ReviewThread, Venue } from "../venues/venue.ts";
import { runHost, type HostEnd, type HostSetup } from "./host.ts";
import { takeEpisodeHostLock } from "./lock.ts";

const BRANCH = "review-me";
const PULL_REQUEST = 142;
const TRACKED = "src/ui/card.ts";
const COST: RoundCost = { dollars: 0.04, tokens: 1200, messages: 3 };

/** A round an earlier firing ran, as the state file holds it. */
const EARLIER_ROUND: RoundRecord = { ...COST, reviewer: "pi", elapsedSeconds: 1, head: "3f9c2e07b1d4a8c6e5f0923b7a1d6c4e8b2f5a90", raised: 0, ruled: { fixed: 0, withdrawn: 0, open: 0 } };
const queueRacer = fileURLToPath(new URL("../testing/queue-racer.ts", import.meta.url));

/** The file under review at the base, ninety-one lines. */
const BASE_CARD = Array.from({ length: 91 }, (_, at) => `// line ${at + 1}\n`).join("");

type Kind = "prlist" | "diff" | "node" | "threads" | "create" | "lookup" | "summary" | "failure";

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
  /** The state of each closed episode archived under the episode's directory, oldest first. */
  readonly archives: readonly (EpisodeState | null)[];
  /** What `squiz status` printed once the host had exited. */
  readonly status: { readonly stdout: string; readonly stderr: string };
};

type Arrangement = {
  /** The records on file before the host starts, oldest first. */
  readonly records?: (fixture: Fixture) => readonly StateRecord[];
  readonly rounds?: readonly RoundRecord[];
  readonly closeReported?: boolean;
  /** The clean close on file, read once the records are made. */
  readonly cleanClose?: () => CleanClose;
  readonly rulings?: Rulings;
  /** What each reviewer start reports, in order. An empty review where there is none. */
  readonly findings?: readonly (readonly Finding[])[];
  /** What each reviewer start rules on the threads it was handed, in order. None where there is none. */
  readonly verdicts?: readonly (readonly ThreadVerdict[])[];
  /** Where given, every reviewer start completes no message, for this reason. */
  readonly incomplete?: string;
  /** Where given, every reviewer start from this index from 0 on prints nothing the adapter can read. */
  readonly unparsedFrom?: number;
  readonly config?: Partial<Config>;
  /** The pull request `gh pr list` answers with, where it is not the host's. */
  readonly listedNumber?: number;
  /** Run as the reviewer starts, with the start's index from 0. */
  readonly onStart?: (index: number, fixture: Fixture) => void;
  /** Run before the host starts. */
  readonly before?: (fixture: Fixture) => void;
  /** Run once the host has returned or thrown, while the temporary directory is still the fixture's. */
  readonly after?: () => void;
  readonly host?: Partial<Pick<HostSetup, "update" | "lock">>;
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
    await writeFile(join(worktree, TRACKED), BASE_CARD, "utf8");
    git(worktree, ["add", "."]);
    git(worktree, ["commit", "--quiet", "--message", "the base"]);
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim();
    // Line 88 is the line a finding threads on.
    await writeFile(join(worktree, TRACKED), BASE_CARD.replace("// line 88\n", "// line 88 CHANGED\n"), "utf8");
    git(worktree, ["commit", "--quiet", "--all", "--message", "the change under review"]);

    const listed = arranged.listedNumber ?? PULL_REQUEST;
    const episode = githubEpisode(worktree, PULL_REQUEST);
    const charterFile = join(root, "charter.md");
    await writeFile(charterFile, "What a good review is.\n", "utf8");
    standIn(binaries, "gh", GH_SCRIPT);
    for (const [kind, answer] of Object.entries(answers(listed))) {
      writeFileSync(join(binaries, `answer-${kind}`), answer, "utf8");
    }
    const answerHead = (head: string): void => writeFileSync(join(binaries, "answer-prlist"), prList(listed, head, base), "utf8");
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
        ...(arranged.cleanClose === undefined ? {} : { cleanClose: arranged.cleanClose() }),
        ...(arranged.rulings === undefined ? {} : { rulings: arranged.rulings }),
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
        if (arranged.unparsedFrom !== undefined && started - 1 >= arranged.unparsedFrom) {
          return { cost: COST, result: { kind: "unparsed", reason: "the output was not JSON" } };
        }
        return {
          cost: COST,
          result: { kind: "reviewed", findings: arranged.findings?.[started - 1] ?? [], verdicts: arranged.verdicts?.[started - 1] ?? [] },
        };
      },
      grants: ["read"],
      ...(arranged.resume === undefined ? {} : { resume: arranged.resume }),
    };

    const end = await runHost({
      worktree,
      key: String(PULL_REQUEST),
      round: { config: { ...defaultConfig, timeout: 5, ...arranged.config }, adapter, charterFile, ...arranged.round, venue: arranged.round?.venue ?? githubVenue },
      ...arranged.host,
    });

    const read = existsSync(worktree) ? readState(episode) : ({ outcome: "absent" } as const);
    const status = existsSync(worktree) ? squizStatus(worktree, githubVenue) : { stdout: "", stderr: "" };
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
      archives: archivesIn(episode).map((archive) => {
        const archived = readState(archive);
        return archived.outcome === "read" ? archived.state : null;
      }),
      status,
    };
  } finally {
    arranged.after?.();
    if (previous === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previous;
    if (previousTemporary === undefined) delete process.env["TMPDIR"];
    else process.env["TMPDIR"] = previousTemporary;
    // A test may leave a snapshot it made unremovable, which would refuse this too.
    spawnSync("chmod", ["-R", "u+rwx", root]);
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
    if (existsSync(file) && statSync(file).isFile()) resumes[round] = readFileSync(file, "utf8");
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

function prList(listed: number, head: string, base: string): string {
  return JSON.stringify([
    { number: listed, id: "PR_pull", baseRefName: "main", headRefName: BRANCH, headRefOid: head, baseRefOid: base, body: "What this changes.", isDraft: false },
  ]);
}

function answers(listed: number): Partial<Record<Kind, string>> {
  return {
    node: included("200 OK", JSON.stringify({ number: listed, node_id: "PR_pull" })),
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
  "  *'api --include repos/'*'/pulls/'*) kind=node ;;",
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
  const ran = await host({ records: atHead, rounds: [EARLIER_ROUND] });

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

test("a resume command that cannot be written is reported in host.log, and the round's result is unchanged", async () => {
  const ran = await host({
    records: atHead,
    resume: (_sessionDirectory, spelled) => ["pi", "--session-dir", spelled, "--session", "0193f2c4"],
    before: ({ episode }) => {
      // A directory where resume.txt goes refuses the write.
      mkdirSync(join(episode.directory, "rounds", "1", "resume.txt"), { recursive: true });
    },
  });

  const [record] = recordsOf(ran.state);
  assert.ok(record?.status === "reviewed" && record.result === "exited", `recorded as ${JSON.stringify(record)}`);
  assert.equal(record.exitStatus, 0);
  assert.deepEqual(ran.resumes, {});
  assert.match(ran.log, /^.*round 1: its resume command could not be written: .*EISDIR.*$/mu);
});

test("a posting time the state file refuses is reported in host.log, and the round's result is unchanged", async () => {
  const ran = await host({
    records: atHead,
    before: (fixture) => {
      // The summary is the round's last post, so the episode's directory refuses
      // the state's lock from then until the host records the result.
      writeFileSync(join(fixture.binaries, "on-summary.sh"), `chmod 555 '${fixture.episode.directory}'\n`, "utf8");
    },
    host: {
      update: (episode, change, options) => {
        chmodSync(episode.directory, 0o755);
        return updateState(episode, change, options);
      },
    },
  });

  const [record] = recordsOf(ran.state);
  assert.ok(record?.status === "reviewed" && record.result === "exited", `recorded as ${JSON.stringify(record)}`);
  assert.equal(record.exitStatus, 0);
  assert.ok(ran.kinds.includes("summary"), `the round posted no summary: ${ran.kinds.join(", ")}`);
  assert.equal(ran.state?.rounds[0]?.postingSeconds, undefined, "the posting time was written after all");
  assert.match(ran.log, /^.*round 1: its posting time could not be written: .*state\.json could not be written: .*$/mu);
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

test("#416: a reply-state queued behind a clean round and superseded by it, once its reply is deleted, closes the episode on the clean round", async () => {
  let head = "";
  const ran = await host({
    records: (fixture) => {
      head = fixture.head();
      return [queued(head, null, MAIN)];
    },
    // The fake lists no replies, so by the time the host takes the reply-state
    // the pull request is back at the state the first round reviewed.
    onStart: (index, fixture) => {
      if (index === 0) queueNow(fixture.episode, queued(fixture.head(), "PRRC_deleted", MAIN));
    },
  });

  assert.equal(ran.started, 1, `no second reviewer should run; the log says:\n${ran.log}`);
  const [clean, superseded] = recordsOf(ran.state);
  assert.ok(clean?.status === "reviewed" && clean.result === "exited", `the clean round is left as ${JSON.stringify(clean)}`);
  assert.equal(clean.exitStatus, 0);
  assert.deepEqual(clean.openThreads, []);
  assert.deepEqual(superseded, {
    head,
    activity: "PRRC_deleted",
    owner: MAIN,
    status: "not reviewed",
    reason: `superseded by ${head.slice(0, 7)} with different replies`,
    supersededBy: { head, activity: null },
  });
  assert.equal(ran.state?.closeReported, true, "the episode was left open with nothing queued to close it");
  assert.deepEqual(ran.state?.cleanClose, { head, activity: null, records: 2 }, "#832: a close on the clean round must record it as a clean close, or the next head is never reviewed");
  assert.equal(ran.kinds.filter((kind) => kind === "summary").length, 1, `gh was asked for ${ran.kinds.join(", ")}`);
});

test("#416: a clean round that a later review followed closes nothing when a state is superseded by it", async () => {
  let first = "";
  let atFirst = "";
  let third = "";
  const ran = await host({
    records: (fixture) => {
      first = fixture.head();
      return [queued(first)];
    },
    // The second state's review opens a thread, and the third state is superseded
    // by the first, as a force-push back to it would leave the pull request.
    findings: [[], [finding("The name says nothing.")]],
    onStart: (index, fixture) => {
      if (index === 0) {
        atFirst = readFileSync(join(fixture.binaries, "answer-prlist"), "utf8");
        queueNow(fixture.episode, queued(fixture.push()));
      }
      if (index === 1) {
        third = fixture.push();
        queueNow(fixture.episode, queued(third));
        writeFileSync(join(fixture.binaries, "answer-prlist"), atFirst, "utf8");
      }
    },
  });

  assert.equal(ran.started, 2, `the log says:\n${ran.log}`);
  const [clean, reviewed, superseded] = recordsOf(ran.state);
  assert.ok(clean?.status === "reviewed" && clean.result === "clean, episode open", `the first state is ${JSON.stringify(clean)}`);
  assert.ok(reviewed?.status === "reviewed" && reviewed.result === "exited" && reviewed.exitStatus === 2, `the second state is ${JSON.stringify(reviewed)}`);
  assert.equal(superseded?.status, "not reviewed");
  assert.notEqual(ran.state?.closeReported, true, "the episode closed over the thread the later review left open");
  assert.equal(ran.kinds.filter((kind) => kind === "summary").length, 0, `gh was asked for ${ran.kinds.join(", ")}`);
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
          // Once only: the push becomes a new episode, whose own summary would push again.
          `[ -f '${fixture.binaries}/pushed' ] && exit 0`,
          `touch '${fixture.binaries}/pushed'`,
          `cd '${worktree}' || exit 1`,
          "git commit --quiet --allow-empty --message 'a push during the summary'",
          'sha=$(git rev-parse HEAD)',
          `printf '[{"number":${PULL_REQUEST},"id":"PR_pull","baseRefName":"main","headRefName":"${BRANCH}","headRefOid":"%s","baseRefOid":"%s","body":"x","isDraft":false}]' "$sha" "$(git rev-list --max-parents=0 HEAD)" > '${fixture.binaries}/answer-prlist'`,
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

/**
 * A host lock whose first release runs `exiting` just before the lock goes, which
 * is where a host that found nothing queued is committed to exit, and `released`
 * just after.
 */
function exitingAt(exiting: () => void, released: () => void = () => {}): NonNullable<HostSetup["lock"]> {
  let ran = false;
  return (episode, options) => {
    const taking = takeEpisodeHostLock(episode, options);
    if (taking.outcome !== "taken" || ran) return taking;
    const { lock } = taking;
    const release = (): ReturnType<typeof lock.release> => {
      if (ran) return lock.release();
      ran = true;
      exiting();
      const outcome = lock.release();
      released();
      return outcome;
    };
    return { outcome: "taken", lock: { ...lock, release } };
  };
}

/** Whether a trigger reading the host lock now would find a live host, and so start none. */
function hostSeenRunning(episode: Episode): boolean {
  const holder = lockHolder(episode.directory, "host.lock");
  return holder.outcome === "named" && stillRunning(holder.holder, 5_000).outcome === "running";
}

test("#412: a state queued as the host exits, by a trigger that saw the host running and started none, is reviewed", async () => {
  let fixture: Fixture | undefined;
  let pushed = "";
  let seenRunning: boolean | undefined;
  const ran = await host({
    records: atHead,
    // The first round leaves a thread open, so the episode stays open for the state queued after it.
    findings: [[finding("The name says nothing.")], []],
    before: (arranged) => {
      fixture = arranged;
    },
    host: {
      lock: exitingAt(() => {
        const at = fixture ?? assert.fail("the fixture was not handed over");
        pushed = at.push();
        queueNow(at.episode, queued(pushed));
        seenRunning = hostSeenRunning(at.episode);
      }),
    },
  });

  assert.equal(seenRunning, true, "the trigger must find the host running, or it starts a host of its own and the window is not the one under test");
  const left = recordsOf(ran.state).find((record) => record.head === pushed);
  assert.equal(left?.status, "reviewed", `a state queued as the host exited was left ${left?.status} with no host to take it; the log says:\n${ran.log}`);
  assert.equal(ran.started, 2);
  assert.deepEqual(ran.end, { outcome: "nothing queued" });
});

test("#412: a host that finds a state queued as it exits, and another host holding the lock by then, leaves the state to that host", async () => {
  const other = spawn("/bin/sh", ["-c", "sleep 30"], { stdio: "ignore" });
  try {
    const pid = other.pid ?? assert.fail("the other host did not start");
    const read = identityOf(pid, 5_000);
    assert.ok(read.outcome === "read");
    let fixture: Fixture | undefined;
    let pushed = "";
    const ran = await host({
      records: atHead,
      findings: [[finding("The name says nothing.")], []],
      before: (arranged) => {
        fixture = arranged;
      },
      host: {
        lock: exitingAt(
          () => {
            const at = fixture ?? assert.fail("the fixture was not handed over");
            pushed = at.push();
            queueNow(at.episode, queued(pushed));
          },
          // The host a later trigger started, taking the lock the moment it was free.
          () => {
            const at = fixture ?? assert.fail("the fixture was not handed over");
            writeFileSync(join(at.episode.directory, "host.lock"), `${JSON.stringify(read.identity)}\n`, "utf8");
          },
        ),
      },
    });

    assert.deepEqual(ran.end, { outcome: "lock held", holder: read.identity }, `the log says:\n${ran.log}`);
    assert.equal(ran.started, 1, "the state was reviewed beside the host that holds the lock");
    assert.equal(recordsOf(ran.state).find((record) => record.head === pushed)?.status, "queued");
  } finally {
    other.kill("SIGKILL");
  }
});

test("#412: a host whose state file stops reading as it exits says so, rather than that nothing is left queued", async () => {
  let fixture: Fixture | undefined;
  const ran = await host({
    records: atHead,
    findings: [[finding("The name says nothing.")]],
    before: (arranged) => {
      fixture = arranged;
    },
    host: {
      lock: exitingAt(
        () => {},
        () => writeFileSync((fixture ?? assert.fail("the fixture was not handed over")).episode.stateFile, "{ not json", "utf8"),
      ),
    },
  });

  assert.equal(ran.end.outcome, "state unreadable", `the log says:\n${ran.log}`);
  assert.match(ran.log.trimEnd().split("\n").at(-1) ?? "", / exiting: .* is not valid JSON: /u);
});

/** The record of a round that closed the episode with nothing open, on `head`. */
function closedCleanOn(head: string): StateRecord {
  return {
    head,
    activity: null,
    status: "reviewed",
    result: "exited",
    exitStatus: 0,
    openThreads: [],
    round: { number: 1, startedAt: 1_790_999_000, endedAt: 1_790_999_400, reviewer: { backend: "detached" } },
    newFindings: 0,
  };
}

test("#832: a head queued after a clean close starts a new episode, archiving the closed one, and is reviewed as its round 1", async () => {
  let closedHead = "";
  let newHead = "";
  const ran = await host({
    records: (fixture) => {
      closedHead = fixture.head();
      newHead = fixture.push();
      return [closedCleanOn(closedHead), queued(newHead, null, MAIN)];
    },
    rounds: [EARLIER_ROUND],
    closeReported: true,
    cleanClose: () => ({ head: closedHead, activity: null, records: 1 }),
    rulings: { PRRT_old: "fixed" },
  });

  assert.equal(ran.started, 1, `the new head was not reviewed; the log says:\n${ran.log}`);
  assert.deepEqual(ran.reviewedCommits, [newHead]);
  assert.equal(ran.state?.rounds.length, 1, "the new episode must start with a fresh round cap");
  const [record, ...rest] = recordsOf(ran.state);
  assert.deepEqual(rest, [], "the closed episode's records were left in the new episode's state file");
  assert.ok(record?.status === "reviewed" && record.result === "exited", `the new head is left as ${JSON.stringify(record)}`);
  assert.equal(record.head, newHead);
  assert.equal(record.round.number, 1);
  assert.deepEqual(ran.state?.cleanClose, { head: newHead, activity: null, records: 1 }, "the new episode's own clean close");
  assert.deepEqual(ran.state?.rulings, { PRRT_old: "fixed" }, "the rulings on the threads the pull request still holds must carry over");
  assert.equal(ran.kinds.filter((kind) => kind === "summary").length, 1, "the new episode posts its own summary when it closes");

  assert.equal(ran.archives.length, 1);
  assert.deepEqual(ran.archives[0]?.records, [closedCleanOn(closedHead)]);
  assert.deepEqual(ran.archives[0]?.rounds, [EARLIER_ROUND]);
  assert.match(ran.status.stdout, new RegExp(`#${PULL_REQUEST} +${newHead.slice(0, 7)} .* reviewed `, "u"));
  assert.match(ran.status.stdout, new RegExp(`#${PULL_REQUEST} +${closedHead.slice(0, 7)} .* reviewed `, "u"), "squiz status must still list the closed episode");
});

test("#832: the archive keeps the closed episode's records in their order, and the new episode takes every state queued after the close in theirs", async () => {
  let first = "";
  let closedHead = "";
  let newHead = "";
  const blockedHead = "1b86987bb0c4d5e6f708192a3b4c5d6e7f8091a2";
  const ran = await host({
    records: (fixture) => {
      first = fixture.head();
      closedHead = fixture.push();
      newHead = fixture.push();
      const earlier: StateRecord = { ...closedCleanOn(first), exitStatus: 2, openThreads: ["PRRT_old"] } as StateRecord;
      const closing: StateRecord = { ...closedCleanOn(closedHead), round: { number: 2, startedAt: 1_790_999_500, endedAt: 1_790_999_600, reviewer: { backend: "detached" } } } as StateRecord;
      const blocked: StateRecord = { head: blockedHead, activity: null, status: "failed", reason: "no review ran: blocked", ownerNoted: false };
      return [earlier, closing, blocked, queued(newHead)];
    },
    rounds: [EARLIER_ROUND, EARLIER_ROUND],
    closeReported: true,
    cleanClose: () => ({ head: closedHead, activity: null, records: 2 }),
  });

  assert.deepEqual(ran.reviewedCommits, [newHead], `the log says:\n${ran.log}`);
  assert.deepEqual(ran.archives[0]?.records?.map((record) => record.head), [first, closedHead], "the archive must hold the closed episode's records, oldest first");
  assert.deepEqual(recordsOf(ran.state).map((record) => [record.head, record.status]), [[blockedHead, "failed"], [newHead, "reviewed"]]);
});

test("#832: a new head after a clean close whose round is still recorded under review is recorded failed, naming that round, so squiz review can retry it", async () => {
  let closedHead = "";
  let newHead = "";
  // A host that has gone: a pid with a start time no process has.
  const gone = { pid: process.pid, startedAt: 1 };
  const ran = await host({
    records: (fixture) => {
      closedHead = fixture.head();
      newHead = fixture.push();
      return [{ head: closedHead, activity: null, status: "reviewing", host: gone, round: { number: 1 } }, queued(newHead)];
    },
    rounds: [EARLIER_ROUND],
    closeReported: true,
    cleanClose: () => ({ head: closedHead, activity: null, records: 1 }),
  });

  assert.equal(ran.started, 0, "a round ran over the closed episode's round, whose snapshot and reviewer may still stand");
  assert.deepEqual(ran.archives, []);
  const left = recordsOf(ran.state)[1];
  assert.ok(left?.status === "failed", `the new head was left ${JSON.stringify(left)}, which no retry takes`);
  assert.equal(left.reason, `no review ran: round 1 of the closed episode is still recorded under review by round host ${process.pid}`);
  assert.match(
    ran.log,
    new RegExp(` ${newHead.slice(0, 7)}: recorded failed: no review ran: round 1 of the closed episode is still recorded under review by round host ${process.pid}\\n`, "u"),
    "host.log must say the state failed and why",
  );
  assert.doesNotMatch(ran.log, /recorded not reviewed/u, "host.log called a failed state not reviewed");
});

test("the host runs no round for an episode whose close is recorded, and records its queued states not reviewed", async () => {
  const ran = await host({ records: atHead, rounds: [EARLIER_ROUND], closeReported: true });

  assert.equal(ran.started, 0);
  assert.deepEqual(ran.kinds, [], "nothing should have been asked of GitHub");
  const [record] = recordsOf(ran.state);
  assert.equal(record?.status, "not reviewed", `recorded as ${JSON.stringify(record)}`);
});

/** The threads listing with one open thread the reviewer opened. */
const ONE_OPEN_THREAD = threadsAnswer("PRRT_open");

/** A threads listing holding one open thread, `id`, which carries the finding `finding("The name says nothing.")`. */
function threadsAnswer(id: string): string {
  return included(
    "200 OK",
    JSON.stringify({
      data: {
        node: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id,
                isResolved: false,
                isOutdated: false,
                path: TRACKED,
                line: 88,
                originalLine: 88,
                subjectType: "LINE",
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "PRRC_open",
                      databaseId: 51,
                      author: { login: "squiz" },
                      body: renderComment(finding("The name says nothing.")),
                      createdAt: "2026-10-05T07:13:05Z",
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    }),
  );
}

/**
 * Have the threads listing hold the thread the round opens, from the moment it
 * posts the comment, as GitHub's would.
 */
function listOpenedThread(fixture: Fixture): void {
  writeFileSync(join(fixture.binaries, "threads-after-create"), threadsAnswer("PRRT_new"), "utf8");
  writeFileSync(join(fixture.binaries, "on-create.sh"), `cp '${join(fixture.binaries, "threads-after-create")}' '${join(fixture.binaries, "answer-threads")}'\n`, "utf8");
}

/** The opened thread as the note prints it. */
const OPENED_THREAD = [
  `PRRT_new ${TRACKED}:88 high — The name says nothing.`,
  "  - The caller reads the old value.",
  "",
  "  **Suggested fix:** Rename it.",
].join("\n");

const WORK_THE_THREADS = [
  "Fix what applies, and reply on each thread with `squiz reply <id> <text>` to say",
  "what you changed or why you disagree. Commit and push what you changed, then run",
  `\`squiz review ${PULL_REQUEST}\` again.`,
].join("\n");

test("a host that finds the cap spent posts the summary, and records the close on the state it took and the rest not reviewed", async () => {
  let head = "";
  const ran = await host({
    rounds: [EARLIER_ROUND],
    config: { rounds: 1 },
    records: (fixture) => {
      head = fixture.head();
      return [queued(head, null, MAIN), queued(head, "PRRC_reply", PARENT)];
    },
    before: (fixture) => writeFileSync(join(fixture.binaries, "answer-threads"), ONE_OPEN_THREAD, "utf8"),
  });

  assert.equal(ran.started, 0, "a cap already spent starts no reviewer");
  assert.deepEqual(ran.kinds, ["prlist", "threads", "summary"]);
  const reason = "the episode closed at the round cap before a round took this state";
  const [taken, behind] = recordsOf(ran.state);
  assert.deepEqual(taken, {
    head,
    activity: null,
    owner: MAIN,
    status: "not reviewed",
    reason,
    closed: { exitStatus: 3, openThreads: ["PRRT_open"], closedAt: "round cap" },
  });
  assert.deepEqual(behind, { head, activity: "PRRC_reply", owner: PARENT, status: "not reviewed", reason });
  assert.equal(
    onlyNote(ran, PARENT).text,
    `Squiz did not review PR #${PULL_REQUEST} at ${head.slice(0, 7)} with different replies, the work of subagent ${PARENT.subagent}: ${reason}.`,
  );
});

test("a host that finds the bound spent before any round ran, with no thread of the reviewer's, records the close's missing summary", async () => {
  const ran = await host({ records: atHead, config: { tokens: 1000 }, before: (fixture) => spendOutsideRounds(fixture.episode, 1000) });

  assert.deepEqual(ran.kinds, ["prlist", "threads"]);
  const [taken] = recordsOf(ran.state);
  assert.ok(taken?.status === "not reviewed", `recorded as ${JSON.stringify(taken)}`);
  assert.deepEqual(taken.closed, {
    exitStatus: 0,
    openThreads: [],
    closedAt: "token bound",
    problems: [`the review of PR #${PULL_REQUEST} closed without its summary: the episode closed before any round ran`],
  });
});

test("#414: a last round whose summary GitHub refuses keeps the reason on its record, in host.log and in squiz status", async () => {
  const ran = await host({ records: atHead, before: refuseSummary });

  const line = `the review of PR #${PULL_REQUEST} closed without its summary: gh exited 1: no answer fixtured for summary`;
  assert.ok(ran.kinds.includes("summary"), `gh was asked for ${ran.kinds.join(", ")}`);
  const [record] = recordsOf(ran.state);
  assert.ok(record?.status === "reviewed" && record.result === "exited", `recorded as ${JSON.stringify(record)}`);
  assert.equal(record.exitStatus, 0, "a close without its summary is a close still");
  assert.deepEqual(record.problems, [line]);
  assert.match(ran.log, new RegExp(`round 1: ${escaped(line)}\n`, "u"));
  assert.match(ran.status.stdout, new RegExp(`\n  ${escaped(line)}\n`, "u"));
});

test("#416: a clean round that closes the episode once the state behind it is superseded keeps the summary's refusal on its record", async () => {
  const ran = await host({
    records: atHead,
    before: refuseSummary,
    onStart: (index, fixture) => {
      if (index === 0) queueNow(fixture.episode, queued(fixture.head(), "PRRC_deleted"));
    },
  });

  const line = `the review of PR #${PULL_REQUEST} closed without its summary: gh exited 1: no answer fixtured for summary`;
  assert.ok(ran.kinds.includes("summary"), `gh was asked for ${ran.kinds.join(", ")}`);
  const [record] = recordsOf(ran.state);
  assert.ok(record?.status === "reviewed" && record.result === "exited", `recorded as ${JSON.stringify(record)}`);
  assert.equal(record.exitStatus, 0, "a close without its summary is a close still");
  assert.deepEqual(record.problems, [line]);
  assert.match(ran.log, new RegExp(`round 2: ${escaped(line)}\n`, "u"));
});

test("#416: a clean round closes nothing when a state is superseded by it while a thread of the reviewer's is open", async () => {
  const ran = await host({
    records: atHead,
    // The thread is listed only after the clean round's own listing, as one a
    // failed round salvaged would be.
    onStart: (index, fixture) => {
      if (index !== 0) return;
      queueNow(fixture.episode, queued(fixture.head(), "PRRC_deleted"));
      writeFileSync(join(fixture.binaries, "answer-threads"), ONE_OPEN_THREAD, "utf8");
    },
  });

  const [clean, superseded] = recordsOf(ran.state);
  assert.ok(clean?.status === "reviewed" && clean.result === "clean, episode open", `the clean round is ${JSON.stringify(clean)}`);
  assert.equal(superseded?.status, "not reviewed");
  assert.notEqual(ran.state?.closeReported, true, "the episode closed with nothing open over a thread that is open");
  assert.equal(ran.kinds.filter((kind) => kind === "summary").length, 0, `gh was asked for ${ran.kinds.join(", ")}`);
});

test("#416: a clean round closes nothing when a state is superseded by it after a later round failed", async () => {
  let atFirst = "";
  const ran = await host({
    records: atHead,
    // The second state's round fails, and the third state is superseded by the first.
    unparsedFrom: 1,
    onStart: (index, fixture) => {
      if (index === 0) {
        atFirst = readFileSync(join(fixture.binaries, "answer-prlist"), "utf8");
        queueNow(fixture.episode, queued(fixture.push()));
      }
      if (index === 1) {
        queueNow(fixture.episode, queued(fixture.push()));
        writeFileSync(join(fixture.binaries, "answer-prlist"), atFirst, "utf8");
      }
    },
  });

  const [clean, failed, superseded] = recordsOf(ran.state);
  assert.ok(clean?.status === "reviewed" && clean.result === "clean, episode open", `the clean round is ${JSON.stringify(clean)}`);
  assert.equal(failed?.status, "failed", `the second state is ${JSON.stringify(failed)}; the log says:\n${ran.log}`);
  assert.equal(superseded?.status, "not reviewed");
  assert.notEqual(ran.state?.closeReported, true, "the episode closed on a clean round a later round followed");
});

test("#414: a close before any review whose summary GitHub refuses keeps the reason on its record and in host.log", async () => {
  const ran = await host({
    rounds: [EARLIER_ROUND],
    config: { rounds: 1 },
    records: atHead,
    before: (fixture) => {
      writeFileSync(join(fixture.binaries, "answer-threads"), ONE_OPEN_THREAD, "utf8");
      refuseSummary(fixture);
    },
  });

  const line = `the review of PR #${PULL_REQUEST} closed without its summary: gh exited 1: no answer fixtured for summary`;
  assert.deepEqual(ran.kinds, ["prlist", "threads", "summary"]);
  const [taken] = recordsOf(ran.state);
  assert.ok(taken?.status === "not reviewed", `recorded as ${JSON.stringify(taken)}`);
  assert.deepEqual(taken.closed?.problems, [line]);
  assert.match(ran.log, new RegExp(`round 2: ${escaped(line)}\n`, "u"));
});

/** Have `gh` refuse the summary comment, as it refuses any call it has no answer for. */
function refuseSummary(fixture: Fixture): void {
  rmSync(join(fixture.binaries, "answer-summary"));
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Record `tokens` spent by attempts that were no round, as a setup problem records them. */
function spendOutsideRounds(episode: Episode, tokens: number): void {
  const written = updateState(
    episode,
    (state) => ({ ...state, spentOutsideRounds: { dollars: 0, tokens, messages: 1 } }),
    { until: deadlineIn(5_000) },
  );
  assert.equal(written.outcome, "written", `the fixture could not record the spend: ${JSON.stringify(written)}`);
}

test("a reviewed round's record counts the threads its findings opened", async () => {
  const ran = await host({ records: atHead, findings: [[finding("The name says nothing.")]] });

  const [record] = recordsOf(ran.state);
  assert.ok(record?.status === "reviewed", `recorded as ${JSON.stringify(record)}`);
  assert.equal(record.newFindings, 1);
});

/** A finding about the change as a whole, which no thread can hold. */
function aboutTheChange(headline: string): Finding {
  return { scope: "change", severity: "medium", headline, reasoning: ["Two schedulers drift apart."], suggestedFix: "Use the one there is." };
}

test("#606: a round that leaves threads open records each finding no thread holds, as the summary would name it", async () => {
  const ran = await host({
    records: atHead,
    findings: [[finding("The name says nothing."), aboutTheChange("The retry queue duplicates the scheduler")]],
  });

  const [record] = recordsOf(ran.state);
  assert.ok(record?.status === "reviewed" && record.result === "exited", `recorded as ${JSON.stringify(record)}`);
  assert.equal(record.exitStatus, 2);
  assert.deepEqual(record.unthreaded, ["About the change as a whole: The retry queue duplicates the scheduler"]);
});

test("#606: a round that closes the episode records no finding no thread holds, because its summary names them", async () => {
  const ran = await host({
    records: atHead,
    config: { rounds: 1 },
    findings: [[finding("The name says nothing."), aboutTheChange("The retry queue duplicates the scheduler")]],
  });

  const [record] = recordsOf(ran.state);
  assert.ok(record?.status === "reviewed" && record.result === "exited", `recorded as ${JSON.stringify(record)}`);
  assert.equal(record.exitStatus, 3);
  assert.equal(record.unthreaded, undefined);
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
  let pushed = "";
  const ran = await host({
    records: atHead,
    onStart: (_index, fixture) => {
      pushed = fixture.push();
      rmSync(fixture.episode.worktree, { recursive: true, force: true });
      // Queued after the removal, so the state file comes back without the
      // repository, and a host that took it would show it taken.
      queueNow(fixture.episode, queued(pushed));
    },
  });

  assert.equal(ran.started, 1, `the host started a reviewer after its worktree went; host.log:\n${ran.log}`);
  const left = recordsOf(ran.state).find((record) => record.head === pushed);
  assert.equal(left?.status, "queued", `the state queued after the worktree went is ${JSON.stringify(left)}; host.log:\n${ran.log}`);
  assert.deepEqual(ran.end, { outcome: "worktree gone" }, `host.log:\n${ran.log}`);
});

test("a host whose state file cannot be read exits naming it in host.log, and asks nothing of GitHub", async () => {
  let stateFile = "";
  const ran = await host({
    before: ({ episode }) => {
      stateFile = episode.stateFile;
      mkdirSync(episode.directory, { recursive: true });
      writeFileSync(episode.stateFile, "{ not json", "utf8");
    },
  });

  assert.equal(ran.end.outcome, "state unreadable");
  assert.equal(ran.started, 0);
  assert.deepEqual(ran.kinds, [], "a host that could not read its state called gh");
  const last = ran.log.trimEnd().split("\n").at(-1) ?? "";
  assert.ok(
    last.includes(` exiting: ${stateFile} is not valid JSON: `),
    `host.log's last line does not name the file and the parser's error:\n${ran.log}`,
  );
});

test("a state file that stops reading once the host took its state ends the round with no reviewer, and posts no comment", async () => {
  let stateFile = "";
  const ran = await host({
    records: atHead,
    before: ({ episode, binaries }) => {
      stateFile = episode.stateFile;
      // The round's gate looks the pull request up before it reads the state.
      writeFileSync(join(binaries, "on-prlist.sh"), `printf '{ not json' > '${episode.stateFile}'\n`, "utf8");
    },
  });

  assert.equal(ran.started, 0);
  assert.ok(ran.kinds.includes("prlist"), `the round never reached its gate: ${ran.kinds.join(", ")}`);
  assert.deepEqual(
    ran.kinds.filter((kind) => kind === "failure" || kind === "summary"),
    [],
    "a comment was posted on the pull request",
  );
  assert.ok(ran.log.includes(`${stateFile} is not valid JSON: `), `host.log does not name the file:\n${ran.log}`);
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

test("a round that leaves threads open writes its owner a note naming the pull request, the head and the subagent, which carries the threads as the pull request lists them", async () => {
  const ran = await host({
    records: (fixture) => [queued(fixture.head(), null, PARENT)],
    findings: [[finding("The name says nothing.")]],
    before: listOpenedThread,
  });

  const short = ran.firstHead.slice(0, 7);
  assert.deepEqual(onlyNote(ran, PARENT), {
    to: PARENT.sessionId,
    pr: String(PULL_REQUEST),
    head: ran.firstHead,
    subagent: "a402ef8f56c1b2ed1",
    text: [
      `Squiz reviewed PR #${PULL_REQUEST} at ${short}, the work of subagent a402ef8f56c1b2ed1: 1 thread is open:`,
      OPENED_THREAD,
      WORK_THE_THREADS,
    ].join("\n\n"),
  });
});

test("a round whose threads cannot be listed for the note writes one that points to squiz review, and host.log says why", async () => {
  const ran = await host({
    records: (fixture) => [queued(fixture.head(), null, MAIN)],
    findings: [[finding("The name says nothing.")]],
    // Removed once the round has listed its threads, so only the note's listing fails.
    onStart: (_, fixture) => rmSync(join(fixture.binaries, "answer-threads")),
  });

  const short = ran.firstHead.slice(0, 7);
  assert.equal(
    onlyNote(ran, MAIN)["text"],
    `Squiz reviewed PR #${PULL_REQUEST} at ${short}: 1 thread is open. Run \`squiz review ${PULL_REQUEST}\` to read it.`,
  );
  assert.match(ran.log, /the threads could not be listed for its note: .*no answer fixtured for threads/u);
});

test("a round whose listing holds none of the threads it left open writes a note that points to squiz review, and host.log says why", async () => {
  // The default listing is empty, so it never holds the thread the round opens.
  const ran = await host({
    records: (fixture) => [queued(fixture.head(), null, MAIN)],
    findings: [[finding("The name says nothing.")]],
  });

  const short = ran.firstHead.slice(0, 7);
  assert.equal(
    onlyNote(ran, MAIN)["text"],
    `Squiz reviewed PR #${PULL_REQUEST} at ${short}: 1 thread is open. Run \`squiz review ${PULL_REQUEST}\` to read it.`,
  );
  assert.match(ran.log, new RegExp(`${short}.*: none of the threads the round left open is open on PR #${PULL_REQUEST}, so its note points to squiz review`, "u"));
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

test("a round that closes the episode with threads open writes its owner a note carrying them", async () => {
  const ran = await host({
    records: (fixture) => [queued(fixture.head(), null, MAIN)],
    config: { rounds: 1 },
    findings: [[finding("The name says nothing.")]],
    before: listOpenedThread,
  });

  const short = ran.firstHead.slice(0, 7);
  assert.equal(
    onlyNote(ran, MAIN)["text"],
    [`Squiz reviewed PR #${PULL_REQUEST} at ${short}: the episode has closed with 1 thread open:`, OPENED_THREAD].join("\n\n"),
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

test("#416: the owner of a clean round that closes the episode once the state queued behind it is superseded is told the episode closed", async () => {
  let head = "";
  const ran = await host({
    records: (fixture) => {
      head = fixture.head();
      return [queued(head, null, MAIN)];
    },
    onStart: (index, fixture) => {
      if (index === 0) queueNow(fixture.episode, queued(fixture.head(), "PRRC_deleted", PARENT));
    },
  });

  assert.equal(
    onlyNote(ran, MAIN).text,
    `Squiz reviewed PR #${PULL_REQUEST} at ${head.slice(0, 7)}: nothing is open, and the episode has closed. Run \`squiz review ${PULL_REQUEST}\` to read the close.`,
  );
  assert.equal(
    onlyNote(ran, PARENT).text,
    `Squiz did not review PR #${PULL_REQUEST} at ${head.slice(0, 7)}, the work of subagent ${PARENT.subagent}: superseded by ${head.slice(0, 7)} with different replies.`,
  );
});

test("a state queued on a closed episode gets a note naming it as the state with different replies where its commit repeats", async () => {
  const ran = await host({
    records: (fixture) => [queued(fixture.head(), null, PARENT), queued(fixture.head(), "PRRC_reply", MAIN)],
    rounds: [EARLIER_ROUND],
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
      before: listOpenedThread,
    });

    const text = [
      `Squiz reviewed PR #${PULL_REQUEST} at ${ran.firstHead.slice(0, 7)}, the work of subagent a402ef8f56c1b2ed1: 1 thread is open:`,
      OPENED_THREAD,
      WORK_THE_THREADS,
    ].join("\n\n");
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

test("#406: a snapshot the round cannot remove is named in host.log, and the round's result stands", { skip: process.getuid?.() === 0 ? "root deletes files in a read-only directory" : false }, async () => {
  const ran = await host({
    records: atHead,
    // A file in a directory nobody may write refuses the removal's unlink.
    reviewer: "mkdir stuck && : > stuck/left && chmod 555 stuck",
  });

  const [record] = recordsOf(ran.state);
  assert.ok(record?.status === "reviewed" && record.result === "exited", `recorded as ${JSON.stringify(record)}`);
  assert.deepEqual(ran.end, { outcome: "nothing queued" });
  assert.match(
    ran.log,
    /round 1: the snapshot at \/\S+\/rounds\/1\/tree could not be removed: .+; it stays on disk until it is deleted\n/u,
  );
});

/** What stands in the snapshots directory: one entry per episode a snapshot is left for. */
function snapshotsStanding(): readonly string[] {
  const directory = join(tmpdir(), `squiz-${process.getuid?.() ?? 0}`);
  return existsSync(directory) ? readdirSync(directory) : [];
}

test("#640: a round's result is recorded while its snapshot still stands, and the snapshot is gone once the host exits", async () => {
  const standingAtRecord: boolean[] = [];
  let standingAfter: readonly string[] | undefined;
  const ran = await host({
    records: atHead,
    host: {
      update: (episode, change, options) => {
        const written = updateState(episode, change, options);
        const read = readState(episode);
        if (read.outcome === "read" && recordsOf(read.state).some((record) => record.status === "reviewed")) {
          standingAtRecord.push(snapshotsStanding().length > 0);
        }
        return written;
      },
    },
    after: () => {
      standingAfter = snapshotsStanding();
    },
  });

  const [record] = recordsOf(ran.state);
  assert.ok(record?.status === "reviewed", `recorded as ${JSON.stringify(record)}`);
  assert.deepEqual(standingAtRecord, [true], "the snapshot was removed before the round's result was recorded");
  assert.deepEqual(standingAfter, [], "the host exited and left the snapshot on disk");
});

test("#640: a host that throws recording a round's result still removes the round's snapshot", async () => {
  let standingAfter: readonly string[] | undefined;
  await assert.rejects(
    host({
      records: atHead,
      host: {
        // Throws at the write that records the round reviewed, and makes every other.
        update: (episode, change, options) => {
          const read = readState(episode);
          const next = read.outcome === "read" ? change(read.state) : null;
          if (recordsOf(next).some((record) => record.status === "reviewed")) throw new Error("the state file threw");
          return updateState(episode, change, options);
        },
      },
      after: () => {
        standingAfter = snapshotsStanding();
      },
    }),
    /the state file threw/u,
  );

  assert.deepEqual(standingAfter, [], "the host threw and left the snapshot on disk");
});

/** One call the round made of a fake venue: the member, and what it was handed. */
type VenueCall = { readonly member: keyof Venue; readonly args: readonly unknown[] };

/** A thread the reviewer opened in an earlier round, as a venue lists it. */
const EARLIER_THREAD: ReviewThread = {
  id: "thread-earlier",
  isResolved: false,
  isOutdated: false,
  path: TRACKED,
  anchor: { at: "line", line: 88 },
  comments: [
    { id: "comment-earlier", databaseId: null, author: "squiz", body: renderComment(finding("The old name is still read")), createdAt: "2026-11-01T00:00:00Z" },
  ],
};

/**
 * A venue that records every call and answers each as a healthy venue would,
 * except where `failing` gives a member's answer. The change it finds is the
 * worktree's head, against its parent, keyed as the host's pull request.
 */
function fakeVenue(failing: Partial<Venue> = {}): { readonly venue: Venue; readonly calls: VenueCall[] } {
  const calls: VenueCall[] = [];
  let opened = 0;
  const posted = (): { outcome: "posted"; threadId: string; commentId: string; url: string } => {
    opened += 1;
    return { outcome: "posted", threadId: `thread-${opened}`, commentId: `comment-${opened}`, url: `fake://thread-${opened}` };
  };
  const healthy: Venue = {
    recordStart: () => ({ outcome: "done" }),
    readChange: (worktree) => {
      const commit = (name: string): string => execFileSync("git", ["rev-parse", name], { cwd: worktree, encoding: "utf8" }).trim();
      const change: Change = {
        key: String(PULL_REQUEST),
        name: `PR #${PULL_REQUEST}`,
        rerun: `squiz review ${PULL_REQUEST}`,
        summaryAt: "on the pull request",
        followUp: "Fix it.",
        base: commit("HEAD^"),
        head: commit("HEAD"),
        description: "What this changes.",
      };
      return { outcome: "found", change };
    },
    episodeDirectory: (worktree, key) => ({ outcome: "found", directory: join(worktree, ".squiz", key) }),
    provideCommits: () => ({ outcome: "ready", alternates: [] }),
    listThreads: () => ({ outcome: "listed", threads: [EARLIER_THREAD] }),
    openThread: posted,
    openFileThread: posted,
    reply: () => ({ outcome: "acted" }),
    resolve: () => ({ outcome: "acted" }),
    reopen: () => ({ outcome: "acted" }),
    postSummary: () => ({ outcome: "posted" }),
    postFailure: () => ({ outcome: "posted" }),
  };
  const answering = { ...healthy, ...failing };
  const venue = Object.fromEntries(
    (Object.keys(healthy) as (keyof Venue)[]).map((member) => [
      member,
      (...args: unknown[]) => {
        calls.push({ member, args });
        return (answering[member] as (...given: unknown[]) => unknown)(...args);
      },
    ]),
  ) as unknown as Venue;
  return { venue, calls };
}

function callsTo(calls: readonly VenueCall[], member: keyof Venue): readonly (readonly unknown[])[] {
  return calls.filter((call) => call.member === member).map((call) => call.args);
}

test("a round the host runs on a fake venue reads the change and lists, opens, rules on and summarises its threads there, and runs no gh", async () => {
  const fake = fakeVenue();
  const ran = await host({
    records: atHead,
    config: { rounds: 1 },
    findings: [[finding("The flag is never read")]],
    verdicts: [[{ thread: EARLIER_THREAD.id, verdict: "fixed" }]],
    round: { venue: fake.venue },
  });

  assert.deepEqual(ran.kinds, [], "the round reached GitHub around the venue it was handed");
  const read = callsTo(fake.calls, "readChange");
  assert.equal(read.length, 1, "the change was not read from the venue");
  assert.equal(callsTo(fake.calls, "listThreads").length, 1, "the threads were not listed through the venue");

  const opened = callsTo(fake.calls, "openThread");
  assert.equal(opened.length, 1, "the finding's thread was not opened on the venue");
  assert.deepEqual(opened[0]?.[1], { path: TRACKED, line: 88, side: "RIGHT" });
  assert.match(String(opened[0]?.[2]), /The flag is never read/u);

  assert.deepEqual(callsTo(fake.calls, "resolve").map((args) => args[0]), [EARLIER_THREAD.id], "the fixed ruling did not resolve its thread on the venue");
  const replies = callsTo(fake.calls, "reply");
  assert.deepEqual(replies.map((args) => args[0]), [EARLIER_THREAD.id], "the fixed ruling did not reply on its thread on the venue");

  const summaries = callsTo(fake.calls, "postSummary");
  assert.equal(summaries.length, 1, "the closing round's summary did not reach the venue");
  assert.equal((summaries[0]?.[0] as Change).key, String(PULL_REQUEST), "the summary went to a change the venue did not read");
  assert.match(String(summaries[0]?.[1]), /Squiz review/u);
  assert.equal(callsTo(fake.calls, "postFailure").length, 0);

  const [record] = recordsOf(ran.state);
  assert.ok(record?.status === "reviewed" && record.result === "exited", `recorded as ${JSON.stringify(record)}`);
  assert.deepEqual(record.problems ?? [], []);
});

test("a round whose thread and failure comment the fake venue refuses records both refusals, rather than a clean round", async () => {
  const fake = fakeVenue({
    openThread: () => ({ outcome: "failed", reason: "the venue would not take the thread" }),
    postFailure: () => ({ outcome: "failed", reason: "the venue would not take the comment" }),
  });
  const ran = await host({
    records: atHead,
    findings: [[finding("The flag is never read")]],
    round: { venue: fake.venue },
  });

  assert.deepEqual(ran.kinds, [], "the round reached GitHub around the venue it was handed");
  assert.equal(callsTo(fake.calls, "openThread").length, 1, "the finding never reached the venue");
  const failures = callsTo(fake.calls, "postFailure");
  assert.equal(failures.length, 1, "the failure comment never reached the venue");
  assert.match(String(failures[0]?.[1]), /found 1 finding and could not post it/u);

  const [record] = recordsOf(ran.state);
  assert.ok(record?.status === "failed", `recorded as ${JSON.stringify(record)}`);
  assert.match(record.reason, /found 1 finding and could not post it to PR #142/u);
  assert.equal(record.lines?.at(-1), `the failure could not be posted on PR #${PULL_REQUEST}: the venue would not take the comment`);
});

test("a closing round whose summary the fake venue refuses keeps the refusal on its record", async () => {
  const fake = fakeVenue({ postSummary: () => ({ outcome: "failed", reason: "the venue would not take the summary" }) });
  const ran = await host({ records: atHead, config: { rounds: 1 }, round: { venue: fake.venue } });

  assert.deepEqual(ran.kinds, [], "the round reached GitHub around the venue it was handed");
  assert.equal(callsTo(fake.calls, "postSummary").length, 1, "the summary never reached the venue");
  const [record] = recordsOf(ran.state);
  assert.ok(record?.status === "reviewed", `recorded as ${JSON.stringify(record)}`);
  assert.deepEqual(record.problems, [`the review of PR #${PULL_REQUEST} closed without its summary: the venue would not take the summary`]);
});

test("a venue that finds no change here runs no reviewer, posts nothing, and records its reason", async () => {
  const fake = fakeVenue({ readChange: () => ({ outcome: "none", reason: "the fake venue has nothing here" }) });
  const ran = await host({ records: atHead, round: { venue: fake.venue } });

  assert.equal(ran.started, 0);
  assert.deepEqual(ran.kinds, []);
  assert.deepEqual(fake.calls.map((call) => call.member), ["episodeDirectory", "readChange"], "the round went on past a venue with no change");
  const [record] = recordsOf(ran.state);
  assert.ok(record?.status === "failed", `recorded as ${JSON.stringify(record)}`);
  assert.equal(record.reason, "no review ran: the fake venue has nothing here");
});

/** `fakeVenue`, with the change it finds named the way the local venue names its own. */
function workingTreeVenue(failing: Partial<Venue> = {}): Venue {
  const { venue } = fakeVenue(failing);
  return {
    ...venue,
    readChange: (worktree, asked, until) => {
      const found = venue.readChange(worktree, asked, until);
      return found.outcome === "found" ? { ...found, change: { ...found.change, name: "the working tree" } } : found;
    },
  };
}

test("#820: the note and host.log for a round on a change named the working tree call it that, never PR #", async () => {
  const ran = await host({
    records: (fixture) => [queued(fixture.head(), null, MAIN)],
    findings: [[finding("The name says nothing.")]],
    // An empty listing never holds the thread the round opens, so host.log says so.
    round: { venue: workingTreeVenue({ listThreads: () => ({ outcome: "listed", threads: [] }) }) },
  });

  const short = ran.firstHead.slice(0, 7);
  const text = onlyNote(ran, MAIN)["text"] ?? "";
  assert.equal(text, `Squiz reviewed the working tree at ${short}: 1 thread is open. Run \`squiz review ${PULL_REQUEST}\` to read it.`);
  assert.match(ran.log, new RegExp(`${short}.*: none of the threads the round left open is open on the working tree, so its note points to squiz review`, "u"));
  assert.doesNotMatch(text + ran.log, /PR #/u);
});

test("#820: a failed round on a change named the working tree says where its failure comment went by that name", async () => {
  const ran = await host({
    records: atHead,
    findings: [[finding("The flag is never read")]],
    round: {
      venue: workingTreeVenue({
        openThread: () => ({ outcome: "failed", reason: "the venue would not take the thread" }),
        postFailure: () => ({ outcome: "failed", reason: "the venue would not take the comment" }),
      }),
    },
  });

  const [record] = recordsOf(ran.state);
  assert.ok(record?.status === "failed", `recorded as ${JSON.stringify(record)}`);
  assert.equal(record.lines?.at(-1), "the failure could not be posted on the working tree: the venue would not take the comment");
});

test("#820: a failed round on a change named the working tree whose failure comment went up says so by that name", async () => {
  const ran = await host({
    records: atHead,
    findings: [[finding("The flag is never read")]],
    round: { venue: workingTreeVenue({ openThread: () => ({ outcome: "failed", reason: "the venue would not take the thread" }) }) },
  });

  const [record] = recordsOf(ran.state);
  assert.ok(record?.status === "failed", `recorded as ${JSON.stringify(record)}`);
  assert.equal(record.lines?.at(-1), "the failure is posted on the working tree");
});

test("#820: a close on a change named the working tree whose summary was refused records the refusal by that name", async () => {
  const ran = await host({
    records: atHead,
    config: { rounds: 1 },
    round: { venue: workingTreeVenue({ postSummary: () => ({ outcome: "failed", reason: "the venue would not take the summary" }) }) },
  });

  const [record] = recordsOf(ran.state);
  assert.ok(record?.status === "reviewed", `recorded as ${JSON.stringify(record)}`);
  assert.deepEqual(record.problems, ["the review of the working tree closed without its summary: the venue would not take the summary"]);
});

