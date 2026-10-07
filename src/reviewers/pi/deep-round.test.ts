/**
 * A round at `deep` whose reviewer calls each `deep` tool once, driven over a
 * real git repository with a stand-in for `pi`.
 *
 * **The stand-in loads the extension the way `pi` loads it**, from the path on
 * the command line through the same default export, and registers only what
 * `--tools` grants, as `pi` filters it. So a tool reaches the reviewer only
 * where the command line and the extension both carry it, and it runs with the
 * environment the round gave the reviewer. What each call answered is written
 * to the scratch space, where the test reads it back.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { standIn } from "../../testing/stand-in.ts";
import type { Invocation } from "../adapter.ts";
import { deepToolNames } from "../deep-tools.ts";
import { type Round, runRound } from "../round.ts";
import { STOP_MARGIN_MS } from "../run-tests.ts";
import { pi } from "./adapter.ts";

const charterFile = fileURLToPath(new URL("../../../charter.md", import.meta.url));
/** The scratch space, absolute and outside the snapshot, where the round host puts it. */
const scratchIn = (tree: string): string => join(tree, "..", "worktree", ".squiz", "1", "scratch");

/** What one call answered: its text, and whether `pi` would read it as an error. */
type Answered = { readonly text: string; readonly failed: boolean };

test("a round at deep calls each deep tool once and gets its result back", async () => {
  await inTheFixture(async (tree) => {
    const round = await runRound(pi, invocationIn(tree, 'echo "the suite ran in $PWD"'), 60);
    assert.equal(round.outcome, "reviewed", accountOf(round));

    const answered = answeredIn(tree);
    assert.deepEqual(Object.keys(answered), [...deepToolNames]);
    for (const [name, answer] of Object.entries(answered)) {
      assert.ok(!answer.failed, `${name} failed: ${answer.text}`);
    }
    assert.match(answered["run_tests"]?.text ?? "", /^The test command exited 0\./u);
    assert.ok(answered["run_tests"]?.text.includes(`the suite ran in ${realpathSync(tree)}`));
    assert.match(answered["git_log_search"]?.text ?? "", /Add lastSaid/u);
    assert.match(answered["git_blame"]?.text ?? "", /comments\[comments\.length\]/u);
    assert.match(answered["git_show"]?.text ?? "", /^commit [0-9a-f]{40}/u);
  });
});

// The round's deadline reaches run_tests through the round, so a suite that
// would outlast the round is stopped and the reviewer still finishes in time.
test("run_tests in a round is stopped before the round's own bound", async () => {
  await inTheFixture(async (tree) => {
    const seconds = Math.ceil(STOP_MARGIN_MS / 1_000) + 4;
    const started = Date.now();
    const round = await runRound(pi, invocationIn(tree, "sleep 120"), seconds);
    const took = Date.now() - started;
    assert.equal(round.outcome, "reviewed", accountOf(round));
    assert.ok(took < seconds * 1_000, `the round took ${took} ms of its ${seconds} seconds`);
    assert.match(
      answeredIn(tree)["run_tests"]?.text ?? "",
      /was stopped after \d+ seconds, because the round's time ran out/u,
    );
  });
});

function invocationIn(tree: string, command: string): Invocation {
  return {
    directory: tree,
    charterFile,
    prompt: "# Review pull request #1\n\nCall each deep tool once.",
    sessionDirectory: ".squiz/agent-1/session",
    promptFile: ".squiz/1/rounds/1/prompt.md",
    reportsFile: ".squiz/1/rounds/1/reports.jsonl",
    scratchDirectory: scratchIn(tree),
    githubConfigDirectory: ".squiz/1/rounds/1/gh",
    depth: "deep",
    test: command,
    thinking: "medium",
    model: null,
    roundSpace: undefined,
    terminal: "none",
  };
}

function answeredIn(tree: string): Readonly<Record<string, Answered>> {
  return JSON.parse(readFileSync(join(scratchIn(tree), "answered.json"), "utf8")) as Record<
    string,
    Answered
  >;
}

function accountOf(round: Round): string {
  return `the round came back as ${JSON.stringify(round)}`;
}

/** A git repository with two commits, the second adding a line to blame, and the stand-in on `PATH` as `pi`. */
async function inTheFixture(run: (tree: string) => Promise<void>): Promise<void> {
  const under = mkdtempSync(join(tmpdir(), "squiz-deep-round-"));
  const tree = join(under, "tree");
  const wasOnPath = process.env["PATH"] ?? "";
  try {
    mkdirSync(join(tree, "src"), { recursive: true });
    writeFileSync(join(tree, ".gitignore"), ".squiz/\n");
    writeFileSync(join(tree, "src/threads.ts"), "export const nothing = 0;\n");
    git(["init", "--quiet"], tree);
    git(["add", "--all"], tree);
    git(["commit", "--quiet", "--message", "Read a thread's comments"], tree);
    writeFileSync(
      join(tree, "src/threads.ts"),
      "export function lastSaid(comments: readonly string[]): string | undefined {\n  return comments[comments.length];\n}\n",
    );
    git(["add", "--all"], tree);
    git(["commit", "--quiet", "--message", "Add lastSaid"], tree);

    const bin = join(under, "bin");
    mkdirSync(bin);
    standIn(bin, "pi", reviewer, "node");
    process.env["PATH"] = `${bin}${delimiter}${wasOnPath}`;
    await run(tree);
  } finally {
    process.env["PATH"] = wasOnPath;
    rmSync(under, { recursive: true, force: true });
  }
}

function git(args: readonly string[], tree: string): string {
  return execFileSync(
    "git",
    [
      "-c",
      "init.defaultBranch=main",
      "-c",
      "init.templateDir=",
      "-c",
      "user.name=squiz fixture",
      "-c",
      "user.email=fixture@squiz.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      cwd: tree,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    },
  );
}

/**
 * The stand-in for `pi`: it loads the extension, keeps the tools `--tools`
 * grants, calls each deep tool once, and writes what each answered to the
 * scratch space. A call that throws is an error, as `pi` reads one.
 *
 * Plain CommonJS, because it is written to a file and run by a fresh process
 * rather than type-stripped and imported.
 */
const reviewer = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const after = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const give = (said) => {
  process.stderr.write("pi stand-in: " + said + "\\n");
  process.exit(1);
};

const calls = {
  run_tests: {},
  git_log_search: { term: "comments.length" },
  git_blame: { file: "src/threads.ts", line: 2 },
  git_show: { commit: "HEAD" },
};

async function review() {
  const granted = (after("--tools") || "").split(",");
  if (granted.includes("bash")) give("the grant carries a shell");
  const tools = new Map();
  const ended = [];
  const loaded = await import(after("--extension"));
  loaded.default({
    registerTool: (tool) => {
      if (granted.includes(tool.name)) tools.set(tool.name, tool);
    },
    on: (event, handler) => {
      if (event === "message_end") ended.push(handler);
    },
  });

  const answered = {};
  for (const [name, params] of Object.entries(calls)) {
    const tool = tools.get(name);
    if (tool === undefined) give(name + " is not both registered and granted");
    try {
      const answer = await tool.execute(name, params);
      answered[name] = { text: answer.content[0].text, failed: false };
    } catch (cause) {
      answered[name] = { text: cause instanceof Error ? cause.message : String(cause), failed: true };
    }
  }
  fs.writeFileSync(path.join(process.env.TMPDIR, "answered.json"), JSON.stringify(answered));

  const message = {
    type: "message_end",
    message: {
      role: "assistant",
      model: "stand-in",
      stopReason: "stop",
      content: [{ type: "text", text: "reviewed" }],
      usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 1200, cost: { total: 0.001 } },
    },
  };
  for (const handler of ended) handler(message);
  await tools.get("finish_review").execute("finish", {});
  for (const handler of ended) handler(message);
}

review().catch((cause) => give(cause instanceof Error ? cause.message : String(cause)));
`;
