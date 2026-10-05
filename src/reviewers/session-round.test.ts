/**
 * The round's reviewer started as a session: in a tmux window or a Herdr pane
 * where the environment offers one, and as a child with no terminal otherwise.
 *
 * Every tmux and Herdr here is a private server of the test's own. The owner's
 * environment may name their own servers, so it is never handed to the round:
 * each test builds the environment the round chooses a backend from.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test, type TestContext } from "node:test";

import type { Backends, SessionPlace } from "../sessions/session.ts";
import { startChild } from "../sessions/child.ts";
import { closeHerdrPane, startInHerdrPane } from "../sessions/herdr.ts";
import { identityOf } from "../sessions/process.ts";
import { openWindow } from "../sessions/tmux.ts";
import type { Adapter, Invocation } from "./adapter.ts";
import { makeRoundSpace, shellPrefix } from "./groups.ts";
import { pi } from "./pi/adapter.ts";
import { grants } from "./pi/argv.ts";
import { REPORTS_VARIABLE } from "./report-file.ts";
import { readReports as parse } from "./pi/reports.ts";
import { FINISH_REVIEW, REPORT_FINDING } from "./reporting.ts";
import { type Round, runRound, type Sessions } from "./round.ts";

const finding = {
  scope: "line",
  file: "src/ui/card.ts",
  line: 88,
  severity: "high",
  headline: "The renamed field is still read under its old name",
  reasoning: ["The caller reads the old value."],
  suggestedFix: "Rename it.",
};

/** A reviewer that reports one finding, finishes, and closes its run. */
const reviewLines = [
  usage("toolUse", 0.002),
  JSON.stringify({ type: "report", call: REPORT_FINDING, value: finding }),
  JSON.stringify({ type: "finish", call: FINISH_REVIEW }),
  usage("stop", 0.001),
]
  .map((line) => `${line}\n`)
  .join("");

function usage(stopReason: string, spend: number): string {
  return JSON.stringify({
    type: "usage",
    stopReason,
    model: "stand-in",
    usage: {
      input: 100,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 100,
      cost: { input: spend, output: 0, cacheRead: 0, cacheWrite: 0, total: spend },
    },
  });
}

/**
 * A stand-in for `pi` in a pane, as a Node script.
 *
 * It notes whether it has a terminal and what its pid is, reviews for
 * `reviewingMs`, reports, and then reads its terminal as an interactive `pi`
 * does once it settles. It exits a moment after the finish only because the
 * extension's shutdown makes the real one do so. A round that reached its bound
 * here did not see the reviewer exit.
 */
function finishingInAPane(noteFile: string, reviewingMs = 0): string {
  return [
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(noteFile)}, JSON.stringify({ tty: process.stdin.isTTY === true, pid: process.pid }));`,
    "process.stdin.resume();",
    `setTimeout(() => {`,
    `  fs.appendFileSync(process.env.${REPORTS_VARIABLE}, ${JSON.stringify(reviewLines)});`,
    "  setTimeout(() => process.exit(0), 300);",
    `}, ${reviewingMs});`,
  ].join("\n");
}

/**
 * A stand-in that answers neither `SIGHUP` nor `SIGTERM` and never exits, with a
 * child of its own in its group.
 *
 * A pane close sends `SIGHUP` and nothing more, so only a signal to its group
 * that escalates to `SIGKILL` stops it.
 */
function deafInAPane(noteFile: string): string {
  return [
    'const fs = require("node:fs");',
    'const { spawn } = require("node:child_process");',
    "process.on('SIGHUP', () => {});",
    "process.on('SIGTERM', () => {});",
    "setInterval(() => {}, 1000);",
    "const tool = spawn('/bin/sh', ['-c', 'trap \"\" HUP TERM; while :; do sleep 1; done'], { stdio: 'ignore' });",
    `fs.writeFileSync(${JSON.stringify(noteFile)}, JSON.stringify({ tty: process.stdin.isTTY === true, pid: process.pid, tool: tool.pid }));`,
  ].join("\n");
}

/** What a stand-in noted of itself. */
type Note = { readonly tty: boolean; readonly pid: number; readonly tool?: number };

function noteIn(file: string): Note {
  return JSON.parse(readFileSync(file, "utf8")) as Note;
}

/**
 * An adapter running `inPane` in a pane, through `program`, and `detached` with
 * no terminal, through Node. It reads what the reviewer reported as `pi`'s
 * adapter does.
 */
function adapterOf(scripts: { readonly inPane: string; readonly detached: string }, program = process.execPath): Adapter {
  return {
    argv: (invocation) => {
      const pane = invocation.terminal === "pane";
      return {
        command: pane ? program : process.execPath,
        args: pane && program !== process.execPath ? [scriptFile(invocation, scripts.inPane)] : ["-e", pane ? scripts.inPane : scripts.detached],
        directory: invocation.directory,
        stdin: pane ? "terminal" : "/dev/null",
        environment: { [REPORTS_VARIABLE]: invocation.reportsFile },
      };
    },
    confine: () => ({ outcome: "prepared", environment: {} }),
    parse,
    grants,
  };
}

/** `script` written beside the reports, for a stand-in that takes a file rather than `-e`. */
function scriptFile(invocation: Invocation, script: string): string {
  const file = join(invocation.directory, "stand-in.cjs");
  writeFileSync(file, script, "utf8");
  return file;
}

function invocationIn(tree: string): Invocation {
  return {
    directory: tree,
    charterFile: join(tree, "charter.md"),
    prompt: "Review pull request 142.",
    sessionDirectory: join(tree, ".squiz/142/rounds/1/session"),
    promptFile: join(tree, ".squiz/142/rounds/1/prompt.md"),
    reportsFile: join(tree, ".squiz/142/rounds/1/reports.jsonl"),
    scratchDirectory: join(tree, ".squiz/142/scratch"),
    depth: "read",
    thinking: "medium",
    roundSpace: undefined,
    terminal: "none",
  };
}

function treeFor(t: TestContext): string {
  const tree = realpathSync(mkdtempSync(join(tmpdir(), "squiz-session-round-")));
  t.after(() => rmSync(tree, { recursive: true, force: true }));
  return tree;
}

/** The owner's environment with nothing in it that names their tmux or Herdr. */
function noPanes(): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("HERDR_") && !name.startsWith("TMUX")),
  );
}

type TmuxServer = {
  readonly environment: Record<string, string | undefined>;
  readonly tmux: (...args: string[]) => string;
  readonly windows: () => readonly string[];
};

/** A tmux server of the test's own, reading no configuration, killed when the test ends. */
function privateTmux(t: TestContext): TmuxServer {
  const socketName = `squiz-sr-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const tmux = (...args: string[]): string => {
    const result = spawnSync("tmux", ["-L", socketName, "-f", "/dev/null", ...args], {
      encoding: "utf8",
      env: noPanes(),
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
  return {
    environment: { ...noPanes(), TMUX: `${socketPath},${serverPid},0` },
    tmux,
    windows: () => tmux("list-windows", "-a", "-F", "#{window_id}").split("\n"),
  };
}

const tmuxInstalled = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

/**
 * Whether `pid` runs anything. A killed reviewer is the pane server's zombie
 * until the server reaps it, which tmux on Linux can leave for seconds, and a
 * zombie runs nothing.
 */
function running(pid: number): boolean {
  return identityOf(pid, 5_000).outcome !== "gone";
}

async function eventually(done: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (done()) return true;
    await new Promise((settle) => setTimeout(settle, 25));
  }
  return done();
}

function accountOf(round: Round): string {
  return `the round came back as ${JSON.stringify(round)}`;
}

describe("in a tmux window", { skip: tmuxInstalled ? false : "tmux is not installed" }, () => {
  test("a reviewer in a window reports to the round, exits on its own after the finish, and leaves no window", async (t) => {
    const server = privateTmux(t);
    const tree = treeFor(t);
    const noteFile = join(tree, "note.json");
    const places: SessionPlace[] = [];
    const sessions: Sessions = {
      environment: server.environment,
      name: "squiz-142-r1",
      started: (place) => places.push(place),
    };

    const started = Date.now();
    const round = await runRound(
      adapterOf({ inPane: finishingInAPane(noteFile), detached: "process.exit(3)" }),
      invocationIn(tree),
      30,
      sessions,
    );

    assert.equal(round.outcome, "reviewed", accountOf(round));
    assert.deepEqual(round.outcome === "reviewed" ? round.findings : [], [finding]);
    assert.ok(Date.now() - started < 15_000, "the round waited out its bound rather than seeing the reviewer exit");
    const note = noteIn(noteFile);
    assert.equal(note.tty, true, "the reviewer ran with no terminal, so not in the window");
    assert.equal(places.length, 1, `the round said it started ${places.length} reviewers`);
    const [place] = places;
    assert.ok(place?.backend === "tmux", `the reviewer started in ${JSON.stringify(place)}`);
    assert.equal(place.identity.pid, note.pid, "the identity is not the reviewer's own");
    assert.ok(!server.windows().includes(place.window.id), "the reviewer's window is still open");
  });

  test("at the bound the round stops the reviewer's own group, not just its window, and the window is gone", async (t) => {
    const server = privateTmux(t);
    const tree = treeFor(t);
    const noteFile = join(tree, "note.json");
    const places: SessionPlace[] = [];

    const round = await runRound(
      adapterOf({ inPane: deafInAPane(noteFile), detached: "process.exit(3)" }),
      invocationIn(tree),
      2,
      { environment: server.environment, name: "squiz-142-r1", started: (place) => places.push(place) },
    );

    assert.equal(round.outcome, "timed-out", accountOf(round));
    const note = noteIn(noteFile);
    const [place] = places;
    assert.ok(place?.backend === "tmux", `the reviewer started in ${JSON.stringify(place)}`);
    assert.equal(place.identity.pid, note.pid, "the group signalled is not the reviewer's");
    assert.ok(await eventually(() => !running(note.pid), 2_000), `the reviewer ${note.pid} is still running`);
    assert.ok(await eventually(() => !running(note.tool ?? 0), 2_000), `the reviewer's tool ${note.tool} is still running`);
    assert.ok(!server.windows().includes(place.window.id), "the reviewer's window is still open");
  });

  test("a window that failed to start is closed, the round fails with the reason, and no second reviewer runs", async (t) => {
    const server = privateTmux(t);
    const tree = treeFor(t);
    const window = server.tmux("new-window", "-d", "-P", "-F", "#{window_id}", "-n", "squiz-142-r1", "sleep 60");
    let children = 0;
    const backends: Backends = {
      herdr: () => ({ outcome: "refused", reason: "not asked" }),
      tmux: () => ({ outcome: "failed", reason: "tmux printed no window and pid", window: { id: window, name: "squiz-142-r1" } }),
      child: async (command, environment, boundMs) => {
        children += 1;
        return startChild(command, environment, boundMs);
      },
    };

    const round = await runRound(
      adapterOf({ inPane: "process.exit(0)", detached: "process.exit(0)" }),
      invocationIn(tree),
      10,
      { environment: server.environment, name: "squiz-142-r1", backends },
    );

    assert.equal(round.outcome, "setup", accountOf(round));
    assert.match(round.outcome === "setup" ? round.reason : "", /tmux printed no window and pid/u);
    assert.equal(children, 0, "a second reviewer was started after the window failed");
    assert.ok(!server.windows().includes(window), "the window the failed start left open is still open");
  });

  // tmux started the reviewer and only reading its identity failed, so it runs.
  // Closing the window sends it one SIGHUP, which this reviewer ignores.
  test("a reviewer whose window started and whose identity could not be read does not outlive the round", async (t) => {
    const server = privateTmux(t);
    const tree = treeFor(t);
    const noteFile = join(tree, "note.json");
    const opened: string[] = [];
    const backends: Backends = {
      herdr: () => ({ outcome: "refused", reason: "not asked" }),
      tmux: (request, environment, boundMs) => {
        const opening = openWindow(request, environment, boundMs);
        if (opening.outcome !== "opened") return opening;
        opened.push(opening.window.id);
        // As a `ps` that ran long before it failed: the reviewer is under way by the time the start gives up.
        const until = Date.now() + 5_000;
        while (!existsSync(noteFile) && Date.now() < until) spawnSync("sleep", ["0.05"]);
        return { outcome: "failed", reason: "ps could not be run: a stand-in for ps failing", window: opening.window };
      },
      child: async () => ({ outcome: "failed", reason: "a second reviewer was started" }),
    };

    const round = await runRound(
      adapterOf({ inPane: deafInAPane(noteFile), detached: "process.exit(3)" }),
      invocationIn(tree),
      60,
      { environment: server.environment, name: "squiz-142-r1", backends },
    );

    assert.equal(round.outcome, "setup", accountOf(round));
    assert.match(round.outcome === "setup" ? round.reason : "", /a stand-in for ps failing/u);
    assert.ok(await eventually(() => existsSync(noteFile), 5_000), "the reviewer never started in the window");
    const note = noteIn(noteFile);
    assert.ok(await eventually(() => !running(note.pid), 2_000), `the reviewer ${note.pid} outlived the round`);
    assert.ok(await eventually(() => !running(note.tool ?? 0), 2_000), `the reviewer's tool ${note.tool} outlived the round`);
    assert.ok(!server.windows().includes(opened[0] ?? ""), "the reviewer's window is still open");
  });

  test("a tmux that refuses opens nothing, and the reviewer runs with no terminal instead", async (t) => {
    const tree = treeFor(t);
    const noteFile = join(tree, "note.json");
    const places: SessionPlace[] = [];
    const detached = [
      'const fs = require("node:fs");',
      `fs.writeFileSync(${JSON.stringify(noteFile)}, JSON.stringify({ tty: process.stdin.isTTY === true, pid: process.pid }));`,
      `fs.appendFileSync(process.env.${REPORTS_VARIABLE}, ${JSON.stringify(reviewLines)});`,
    ].join("\n");

    const round = await runRound(
      adapterOf({ inPane: "process.exit(3)", detached }),
      invocationIn(tree),
      10,
      {
        environment: { ...noPanes(), TMUX: `${join(tree, "no-such-socket")},1,0` },
        name: "squiz-142-r1",
        started: (place) => places.push(place),
      },
    );

    assert.equal(round.outcome, "reviewed", accountOf(round));
    const [place] = places;
    assert.equal(place?.backend, "child");
    assert.equal(place?.identity.pid, noteIn(noteFile).pid);
  });
});

test("with no pane to start in the reviewer is a child, and the round is told its identity as it starts", async (t) => {
  const tree = treeFor(t);
  const noteFile = join(tree, "note.json");
  const places: SessionPlace[] = [];
  const detached = [
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(noteFile)}, JSON.stringify({ tty: process.stdin.isTTY === true, pid: process.pid }));`,
    `fs.appendFileSync(process.env.${REPORTS_VARIABLE}, ${JSON.stringify(reviewLines)});`,
  ].join("\n");

  const round = await runRound(adapterOf({ inPane: "process.exit(3)", detached }), invocationIn(tree), 10, {
    environment: noPanes(),
    name: "squiz-142-r1",
    started: (place) => places.push(place),
  });

  assert.equal(round.outcome, "reviewed", accountOf(round));
  assert.equal(places.length, 1);
  assert.equal(places[0]?.backend, "child");
  assert.equal(places[0]?.identity.pid, noteIn(noteFile).pid);
});

// Against a real Herdr. Every call goes to a private server under a home of its
// own, so neither the owner's server nor their configuration is touched.

const herdrInstalled = spawnSync("herdr", ["--version"], { stdio: "ignore" }).status === 0;

describe("in a Herdr pane, against a private server", { skip: herdrInstalled ? false : "herdr is not installed" }, () => {
  // A Unix socket's path is short (104 bytes on macOS), so both names are short.
  const session = `sqr-${process.pid}`;
  let home = "";
  let server: ChildProcess | undefined;
  let environment: Record<string, string | undefined> = {};
  let fakes = "";

  const herdr = (args: readonly string[]): string => {
    const result = spawnSync("herdr", args, { encoding: "utf8", env: environment as NodeJS.ProcessEnv, timeout: 10_000 });
    return `${result.stdout ?? ""}${result.stderr ?? ""}`;
  };

  before(async () => {
    home = mkdtempSync("/tmp/sqr-");
    fakes = join(home, "bin");
    mkdirSync(fakes);
    const herdrPath = spawnSync("/bin/sh", ["-c", "command -v herdr"], { encoding: "utf8" }).stdout.trim();
    // Stands in for `pi`: it tells Herdr it is a ready `pi`, then becomes the
    // Node script its first argument names, with the same pid. Where
    // STAND_IN names the script instead, every argument is passed on to it.
    writeFileSync(
      join(fakes, "pi"),
      [
        "#!/bin/sh",
        `'${herdrPath}' pane report-agent --source squiz-test --agent pi --state idle "$HERDR_PANE_ID" >/dev/null 2>&1`,
        `[ -n "$STAND_IN" ] && exec '${process.execPath}' "$STAND_IN" "$@"`,
        `exec '${process.execPath}' "$1"`,
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(join(fakes, "pi"), 0o755);
    const base = Object.fromEntries(
      Object.entries(noPanes()).filter(([name]) => name !== "ZDOTDIR"),
    );
    const socket = join(home, ".config", "herdr", "sessions", session, "herdr.sock");
    server = spawn(herdrPath, ["--session", session, "server"], {
      env: { ...base, HOME: home, PATH: `${fakes}:/usr/bin:/bin` } as NodeJS.ProcessEnv,
      stdio: "ignore",
    });
    for (let tries = 0; tries < 100 && !existsSync(socket); tries += 1) {
      await new Promise((settle) => setTimeout(settle, 100));
    }
    assert.ok(existsSync(socket), `the private Herdr server made no socket at ${socket}`);
    environment = { ...base, HOME: home, HERDR_SOCKET_PATH: socket };
    herdr(["workspace", "create", "--cwd", home]);
  });

  after(() => {
    if (home === "") return;
    const without = { ...environment, HERDR_SOCKET_PATH: undefined } as NodeJS.ProcessEnv;
    spawnSync("herdr", ["session", "stop", session], { env: without, stdio: "ignore", timeout: 10_000 });
    spawnSync("herdr", ["session", "delete", session], { env: without, stdio: "ignore", timeout: 10_000 });
    server?.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  });

  test("a reviewer in a pane reports to the round, exits on its own, and its pane is closed", async (t) => {
    const tree = treeFor(t);
    const noteFile = join(tree, "note.json");
    const places: SessionPlace[] = [];

    const round = await runRound(
      adapterOf({ inPane: finishingInAPane(noteFile, 5_000), detached: "process.exit(3)" }, "pi"),
      invocationIn(tree),
      40,
      { environment, name: "squiz-142-r1", started: (place) => places.push(place) },
    );

    assert.equal(round.outcome, "reviewed", accountOf(round));
    assert.deepEqual(round.outcome === "reviewed" ? round.findings : [], [finding]);
    const [place] = places;
    assert.ok(place?.backend === "herdr", `the reviewer started in ${JSON.stringify(place)}`);
    assert.equal(place.identity.pid, noteIn(noteFile).pid, "the identity is not the reviewer's own");
    assert.match(herdr(["pane", "get", place.pane]), /pane_not_found/u, "the reviewer's pane is still open");
  });

  test("a reviewer in a pane that finishes at once is a review, not a start that failed", async (t) => {
    const tree = treeFor(t);
    const noteFile = join(tree, "note.json");
    const places: SessionPlace[] = [];

    const round = await runRound(
      adapterOf({ inPane: finishingInAPane(noteFile, 0), detached: "process.exit(3)" }, "pi"),
      invocationIn(tree),
      40,
      { environment, name: "squiz-142-r1", started: (place) => places.push(place) },
    );

    assert.equal(round.outcome, "reviewed", accountOf(round));
    assert.deepEqual(round.outcome === "reviewed" ? round.findings : [], [finding]);
    const [place] = places;
    assert.ok(place?.backend === "herdr", `the reviewer started in ${JSON.stringify(place)}`);
    assert.equal(place.identity.pid, noteIn(noteFile).pid, "the identity is not the reviewer's own");
    assert.match(herdr(["pane", "get", place.pane]), /pane_not_found/u, "the reviewer's pane is still open");
  });

  test("pi's own command line starts in a pane with a prompt of many lines, and the reviewer is handed it whole", async (t) => {
    const tree = treeFor(t);
    const argsFile = join(tree, "args.json");
    const standIn = join(tree, "stand-in.cjs");
    writeFileSync(
      standIn,
      [
        'const fs = require("node:fs");',
        `fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));`,
        "process.stdin.resume();",
        "setTimeout(() => {",
        `  fs.appendFileSync(process.env.${REPORTS_VARIABLE}, ${JSON.stringify(reviewLines)});`,
        "  setTimeout(() => process.exit(0), 300);",
        "}, 5000);",
      ].join("\n"),
      "utf8",
    );
    const adapter: Adapter = {
      ...pi,
      argv: (invocation) => {
        const line = pi.argv(invocation);
        return { ...line, environment: { ...line.environment, STAND_IN: standIn } };
      },
    };
    // Herdr refuses a newline or a tab anywhere in what it starts.
    const prompt = "# Review pull request #142\n\n\tIndented, with 'quotes', $1 and $@.\n";
    const places: SessionPlace[] = [];

    const round = await runRound(adapter, { ...invocationIn(tree), prompt }, 40, {
      // Only the stand-in is `pi` here, wherever the reviewer runs.
      environment: { ...environment, PATH: `${fakes}:${environment["PATH"] ?? ""}` },
      name: "squiz-142-r1",
      started: (place) => places.push(place),
    });

    assert.equal(round.outcome, "reviewed", accountOf(round));
    assert.deepEqual(round.outcome === "reviewed" ? round.findings : [], [finding]);
    assert.ok(places[0]?.backend === "herdr", `the reviewer started in ${JSON.stringify(places[0])}`);
    const handed = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
    const last = handed.at(-1) ?? "";
    assert.ok(last.startsWith("@"), `pi was handed its prompt as ${JSON.stringify(last)}, not as a file`);
    assert.equal(readFileSync(last.slice(1), "utf8"), prompt);
  });

  test("at the bound the round stops the pane's foreground group, and the pane is gone", async (t) => {
    const tree = treeFor(t);
    const noteFile = join(tree, "note.json");
    const places: SessionPlace[] = [];

    const round = await runRound(
      adapterOf({ inPane: deafInAPane(noteFile), detached: "process.exit(3)" }, "pi"),
      invocationIn(tree),
      12,
      { environment, name: "squiz-142-r1", started: (place) => places.push(place) },
    );

    assert.equal(round.outcome, "timed-out", accountOf(round));
    const note = noteIn(noteFile);
    const [place] = places;
    assert.ok(place?.backend === "herdr", `the reviewer started in ${JSON.stringify(place)}`);
    assert.equal(place.identity.pid, note.pid, "the group signalled is not the reviewer's");
    assert.ok(await eventually(() => !running(note.pid), 2_000), `the reviewer ${note.pid} is still running`);
    assert.ok(await eventually(() => !running(note.tool ?? 0), 2_000), `the reviewer's tool ${note.tool} is still running`);
    assert.match(herdr(["pane", "get", place.pane]), /pane_not_found/u, "the reviewer's pane is still open");
  });

  // The pane's close reaches the pane's shell session. A shell the reviewer
  // detached leads a session of its own, so only its recorded group reaches it.
  test("a start that fails and closes its pane still stops the groups the reviewer's shells recorded", async (t) => {
    const tree = treeFor(t);
    const made = makeRoundSpace(join(tree, ".squiz/142"));
    assert.ok(made.outcome === "made", "the round's own space must be there before the reviewer starts");
    const pidFile = join(tree, "pids");
    const readyFile = join(tree, "ready");
    const toolFile = join(tree, "tool.cjs");
    const tool = [
      "process.on('SIGTERM', () => {});",
      `require("node:fs").writeFileSync(${JSON.stringify(readyFile)}, "up");`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const shell = [shellPrefix, `'${process.execPath}' '${toolFile}' &`, `printf '%s' "$!" > '${pidFile}'`].join("\n");
    const reviewer = [
      'const fs = require("node:fs");',
      'const { spawn } = require("node:child_process");',
      `fs.writeFileSync(${JSON.stringify(toolFile)}, ${JSON.stringify(tool)});`,
      `spawn("/bin/bash", ["-c", ${JSON.stringify(shell)}], { stdio: "ignore", detached: true });`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const backends: Backends = {
      // As a start that launched the reviewer and then failed: Herdr closes the
      // pane it opened, and names none left open.
      herdr: (command, options) => {
        const started = startInHerdrPane(command, options);
        if (started.outcome !== "started") return started;
        const until = Date.now() + 10_000;
        while (!(existsSync(readyFile) && existsSync(pidFile)) && Date.now() < until) spawnSync("sleep", ["0.05"]);
        const closed = closeHerdrPane(started.pane, options);
        assert.equal(closed.outcome, "closed", JSON.stringify(closed));
        return { outcome: "failed", reason: "ps could not be run: a stand-in for ps failing" };
      },
      tmux: () => ({ outcome: "refused", reason: "not asked" }),
      child: async () => ({ outcome: "failed", reason: "a second reviewer was started" }),
    };

    const round = await runRound(
      adapterOf({ inPane: reviewer, detached: "process.exit(3)" }, "pi"),
      { ...invocationIn(tree), depth: "deep", roundSpace: made.outcome === "made" ? made.space : undefined },
      60,
      { environment, name: "squiz-142-r1", backends },
    );

    assert.equal(round.outcome, "setup", accountOf(round));
    assert.match(round.outcome === "setup" ? round.reason : "", /a stand-in for ps failing/u);
    const toolPid = Number(readFileSync(pidFile, "utf8"));
    const outlived = !(await eventually(() => !running(toolPid), 2_000));
    if (outlived) {
      // The tool and the keeper beside it share the detached shell's group.
      const group = spawnSync("ps", ["-o", "pgid=", "-p", String(toolPid)], { encoding: "utf8" }).stdout.trim();
      process.kill(-Number(group), "SIGKILL");
    }
    assert.ok(!outlived, `the detached tool ${toolPid} outlived the round`);
  });
});
