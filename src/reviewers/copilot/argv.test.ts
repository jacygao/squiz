import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test, type TestContext } from "node:test";

import type { Thinking } from "../../config/config.ts";
import type { CommandLine, Invocation } from "../adapter.ts";
import { REPORTS_VARIABLE } from "../report-file.ts";
import { AGENT_NAME, argv, grants, serverFile } from "./argv.ts";
import { CHARTER_VARIABLE } from "./server.ts";

const invocation: Invocation = {
  directory: "/tmp/squiz/worktree",
  charterFile: "/tmp/squiz/plugin/charter.md",
  prompt: "Review pull request 142.",
  sessionDirectory: ".squiz/7/rounds/1/session",
  promptFile: "/tmp/squiz/worktree/.squiz/7/rounds/1/prompt.md",
  reportsFile: "/tmp/squiz/worktree/.squiz/7/rounds/1/reports.jsonl",
  scratchDirectory: ".squiz/7/scratch",
  githubConfigDirectory: ".squiz/7/rounds/1/gh",
  depth: "read",
  thinking: "medium",
  model: null,
  terminal: "none",
};

/** The flags the script passes Copilot, read back off it by splitting on spaces outside quotes. */
function scriptOf(line: CommandLine): string {
  assert.equal(line.command, "sh");
  assert.equal(line.args[0], "-c");
  const script = line.args[1];
  assert.ok(script !== undefined, "sh -c was given no script");
  return script;
}

function configOf(line: CommandLine): Record<string, unknown> {
  const config = line.args[2];
  assert.ok(config !== undefined, "the MCP configuration is not the script's $0");
  return JSON.parse(config) as Record<string, unknown>;
}

test("the grant at read is the three reading tools and the three reporting calls under the server's name", () => {
  assert.deepEqual(grants.read, [
    "view",
    "grep",
    "glob",
    "squiz-report_finding",
    "squiz-report_verdict",
    "squiz-finish_review",
  ]);
});

test("the grant at deep is the read grant and the three deep tools under the server's name", () => {
  assert.deepEqual(grants.deep, [
    ...grants.read,
    "squiz-git_log_search",
    "squiz-git_blame",
    "squiz-git_show",
  ]);
});

// Copilot hides every tool `--available-tools` leaves out, so a grant naming only
// these grants no shell, whatever Copilot calls its shell tools.
test("no grant names a tool other than the three reading tools and the server's own", () => {
  for (const [depth, granted] of Object.entries(grants)) {
    for (const tool of granted) {
      assert.ok(["view", "grep", "glob"].includes(tool) || tool.startsWith("squiz-"), `${depth} grants ${tool}`);
    }
  }
});

test("the line at deep carries the deep grant, and the same MCP configuration as at read", () => {
  const deep = argv({ ...invocation, depth: "deep" });
  assert.ok(scriptOf(deep).includes(` --available-tools=${grants.deep.join(",")} `), scriptOf(deep));
  assert.deepEqual(configOf(deep), configOf(argv(invocation)));
});

test("the script carries the grant, the agent, and every flag that keeps the tree and the user out", () => {
  const script = scriptOf(argv(invocation));
  assert.ok(script.includes(` --available-tools=${grants.read.join(",")} `), script);
  for (const flag of [
    `--agent ${AGENT_NAME}`,
    "--no-ask-user",
    "--allow-all-tools",
    "--no-custom-instructions",
    "--disable-builtin-mcps",
    '--additional-mcp-config "$0"',
  ]) {
    assert.ok(script.includes(` ${flag} `), `the script does not pass ${flag}: ${script}`);
  }
  // The charter reaches Copilot as the agent's instructions, and only there.
  assert.ok(!script.includes("--allow-all-mcp-server-instructions"), script);
  assert.ok(!script.includes("--model"), "with no model configured, the model is the user's, set through the environment");
});

// `--model` refuses a model Copilot does not offer, before any request.
// `COPILOT_MODEL` set to one runs the round on some other model, and exits 0.
test("a configured model is passed with --model, as the script's $1, and changes nothing else", () => {
  const unset = argv(invocation);
  const set = argv({ ...invocation, model: "gpt-5-mini" });
  assert.equal(set.args.length, 4, "the line is sh's -c, the script, the MCP configuration and the model");
  assert.equal(set.args[3], "gpt-5-mini");
  assert.equal(
    scriptOf(set),
    scriptOf(unset).replace(" --reasoning-effort ", ' --model "$1" --reasoning-effort '),
  );
  assert.deepEqual(set.args.slice(2, 3), unset.args.slice(2, 3));
  assert.deepEqual(set.environment, unset.environment);
});

// Copilot confines its reading tools to the working directory and the system's
// temporary directory, which for the reviewer is the round's scratch space,
// outside the snapshot.
test("the reading tools reach the snapshot and nothing else, at both depths", () => {
  for (const depth of ["read", "deep"] as const) {
    const script = scriptOf(argv({ ...invocation, depth }));
    assert.ok(script.includes(" --disallow-temp-dir "), `the ${depth} line leaves the temporary directory readable: ${script}`);
    for (const widens of ["--allow-all-paths", "--allow-all ", "--yolo", "--add-dir"]) {
      assert.ok(!script.includes(widens), `the ${depth} line passes ${widens}: ${script}`);
    }
  }
});

test("the script is one line, with no character a Herdr pane's shell would refuse", () => {
  for (const terminal of ["pane", "none"] as const) {
    const { args } = argv({ ...invocation, terminal });
    assert.equal(args.length, 3, "the line is sh's -c, the script and the MCP configuration");
    for (const argument of args) {
      assert.doesNotMatch(argument, /[\u0000-\u001f\u007f]/u, `a control character in ${JSON.stringify(argument)}`);
    }
  }
});

test("the reasoning effort is the thinking level, with off spelled none", () => {
  const levels: Readonly<Record<Thinking, string>> = {
    off: "none",
    minimal: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  };
  for (const [thinking, effort] of Object.entries(levels)) {
    const script = scriptOf(argv({ ...invocation, thinking: thinking as Thinking }));
    assert.ok(script.includes(` --reasoning-effort ${effort} `), `${thinking}: ${script}`);
  }
});

test("the MCP configuration starts the shipped server with this Node, reporting into the round's file and handed no charter", () => {
  const config = configOf(argv(invocation));
  assert.deepEqual(config, {
    mcpServers: {
      squiz: {
        type: "local",
        command: process.execPath,
        args: [serverFile],
        env: { [REPORTS_VARIABLE]: invocation.reportsFile },
        tools: ["*"],
      },
    },
  });
  assert.ok(isAbsolute(serverFile) && existsSync(serverFile), `no server at ${serverFile}`);
  assert.ok(!JSON.stringify(config).includes(CHARTER_VARIABLE));
});

test("a pane and no terminal run the same line, and only no terminal is handed /dev/null", () => {
  const pane = argv({ ...invocation, terminal: "pane" });
  const none = argv({ ...invocation, terminal: "none" });
  assert.deepEqual(pane.args, none.args);
  assert.equal(pane.stdin, "terminal");
  assert.equal(none.stdin, "/dev/null");
  assert.equal(none.directory, invocation.directory);
});

// Every character the shell or JSON could take for its own, and trailing newlines,
// which a command substitution drops unless the line keeps them.
const AWKWARD_PROMPT = [
  "# Review pull request #41",
  "",
  `He wrote "it's done" and 'it isn't'.`,
  "$HOME ${PATH} $(id) `uname` $0 $1 \\ \\n %s %%",
  "\ttabbed; exit 1 && echo no | cat",
  "ünïcödé",
  "",
  "",
].join("\n");

type Ran = { readonly status: number | null; readonly args: readonly string[] | undefined; readonly reports: string };

/** A tree whose path has a space and a quote in it, with a stand-in `copilot` first on the path. */
function standInTree(t: TestContext): { readonly tree: string; readonly bin: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "squiz-copilot-argv-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tree = join(root, "it's a tree");
  const bin = join(root, "bin");
  mkdirSync(join(tree, ".squiz/7/rounds/1/session"), { recursive: true });
  mkdirSync(bin);
  // Records its arguments, NUL-separated, writes a usage file of several lines
  // where it was given one, and ends as STAND_IN_END says.
  writeFileSync(
    join(bin, "copilot"),
    [
      "#!/bin/sh",
      'printf "%s\\0" "$@" > "$STAND_IN_ARGS"',
      'usage=""',
      'while [ $# -gt 0 ]; do [ "$1" = --usage-output-file ] && usage=$2; shift; done',
      '[ -n "$usage" ] && [ "$STAND_IN_USAGE" != none ] && printf \'{\\n  "totalNanoAiu": 5,\\n  "modelMetrics": {}\\n}\\n\' > "$usage"',
      'case $STAND_IN_END in',
      "  term) trap 'exit 0' TERM; : > \"$STAND_IN_ARGS.waiting\"; sleep 30 & wait; exit 0 ;;",
      '  *) exit "$STAND_IN_END" ;;',
      "esac",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(join(bin, "copilot"), 0o755);
  return { tree, bin };
}

function lineIn(tree: string, model: string | null = null): CommandLine {
  return argv({
    ...invocation,
    model,
    directory: tree,
    sessionDirectory: join(tree, ".squiz/7/rounds/1/session"),
    promptFile: join(tree, ".squiz/7/rounds/1/prompt.md"),
    reportsFile: join(tree, ".squiz/7/rounds/1/reports.jsonl"),
  });
}

function environmentFor(bin: string, tree: string, end: string, usage = "write"): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${bin}:${process.env["PATH"] ?? ""}`,
    STAND_IN_ARGS: join(tree, "args"),
    STAND_IN_END: end,
    STAND_IN_USAGE: usage,
  };
}

function ranIn(tree: string, status: number | null): Ran {
  const argsFile = join(tree, "args");
  const reportsFile = join(tree, ".squiz/7/rounds/1/reports.jsonl");
  return {
    status,
    args: existsSync(argsFile) ? readFileSync(argsFile, "utf8").split("\0").slice(0, -1) : undefined,
    reports: existsSync(reportsFile) ? readFileSync(reportsFile, "utf8") : "",
  };
}

/** Run the line as the round would, through the real `sh`, against the stand-in. */
function run(t: TestContext, end: string, options: { prompt?: string | null; usage?: string } = {}): Ran {
  const { tree, bin } = standInTree(t);
  const line = lineIn(tree);
  if (options.prompt !== null) writeFileSync(join(tree, ".squiz/7/rounds/1/prompt.md"), options.prompt ?? AWKWARD_PROMPT);
  writeFileSync(join(tree, ".squiz/7/rounds/1/reports.jsonl"), "");
  const result = spawnSync(line.command, line.args, {
    cwd: line.directory,
    env: environmentFor(bin, tree, end, options.usage),
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 10_000,
  });
  return ranIn(tree, result.status);
}

function after(args: readonly string[] | undefined, flag: string): string | undefined {
  assert.ok(args !== undefined, "copilot was never started");
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

test("the prompt reaches Copilot byte for byte as one argument, and the MCP configuration as $0", (t) => {
  const { tree, bin } = standInTree(t);
  const line = lineIn(tree);
  writeFileSync(join(tree, ".squiz/7/rounds/1/prompt.md"), AWKWARD_PROMPT);
  const result = spawnSync(line.command, line.args, {
    cwd: line.directory,
    env: environmentFor(bin, tree, "0"),
    stdio: "ignore",
    timeout: 10_000,
  });
  const ran = ranIn(tree, result.status);
  assert.equal(ran.status, 0);
  assert.equal(ran.args?.[0], "-p");
  assert.equal(ran.args?.[1], AWKWARD_PROMPT, "the prompt Copilot was handed is not the file's bytes");
  assert.equal(after(ran.args, "--additional-mcp-config"), line.args[2]);
  assert.equal(after(ran.args, "--usage-output-file"), join(tree, ".squiz/7/rounds/1/session/usage.json"));
});

// The script never reads the name, so a character the shell would act on reaches
// Copilot as itself.
test("a configured model reaches Copilot as one argument after --model, unread by the shell", (t) => {
  const { tree, bin } = standInTree(t);
  const model = "gpt-5-mini $(id) `uname`; exit 3 'x\"";
  const line = lineIn(tree, model);
  writeFileSync(join(tree, ".squiz/7/rounds/1/prompt.md"), AWKWARD_PROMPT);
  const result = spawnSync(line.command, line.args, {
    cwd: line.directory,
    env: environmentFor(bin, tree, "0"),
    stdio: "ignore",
    timeout: 10_000,
  });
  const ran = ranIn(tree, result.status);
  assert.equal(ran.status, 0);
  assert.equal(after(ran.args, "--model"), model);
  assert.equal(ran.args?.[1], AWKWARD_PROMPT);
  assert.equal(after(ran.args, "--additional-mcp-config"), line.args[2]);
});

test("Copilot is not started where the prompt file cannot be read", (t) => {
  const ran = run(t, "0", { prompt: null });
  assert.notEqual(ran.status, 0);
  assert.equal(ran.args, undefined, "Copilot ran with no prompt");
  assert.equal(ran.reports, "");
});

test("a Copilot that exits 0 has its usage appended as one line", (t) => {
  const ran = run(t, "0");
  assert.equal(ran.status, 0);
  assert.equal(ran.reports.split("\n").length, 2, `not one line: ${JSON.stringify(ran.reports)}`);
  assert.deepEqual(JSON.parse(ran.reports), { type: "usage", usage: { totalNanoAiu: 5, modelMetrics: {} } });
});

test("a Copilot that exits non-zero has nothing appended", (t) => {
  const ran = run(t, "1");
  assert.equal(ran.status, 1);
  assert.equal(ran.reports, "", "a run that failed recorded a usage line");
});

test("a Copilot that exits 0 and wrote no usage file has nothing appended", (t) => {
  const ran = run(t, "0", { usage: "none" });
  assert.ok(ran.args !== undefined, "copilot was never started");
  assert.equal(ran.reports, "", "a usage line was appended with no usage behind it");
});

// Copilot exits 0 on SIGTERM and writes its usage file as it goes. The signal
// reaches `sh` too, which does not trap it, so nothing is appended.
test("a Copilot stopped by SIGTERM to its group has nothing appended, though it exits 0", async (t) => {
  const { tree, bin } = standInTree(t);
  const line = lineIn(tree);
  writeFileSync(join(tree, ".squiz/7/rounds/1/prompt.md"), AWKWARD_PROMPT);
  writeFileSync(join(tree, ".squiz/7/rounds/1/reports.jsonl"), "");
  const child = spawn(line.command, line.args, {
    cwd: line.directory,
    env: environmentFor(bin, tree, "term"),
    stdio: "ignore",
    detached: true,
  });
  const exited = new Promise<void>((settle) => child.on("exit", () => settle()));
  const waiting = join(tree, "args.waiting");
  for (let tries = 0; tries < 200 && !existsSync(waiting); tries += 1) {
    await new Promise((settle) => setTimeout(settle, 25));
  }
  assert.ok(existsSync(waiting), "the stand-in never started");
  assert.ok(existsSync(join(tree, ".squiz/7/rounds/1/session/usage.json")), "the stand-in wrote no usage");
  process.kill(-(child.pid ?? 0), "SIGTERM");
  await exited;
  // Long enough for an append that was going to happen to have happened.
  await new Promise((settle) => setTimeout(settle, 300));
  assert.equal(ranIn(tree, null).reports, "", "a stopped run recorded a usage line");
});
