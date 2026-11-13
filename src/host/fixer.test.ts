import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import type { Finding } from "../findings/finding.ts";
import { readState, type EpisodeState } from "../loop/episode-state.ts";
import { episodeAt, type Episode } from "../loop/episode.ts";
import type { StateRecord } from "../loop/state-record.ts";
import { deadlineIn } from "../reviewers/deadline.ts";
import type { Plan } from "../testing/host-fixture.ts";
import { standIn } from "../testing/stand-in.ts";
import { LOCAL_KEY, localVenue } from "../venues/local/venue.ts";
import { fixerCommand, fixerEnvironment, fixerPrompt, newSessionId, resumePrompt, startFixer } from "./fixer.ts";
import { trigger } from "./trigger.ts";

const HANDOFF = "/work/squiz-a/.squiz/local/rounds/1/handoff.md";
const ROOT = "/opt/squiz";
// The checkout these tests run from, which is the plugin a fixer must load.
const CHECKOUT = realpathSync(fileURLToPath(new URL("../..", import.meta.url)));

const UPDATE = "/work/squiz-a/.squiz/local/rounds/2/update.md";
const SESSION = "561adfe1-9888-48be-a97c-f4b6d9e081b3";

test("#803, #876: a Claude Code fixer runs claude -p on the prompt in the session squiz names, loading squiz from the plugin directory, with edits and squiz's and git's commands allowed", () => {
  const prompt = fixerPrompt(HANDOFF);
  assert.deepEqual(fixerCommand("claude", prompt, ROOT, [], { id: SESSION, resume: false }), {
    command: "claude",
    // The prompt comes straight after -p, before any option that takes a list and would swallow it.
    args: ["-p", prompt, "--session-id", SESSION, "--plugin-dir", ROOT, "--permission-mode", "acceptEdits", "--allowedTools", "Bash(squiz:*)", "Bash(git:*)"],
  });
});

test("#876: a resumed Claude Code fixer resumes its session with the plugin directory, permission mode and grants a fresh one has, fixerCommands' included, which a resume does not inherit", () => {
  const prompt = resumePrompt(UPDATE, HANDOFF);
  assert.deepEqual(fixerCommand("claude", prompt, ROOT, ["node"], { id: SESSION, resume: true }), {
    command: "claude",
    args: ["-p", prompt, "--resume", SESSION, "--plugin-dir", ROOT, "--permission-mode", "acceptEdits", "--allowedTools", "Bash(squiz:*)", "Bash(git:*)", "Bash(node:*)"],
  });
});

test("#876: a resumed Copilot fixer resumes its session by --resume, which fails on an unknown id, and never by --session-id, which starts a new session under it, with the grants and quiet flags a fresh one has", () => {
  const prompt = resumePrompt(UPDATE, HANDOFF);
  assert.deepEqual(fixerCommand("copilot", prompt, ROOT, ["node"], { id: SESSION, resume: true }), {
    command: "copilot",
    args: [
      "-p",
      prompt,
      `--resume=${SESSION}`,
      "--plugin-dir",
      ROOT,
      "--no-ask-user",
      "--allow-tool=write",
      "--allow-tool=shell(squiz)",
      "--allow-tool=shell(git)",
      "--allow-tool=shell(node)",
      "--disable-builtin-mcps",
      "--no-auto-update",
      "--disable-client-telemetry",
    ],
  });
});

test("#876: a resumed fixer's prompt names the update and the whole handoff, and still rules out squiz review", () => {
  const prompt = resumePrompt(UPDATE, HANDOFF);
  assert.ok(prompt.includes(UPDATE), `the prompt does not name the update:\n${prompt}`);
  assert.ok(prompt.includes(HANDOFF), `the prompt does not name the handoff:\n${prompt}`);
  assert.match(prompt, /Do not run `squiz review`/u);
});

test("#876: both of the fixer's prompts carry the fix rules: check the finding holds, fix the invariant at every site, add no machinery, re-trace, and run one focused check", () => {
  for (const prompt of [fixerPrompt(HANDOFF), resumePrompt(UPDATE, HANDOFF)]) {
    for (const rule of [/check that the finding holds/iu, /every place in the changed area/iu, /no machinery/iu, /re-trace/iu, /one focused check/iu]) {
      assert.match(prompt, rule, `the prompt lacks the rule ${String(rule)}:\n${prompt}`);
    }
  }
});

test("#876: each fixer gets a session id of its own, as a UUID, which both CLIs require", () => {
  const first = newSessionId();
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
  assert.notEqual(newSessionId(), first);
});

test("#803, #863, #876: a Copilot fixer runs copilot -p on the prompt in the session squiz names, loading squiz from the plugin directory, asking nothing, with writes and squiz's and git's commands allowed, and without the built-in MCP servers, auto-update or client telemetry, as the reviewer runs", () => {
  const prompt = fixerPrompt(HANDOFF);
  assert.deepEqual(fixerCommand("copilot", prompt, ROOT, [], { id: SESSION, resume: false }), {
    command: "copilot",
    args: [
      "-p",
      prompt,
      `--session-id=${SESSION}`,
      "--plugin-dir",
      ROOT,
      "--no-ask-user",
      "--allow-tool=write",
      "--allow-tool=shell(squiz)",
      "--allow-tool=shell(git)",
      "--disable-builtin-mcps",
      "--no-auto-update",
      "--disable-client-telemetry",
    ],
  });
});

test("#864: a Claude Code fixer is also allowed each command fixerCommands names, by its name alone", () => {
  const prompt = fixerPrompt(HANDOFF);
  assert.deepEqual(fixerCommand("claude", prompt, ROOT, ["node", "npm"], { id: SESSION, resume: false }), {
    command: "claude",
    args: ["-p", prompt, "--session-id", SESSION, "--plugin-dir", ROOT, "--permission-mode", "acceptEdits", "--allowedTools", "Bash(squiz:*)", "Bash(git:*)", "Bash(node:*)", "Bash(npm:*)"],
  });
});

test("#864: a Copilot fixer is also allowed each command fixerCommands names, by its name alone, and keeps its quiet flags", () => {
  const prompt = fixerPrompt(HANDOFF);
  assert.deepEqual(fixerCommand("copilot", prompt, ROOT, ["node", "npm"], { id: SESSION, resume: false }), {
    command: "copilot",
    args: [
      "-p",
      prompt,
      `--session-id=${SESSION}`,
      "--plugin-dir",
      ROOT,
      "--no-ask-user",
      "--allow-tool=write",
      "--allow-tool=shell(squiz)",
      "--allow-tool=shell(git)",
      "--allow-tool=shell(node)",
      "--allow-tool=shell(npm)",
      "--disable-builtin-mcps",
      "--no-auto-update",
      "--disable-client-telemetry",
    ],
  });
});

test("#803: the fixer's prompt names the handoff, and tells it not to run squiz review, because its own stop starts the next round", () => {
  const prompt = fixerPrompt(HANDOFF);
  assert.ok(prompt.includes(HANDOFF), `the prompt does not name the handoff:\n${prompt}`);
  assert.match(prompt, /Do not run `squiz review`/u);
});

test("#803: the fixer's environment drops the dispatching session's messaging socket, keeps the rest, and marks the fixer as squiz's (#870)", () => {
  const environment = fixerEnvironment({ PATH: "/usr/bin", CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/s.sock", CLAUDE_CONFIG_DIR: "/c", COPILOT_CLI: "1" });
  assert.deepEqual(environment, { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/c", COPILOT_CLI: "1", SQUIZ_FIXER: "1" });
});

test("#803: a fixer started where its CLI is not on PATH fails, saying so, rather than reading as started", () => {
  const root = mkdtempSync(join(tmpdir(), "squiz-fixer-"));
  try {
    const started = startFixer({ agent: "claude", commands: [], handoff: HANDOFF, session: SESSION, worktree: root, logPath: join(root, "fixer.log"), environment: { PATH: join(root, "empty") } }, 5_000);
    assert.equal(started.outcome, "failed", `started as ${JSON.stringify(started)}`);
    assert.match(started.outcome === "failed" ? started.reason : "", /ENOENT/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#803: a fixer starts detached in the worktree, with the plugin directory of the squiz that started it, and its output in its log", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "squiz-fixer-")));
  try {
    const binaries = join(root, "bin");
    const worktree = join(root, "tree");
    for (const directory of [binaries, worktree]) mkdirSync(directory);
    standIn(binaries, "copilot", 'pwd > "$(dirname "$0")/ran-in"; printf "%s\\n" "$@" > "$(dirname "$0")/argv"; echo the fixer ran');
    const log = join(root, "fixer.log");
    const started = startFixer({ agent: "copilot", commands: [], handoff: HANDOFF, session: SESSION, worktree, logPath: log, environment: { PATH: `${binaries}:/usr/bin:/bin` } }, 5_000);
    assert.ok(started.outcome === "started" || started.outcome === "exited", `started as ${JSON.stringify(started)}`);
    const argv = join(binaries, "argv");
    for (let waited = 0; !existsSync(argv) && waited < 5_000; waited += 50) await sleep(50);
    const args = readFileSync(argv, "utf8").split("\n");
    assert.equal(args[args.indexOf("--plugin-dir") + 1], CHECKOUT, `the fixer was not handed this checkout:\n${args.join("\n")}`);
    assert.equal(readFileSync(join(binaries, "ran-in"), "utf8").trim(), worktree);
    for (let waited = 0; !readFileSync(log, "utf8").includes("the fixer ran") && waited < 5_000; waited += 50) await sleep(50);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#876: a resumed fixer starts detached in the worktree as a fresh one does, resuming its session with this checkout's plugin directory and SQUIZ_FIXER set, and its exit status is written where the host reads it", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "squiz-fixer-")));
  try {
    const binaries = join(root, "bin");
    const worktree = join(root, "tree");
    for (const directory of [binaries, worktree]) mkdirSync(directory);
    standIn(binaries, "copilot", 'printf "%s\\n" "$@" > "$(dirname "$0")/argv"; printf "%s" "$SQUIZ_FIXER" > "$(dirname "$0")/marked"; exit 3');
    const exitPath = join(root, "fixer.exit");
    const started = startFixer(
      { agent: "copilot", commands: [], handoff: HANDOFF, session: SESSION, resume: { update: UPDATE, exitPath }, worktree, logPath: join(root, "fixer.log"), environment: { PATH: `${binaries}:/usr/bin:/bin` } },
      5_000,
    );
    assert.ok(started.outcome === "started" || started.outcome === "exited", `started as ${JSON.stringify(started)}`);
    for (let waited = 0; !existsSync(exitPath) && waited < 5_000; waited += 50) await sleep(50);
    const args = readFileSync(join(binaries, "argv"), "utf8").split("\n");
    assert.ok(args.includes(`--resume=${SESSION}`), `the fixer did not resume its session:\n${args.join("\n")}`);
    assert.equal(args[args.indexOf("--plugin-dir") + 1], CHECKOUT, `the fixer was not handed this checkout:\n${args.join("\n")}`);
    assert.ok(args[1]?.includes(UPDATE), `the fixer was not handed the update:\n${args.join("\n")}`);
    assert.equal(readFileSync(join(binaries, "marked"), "utf8"), "1", "the resumed fixer's environment does not mark it as squiz's");
    assert.equal(readFileSync(exitPath, "utf8").trim(), "3", "the resumed fixer's exit status was not written");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const hostFixture = fileURLToPath(new URL("../testing/host-fixture.ts", import.meta.url));
const fixerStandIn = fileURLToPath(new URL("../testing/fixer-stand-in.ts", import.meta.url));

const FINDING: Finding = {
  scope: "line",
  file: "card.ts",
  line: 2,
  severity: "high",
  headline: "The new line says nothing",
  reasoning: ["A reader cannot tell what it is for."],
  suggestedFix: "Say what it is for.",
};

const STILL_OPEN = { thread: "T1", verdict: "open", reason: "The line still says nothing." } as const;

function git(directory: string, args: readonly string[]): void {
  execFileSync("git", args, { cwd: directory, stdio: "ignore" });
}

/** A headless run under way: its original run's stop has queued round 1. */
type Headless = {
  readonly episode: Episode;
  /** host.log as it stands. */
  readonly log: () => string;
  /** Each stop of a fixer run so far: the prompt the run was given, its session, and how its trigger went. */
  readonly stops: () => readonly Stopped[];
  /** The episode's records as they stand. */
  readonly records: () => readonly StateRecord[];
  /** The episode's state as it stands. */
  readonly state: () => EpisodeState | undefined;
};

/** One stop of a fixer run, as `fixer-stand-in.ts` logs it. */
type Stopped = { readonly prompt: string; readonly session: string; readonly resumed: boolean; readonly triggered: string };

/**
 * Start a headless run on the local venue in `root`, under `config`, whose
 * reviewer starts report `starts` and whose fixer runs do `fixes`, and have the
 * original run's stop queue its first round. The host, and every fixer after
 * it, runs on a PATH on which no real CLI is.
 */
function headless(root: string, config: Plan["config"], starts: Plan["starts"], fixes: Plan["fixes"] = []): Headless {
  const worktree = join(root, "tree");
  const binaries = join(root, "bin");
  mkdirSync(worktree);
  mkdirSync(binaries);
  git(worktree, ["init", "--quiet", "--initial-branch", "work"]);
  git(worktree, ["config", "user.email", "squiz@example.invalid"]);
  git(worktree, ["config", "user.name", "Squiz"]);
  writeFileSync(join(worktree, "card.ts"), "// line 1\n");
  writeFileSync(join(worktree, ".squiz.json"), `{"venue": "local"}\n`);
  git(worktree, ["add", "."]);
  git(worktree, ["commit", "--quiet", "--message", "the base"]);
  assert.equal(localVenue.recordStart(worktree, deadlineIn(10_000)).outcome, "done", "the base was not recorded");
  // The original run's work.
  writeFileSync(join(worktree, "card.ts"), "// line 1\n// line 2\n");

  const charterFile = join(root, "charter.md");
  writeFileSync(charterFile, "What a good review is.\n");
  const plan: Plan = { charterFile, venue: "local", config, starts, fixes };
  const planFile = join(root, "plan.json");
  writeFileSync(planFile, JSON.stringify(plan));
  const fixesLog = join(root, "fixes.log");
  standIn(binaries, "claude", `exec '${process.execPath}' '${fixerStandIn}' '${planFile}' '${fixesLog}' "$@"`);
  process.env["PATH"] = `${binaries}:/usr/bin:/bin`;

  const first = trigger({
    directory: worktree,
    trigger: "hook",
    owner: { sessionId: "the-original-run" },
    environment: {},
    until: deadlineIn(10_000),
    host: (key) => ({ command: process.execPath, args: [hostFixture, key, planFile] }),
  });
  assert.ok(first.outcome === "decided" && first.queued, `the original run's stop queued nothing: ${JSON.stringify(first)}`);

  const named = episodeAt(localVenue, worktree, LOCAL_KEY);
  assert.ok(named.outcome === "found");
  const { episode } = named;
  const hostLog = join(episode.directory, "host.log");
  return {
    episode,
    log: () => (existsSync(hostLog) ? readFileSync(hostLog, "utf8") : ""),
    stops: () => (existsSync(fixesLog) ? readFileSync(fixesLog, "utf8").trim().split("\n") : []).map((line) => JSON.parse(line) as Stopped),
    records: () => {
      const read = readState(episode);
      return read.outcome === "read" ? (read.state.records ?? []) : [];
    },
    state: () => {
      const read = readState(episode);
      return read.outcome === "read" ? read.state : undefined;
    },
  };
}

/** Wait up to 90 seconds for `path` to exist, and say whether it does. */
async function appears(path: string): Promise<boolean> {
  for (let waited = 0; !existsSync(path) && waited < 90_000; waited += 100) await sleep(100);
  return existsSync(path);
}

/** How each record ended: its exit status and its fixer's start, or its status alone. */
function endings(records: readonly StateRecord[]): readonly string[] {
  return records.map((record) => {
    if (record.status !== "reviewed" || record.result !== "exited") return record.status;
    const started = record.fixer?.outcome === "started" || record.fixer?.outcome === "exited";
    return `exit ${record.exitStatus}, ${record.fixer === undefined ? "no fixer" : started ? "a fixer started" : record.fixer.outcome}`;
  });
}

/** Run `body` in a temporary directory, with PATH put back and the directory removed after. */
async function inRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "squiz-fixer-end-")));
  const previous = process.env["PATH"];
  try {
    await body(root);
  } finally {
    if (previous === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test("#803: under a cap of 3, a headless run's fixers work the threads twice, the closing round starts none, and closed.json holds the close", { timeout: 120_000 }, async () => {
  await inRoot(async (root) => {
    const run = headless(root, { rounds: 3, fixer: "claude" }, [
      { findings: [FINDING], verdicts: [] },
      { findings: [], verdicts: [STILL_OPEN] },
      { findings: [], verdicts: [STILL_OPEN] },
    ]);
    const marker = join(run.episode.directory, "closed.json");
    assert.ok(await appears(marker), `the episode never closed; host.log says:\n${run.log()}`);
    // A fixer the closing round started would have started before the close was written.
    await sleep(1_500);

    const runs = run.stops();
    assert.equal(runs.length, 2, `${runs.length} fixers ran under a cap of 3:\n${JSON.stringify(runs, null, 2)}\nhost.log says:\n${run.log()}`);
    assert.match(runs[0]?.prompt ?? "", /rounds\/1\/handoff\.md holds them/u);
    // The second resumes the first's session, on what changed since (#876).
    assert.match(runs[1]?.prompt ?? "", /rounds\/2\/update\.md holds what changed/u);
    const records = run.records();
    assert.deepEqual(endings(records), ["exit 2, a fixer started", "exit 2, a fixer started", "exit 3, no fixer"]);
    assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")), { head: records[2]?.head, exitStatus: 3, openThreads: ["T1"], closedAt: "round cap" });
    assert.equal(existsSync(join(run.episode.directory, "stopped.json")), false, "an episode that closed also says it stopped short");
  });
});

test("#860: a headless run whose fixer changes nothing ends in stopped.json once the fixer exits, though nothing triggers again", { timeout: 120_000 }, async () => {
  await inRoot(async (root) => {
    const run = headless(root, { rounds: 3, fixer: "claude" }, [{ findings: [FINDING], verdicts: [] }], ["changes nothing"]);
    const stopFile = join(run.episode.directory, "stopped.json");
    assert.ok(await appears(stopFile), `no stopped.json; host.log says:\n${run.log()}`);

    assert.deepEqual(run.stops().map(({ triggered }) => triggered), ["result, queued false"]);
    const records = run.records();
    assert.deepEqual(endings(records), ["exit 2, a fixer started"]);
    const stop = JSON.parse(readFileSync(stopFile, "utf8")) as Record<string, unknown>;
    assert.equal(stop["head"], records[0]?.head);
    assert.equal(stop["stopped"], "fixer queued nothing");
    assert.equal(existsSync(join(run.episode.directory, "closed.json")), false);
  });
});

test("#860: a headless run whose fixer was held back behind an earlier one, whose last stop then queues nothing, ends in stopped.json naming that", { timeout: 120_000 }, async () => {
  await inRoot(async (root) => {
    const run = headless(
      root,
      { rounds: 3, fixer: "claude" },
      [
        { findings: [FINDING], verdicts: [] },
        { findings: [], verdicts: [STILL_OPEN] },
      ],
      ["stops twice"],
    );
    const stopFile = join(run.episode.directory, "stopped.json");
    assert.ok(await appears(stopFile), `no stopped.json; host.log says:\n${run.log()}`);

    const records = run.records();
    assert.deepEqual(endings(records), ["exit 2, a fixer started", "exit 2, not started"], `host.log says:\n${run.log()}`);
    assert.equal(run.stops().length, 2, `the fixer's stops were ${JSON.stringify(run.stops())}`);
    const stop = JSON.parse(readFileSync(stopFile, "utf8")) as Record<string, unknown>;
    assert.equal(stop["head"], records[1]?.head);
    assert.equal(stop["stopped"], "earlier fixer queued nothing");
  });
});

/** Under a cap of 3, a finding round 1 opens and rounds 2 and 3 keep open. */
const KEPT_OPEN: Plan["starts"] = [
  { findings: [FINDING], verdicts: [] },
  { findings: [], verdicts: [STILL_OPEN] },
  { findings: [], verdicts: [STILL_OPEN] },
];

test("#876: under a cap of 3, a headless run starts one fixer on round 1's handoff and resumes that session for round 2 on what changed since, and the closing round starts none", { timeout: 120_000 }, async () => {
  await inRoot(async (root) => {
    const run = headless(root, { rounds: 3, fixer: "claude" }, KEPT_OPEN);
    const marker = join(run.episode.directory, "closed.json");
    assert.ok(await appears(marker), `the episode never closed; host.log says:\n${run.log()}`);
    // A fixer the closing round started would have started before the close was written.
    await sleep(1_500);

    const [first, second, ...more] = run.stops();
    assert.equal(more.length, 0, `more than two fixers ran under a cap of 3; host.log says:\n${run.log()}`);
    assert.match(first?.prompt ?? "", /rounds\/1\/handoff\.md holds them/u);
    assert.equal(first?.resumed, false, "the first fixer was not started fresh");
    assert.equal(second?.resumed, true, `the second fixer was not a resume; host.log says:\n${run.log()}`);
    assert.equal(second?.session, first?.session, "the second fixer resumed a session other than the first's");
    assert.match(second?.prompt ?? "", /rounds\/2\/update\.md/u);
    const update = readFileSync(join(run.episode.directory, "rounds", "2", "update.md"), "utf8");
    assert.match(update, /The line still says nothing\./u, `the update lacks the reviewer's ruling:\n${update}`);
    const session = run.state()?.fixerSession;
    assert.deepEqual(session === undefined ? undefined : { agent: session.agent, id: session.id, round: session.round }, { agent: "claude", id: first?.session, round: 1 });
    assert.ok(run.log().includes(`round 2: resuming the fixer's session ${first?.session ?? ""}, which round 1 started`), run.log());
    assert.deepEqual(endings(run.records()), ["exit 2, a fixer started", "exit 2, a fixer started", "exit 3, no fixer"]);
  });
});

test("#876: a resume that fails drops the session, runs the same round in a fresh fixer on the whole handoff, and host.log says so", { timeout: 120_000 }, async () => {
  await inRoot(async (root) => {
    const run = headless(root, { rounds: 3, fixer: "claude" }, KEPT_OPEN, ["changes", "cannot resume", "changes"]);
    const marker = join(run.episode.directory, "closed.json");
    assert.ok(await appears(marker), `the episode never closed; host.log says:\n${run.log()}`);

    const [first, second, ...more] = run.stops();
    assert.equal(more.length, 0, `${run.stops().length} fixer runs stopped; host.log says:\n${run.log()}`);
    assert.equal(second?.resumed, false, `the round's second fixer resumed again; host.log says:\n${run.log()}`);
    assert.notEqual(second?.session, first?.session, "the fresh fixer ran in the session whose resume failed");
    assert.match(second?.prompt ?? "", /rounds\/2\/handoff\.md holds them/u);
    assert.ok(
      run.log().includes(`round 2: the resume of the fixer's session ${first?.session ?? ""} failed: it exited 1; starting a fresh fixer on the whole handoff`),
      run.log(),
    );
    assert.equal(run.state()?.fixerSession?.id, second?.session);
    assert.equal(run.state()?.fixerSession?.round, 2);
    assert.deepEqual(endings(run.records()), ["exit 2, a fixer started", "exit 2, a fixer started", "exit 3, no fixer"]);
  });
});

test("#876: a state whose stop carried a session other than the fixer's gets a fresh fixer rather than a resume, as a resume that started a new session would read", { timeout: 120_000 }, async () => {
  await inRoot(async (root) => {
    const run = headless(root, { rounds: 3, fixer: "claude" }, KEPT_OPEN, ["stops as another session", "changes"]);
    const marker = join(run.episode.directory, "closed.json");
    assert.ok(await appears(marker), `the episode never closed; host.log says:\n${run.log()}`);

    const [first, second] = run.stops();
    assert.equal(second?.resumed, false, `the second fixer resumed; host.log says:\n${run.log()}`);
    assert.notEqual(second?.session, first?.session);
    assert.match(second?.prompt ?? "", /rounds\/2\/handoff\.md holds them/u);
    assert.match(run.log(), /round 2: starting a fresh fixer: the state it hands back was queued by session another-\d+, not by the fixer's session/u);
  });
});
