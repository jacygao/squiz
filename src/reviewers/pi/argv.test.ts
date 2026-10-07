import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

import type { Thinking } from "../../config/config.ts";
import type { CommandLine, Invocation } from "../adapter.ts";
import { REPORTS_VARIABLE } from "../report-file.ts";
import { reportingTools } from "../reporting.ts";
import { argv, extensionFile, grants } from "./argv.ts";
import { GRANT_VARIABLE, grantIn } from "./refusals.ts";

/**
 * An invocation whose paths and prompt spell no tool name, so the only place a
 * tool name can enter the command line is the grant.
 */
const invocation: Invocation = {
  directory: "/tmp/squiz/worktree",
  charterFile: "/tmp/squiz/plugin/charter.md",
  prompt: "Review pull request 142.",
  sessionDirectory: ".squiz/agent-7/session",
  promptFile: "/tmp/squiz/worktree/.squiz/7/rounds/1/prompt.md",
  reportsFile: "/tmp/squiz/worktree/.squiz/7/rounds/1/reports.jsonl",
  scratchDirectory: ".squiz/agent-7/scratch",
  githubConfigDirectory: ".squiz/agent-7/rounds/1/gh",
  thinking: "medium",
  model: null,
  terminal: "none",
};

const levels: readonly Thinking[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const terminals = ["pane", "none"] as const;

const grant = "read,grep,find,ls,report_finding,report_verdict,finish_review,git_log_search,git_blame,git_show";

function line(): CommandLine {
  return argv(invocation);
}

/** The names `--tools` actually carries, read back off the command line. */
function tools(): readonly string[] {
  const { args } = line();
  const flag = args.indexOf("--tools");
  assert.notEqual(
    flag,
    -1,
    "the line must pass --tools, and without it pi grants its own default set of read, bash, edit and write",
  );
  const granted = args[flag + 1];
  assert.ok(granted !== undefined, "--tools must be followed by the grant");
  return granted.split(",");
}

/** The level `--thinking` actually carries, read back off the command line. */
function thinkingAt(thinking: Thinking): string {
  const { args } = argv({ ...invocation, thinking });
  const flag = args.indexOf("--thinking");
  assert.notEqual(flag, -1, "the line must pass --thinking, and without it pi takes the level from its own settings file");
  assert.equal(
    args.lastIndexOf("--thinking"),
    flag,
    "the line passes --thinking twice, and which of the two pi keeps is not a question worth having",
  );
  const level = args[flag + 1];
  assert.ok(level !== undefined, "--thinking must be followed by the level");
  return level;
}

test("the command line is the one the specification gives", () => {
  assert.deepEqual(argv(invocation), {
    command: "pi",
    directory: "/tmp/squiz/worktree",
    stdin: "/dev/null",
    environment: {
      SQUIZ_REPORTS: "/tmp/squiz/worktree/.squiz/7/rounds/1/reports.jsonl",
      SQUIZ_GRANT: grant,
    },
    args: [
      "--print",
      "--session-dir",
      ".squiz/agent-7/session",
      "--no-approve",
      "--no-extensions",
      "--extension",
      extensionFile,
      "--tools",
      grant,
      "--thinking",
      "medium",
      "--append-system-prompt",
      "/tmp/squiz/plugin/charter.md",
      "@/tmp/squiz/worktree/.squiz/7/rounds/1/prompt.md",
    ],
  });
});

test("a configured model is passed with --model, and changes nothing else", () => {
  const unset = argv(invocation);
  const set = argv({ ...invocation, model: "openai/gpt-5-mini" });
  const flag = set.args.indexOf("--model");
  assert.notEqual(flag, -1, "the configured model is left off the line");
  assert.equal(set.args[flag + 1], "openai/gpt-5-mini");
  assert.equal(set.args.lastIndexOf("--model"), flag);
  assert.deepEqual([...set.args.slice(0, flag), ...set.args.slice(flag + 2)], unset.args);
  assert.deepEqual({ ...set, args: [] }, { ...unset, args: [] });
  assert.ok(!unset.args.includes("--model"), "--model is passed with none configured");
});

/**
 * With stdin inherited, `pi --print` blocks forever and emits nothing: no output,
 * no error and no exit. A reviewer with no terminal is the one that runs in print
 * mode, so it is the one whose stdin has to be `/dev/null`.
 */
test("a reviewer with no terminal runs in print mode, with stdin from /dev/null", () => {
  const detached = argv({ ...invocation, terminal: "none" });
  assert.ok(detached.args.includes("--print"), "a reviewer with no terminal runs interactively");
  assert.equal(detached.stdin, "/dev/null", "pi --print runs with stdin inherited");
});

// A pane line that kept print mode would run headless in the pane and look as
// if it worked, with nothing for a person to watch or type into.
test("a reviewer in a pane runs interactively, with the pane as its terminal", () => {
  const pane = argv({ ...invocation, terminal: "pane" });
  assert.ok(!pane.args.includes("--print"), "a reviewer in a pane runs in print mode");
  assert.ok(!pane.args.includes("--mode"), "a reviewer in a pane sets an output mode");
  assert.equal(pane.stdin, "terminal", "a reviewer in a pane reads stdin from elsewhere");
});

test("the pane and the detached command lines differ in print mode and nothing else", () => {
  const detached = argv({ ...invocation, terminal: "none" });
  const pane = argv({ ...invocation, terminal: "pane" });
  assert.deepEqual(detached.args.slice(0, 1), ["--print"]);
  assert.deepEqual(pane.args, detached.args.slice(1));
  assert.equal(pane.command, detached.command);
  assert.equal(pane.directory, detached.directory);
  assert.deepEqual(pane.environment, detached.environment);
});

/**
 * The reports reach the round through the file this names, in a pane and
 * detached alike. A line without it leaves the extension writing nothing and
 * answering every call as accepted.
 */
test("every command line names the report file the extension writes to", () => {
  for (const terminal of terminals) {
    const each = argv({ ...invocation, terminal });
    assert.equal(each.environment[REPORTS_VARIABLE], invocation.reportsFile, terminal);
  }
});

/** Nothing reads `pi`'s output any longer, so nothing asks it for the event stream. */
test("no command line asks pi for its event stream", () => {
  for (const terminal of terminals) {
    assert.ok(!argv({ ...invocation, terminal }).args.includes("--mode"), terminal);
  }
});

/**
 * `--no-session` keeps the session in memory, and then there is nothing to
 * resume. `--session-dir` is where it goes instead of the user's own history.
 */
test("the session is kept, in the directory handed over, wherever the reviewer runs", () => {
  for (const terminal of terminals) {
    const { args } = argv({ ...invocation, terminal });
    assert.ok(!args.includes("--no-session"), `${terminal}: the session is not kept`);
    assert.equal(args[args.indexOf("--session-dir") + 1], invocation.sessionDirectory);
  }
});

test("the grant is the reading tools, the reporting calls and the history tools", () => {
  assert.deepEqual(tools(), [
    "read",
    "grep",
    "find",
    "ls",
    ...reportingTools,
    "git_log_search",
    "git_blame",
    "git_show",
  ]);
});

// `grants` is what a round says it allowed, and `--tools` is what pi allowed.
test("the grant and --tools name the same tools", () => {
  assert.deepEqual(tools(), grants, "the adapter grants one thing and says another");
});

// The extension refuses whatever the variable leaves out, so a variable that
// differed from --tools would refuse a granted tool or allow an ungranted one.
test("the extension is handed the grant --tools carries, on every backend", () => {
  for (const terminal of terminals) {
    const each = argv({ ...invocation, terminal });
    assert.deepEqual(grantIn(each.environment[GRANT_VARIABLE]), tools(), terminal);
  }
});

test("the grant carries no shell", () => {
  assert.ok(!tools().includes("bash"), "bash is passed on --tools");
  assert.ok(!grants.includes("bash"), "bash is listed in the grant");
});

/**
 * The grant is the only thing that decides whether the reviewer can report at
 * all. `pi` drops a tool the grant does not name, with exit status 0 and an
 * empty stderr, so a grant short of a reporting call is a round that returns
 * nothing and says nothing about why.
 */
test("every reporting call is in the grant", () => {
  for (const call of reportingTools) {
    assert.ok(tools().includes(call), `the grant withholds ${call}, so the reviewer has no way to report through it`);
  }
});

test("the reporting calls are loaded from a file that is there to load", () => {
  const { args } = line();
  assert.equal(args[args.indexOf("--extension") + 1], extensionFile);
  assert.ok(
    existsSync(extensionFile),
    `pi is pointed at ${extensionFile}, and a path with nothing at it leaves the reviewer no way to report`,
  );
});

/**
 * Only the harness's own extension loads. Whatever is installed on the machine
 * or sits in the tree under review could otherwise register a tool of a
 * reporting call's name and take the round's findings.
 */
test("no extension but the harness's own is loaded", () => {
  assert.ok(line().args.includes("--no-extensions"), "pi loads whatever extensions it finds");
});

/**
 * `pi` merges a trusted project's own `.pi/settings.json` over the user's global
 * settings, and a trust decision saved against any directory above the worktree
 * trusts it. That file could name the model the review runs on and the prompt
 * the charter is appended to.
 */
test("the tree under review is not trusted to configure the reviewer", () => {
  assert.ok(line().args.includes("--no-approve"), "the tree under review can set pi's own settings");
});

// The level is the largest thing the harness decides about a round, and a
// command line missing it hands that decision to a file on the machine.
test("the level the harness set reaches the command line", () => {
  for (const level of levels) {
    assert.equal(thinkingAt(level), level, `a level other than the ${level} given was passed`);
  }
});

test("edit and write appear nowhere on the command line", () => {
  const { command, args } = line();
  // The extension's path is the machine's rather than the harness's, and
  // whatever a checkout is called is not a tool name on the command line.
  const whole = [command, ...args.filter((arg) => arg !== extensionFile)].join(" ");
  for (const writer of ["edit", "write"]) {
    assert.ok(!tools().includes(writer), `the grant has ${writer}, which lets the reviewer change the code it is reviewing`);
    assert.ok(!whole.includes(writer), `${writer} is named somewhere on the command line: ${whole}`);
  }
});

/**
 * A round that refused nothing is the grant holding rather than the handler
 * having gone missing, and that reading only stands while the grant carries
 * none of the tools the refusal would catch.
 */
test("the grant carries nothing the refusal would have to catch", () => {
  for (const name of ["edit", "write", "bash"]) {
    assert.ok(
      !grants.includes(name),
      `the grant has ${name}, so a round that refused nothing says nothing about the handler`,
    );
  }
});

test("the grant names each tool once", () => {
  const granted = tools();
  assert.deepEqual([...new Set(granted)], granted, `a tool name is repeated: ${granted.join(",")}`);
});

test("the grant holds against a caller that would add to it", () => {
  assert.throws(() => (grants as string[]).push("write"));
});

// Herdr refuses to start a command with a newline or a tab in any argument.
test("the prompt reaches pi as its file, and no argument carries a newline or a tab", () => {
  for (const terminal of ["pane", "none"] as const) {
    const { args } = argv({ ...invocation, terminal, prompt: "Review pull request 142.\n\n\tIts diff follows." });
    assert.equal(args.at(-1), "@/tmp/squiz/worktree/.squiz/7/rounds/1/prompt.md");
    for (const arg of args) assert.doesNotMatch(arg, /[\n\t]/u, `pi is handed ${JSON.stringify(arg)}`);
  }
});

test("the working directory is where pi runs rather than something on its command line", () => {
  const line = argv({ ...invocation, directory: "/tmp/squiz/other-worktree" });
  assert.equal(line.directory, "/tmp/squiz/other-worktree");
  assert.ok(!line.args.includes("/tmp/squiz/other-worktree"));
});
