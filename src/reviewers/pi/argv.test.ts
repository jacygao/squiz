import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

import type { Depth, Thinking } from "../../config/config.ts";
import type { CommandLine, Invocation } from "../adapter.ts";
import { argv, extensionFile, grants } from "./argv.ts";
import { refusedTools } from "./refusals.ts";
import { REPORTS_VARIABLE } from "./report-file.ts";
import { reportingTools } from "./reporting.ts";

/**
 * An invocation whose paths and prompt spell no tool name, so the only place a
 * tool name can enter the command line is the grant.
 */
const invocation: Invocation = {
  directory: "/tmp/squiz/worktree",
  charterFile: "/tmp/squiz/plugin/charter.md",
  prompt: "Review pull request 142.",
  sessionDirectory: ".squiz/agent-7/session",
  reportsFile: "/tmp/squiz/worktree/.squiz/7/rounds/1/reports.jsonl",
  scratchDirectory: ".squiz/agent-7/scratch",
  depth: "read",
  thinking: "medium",
  roundSpace: undefined,
  terminal: "none",
};

const depths: readonly Depth[] = ["read", "deep"];

const levels: readonly Thinking[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function lineAt(depth: Depth): CommandLine {
  return argv({ ...invocation, depth });
}

/** The names `--tools` actually carries, read back off the command line. */
function toolsAt(depth: Depth): readonly string[] {
  const { args } = lineAt(depth);
  const flag = args.indexOf("--tools");
  assert.notEqual(
    flag,
    -1,
    `depth ${depth} must pass --tools, and without it pi grants its own default set of read, bash, edit and write`,
  );
  const granted = args[flag + 1];
  assert.ok(granted !== undefined, `--tools must be followed by the grant at depth ${depth}`);
  return granted.split(",");
}

/** The level `--thinking` actually carries, read back off the command line. */
function thinkingAt(depth: Depth, thinking: Thinking): string {
  const { args } = argv({ ...invocation, depth, thinking });
  const flag = args.indexOf("--thinking");
  assert.notEqual(
    flag,
    -1,
    `depth ${depth} must pass --thinking, and without it pi takes the level from its own settings file`,
  );
  assert.equal(
    args.lastIndexOf("--thinking"),
    flag,
    `depth ${depth} passes --thinking twice, and which of the two pi keeps is not a question worth having`,
  );
  const level = args[flag + 1];
  assert.ok(level !== undefined, `--thinking must be followed by the level at depth ${depth}`);
  return level;
}

test("the command line is the one the specification gives", () => {
  assert.deepEqual(argv(invocation), {
    command: "pi",
    directory: "/tmp/squiz/worktree",
    stdin: "/dev/null",
    environment: { SQUIZ_REPORTS: "/tmp/squiz/worktree/.squiz/7/rounds/1/reports.jsonl" },
    args: [
      "--print",
      "--session-dir",
      ".squiz/agent-7/session",
      "--no-approve",
      "--no-extensions",
      "--extension",
      extensionFile,
      "--tools",
      "read,grep,find,ls,report_finding,report_verdict,finish_review",
      "--thinking",
      "medium",
      "--append-system-prompt",
      "/tmp/squiz/plugin/charter.md",
      "Review pull request 142.",
    ],
  });
});

/**
 * With stdin inherited, `pi --print` blocks forever and emits nothing: no output,
 * no error and no exit. A reviewer with no terminal is the one that runs in print
 * mode, so it is the one whose stdin has to be `/dev/null`.
 */
test("a reviewer with no terminal runs in print mode, with stdin from /dev/null", () => {
  for (const depth of depths) {
    const line = argv({ ...invocation, depth, terminal: "none" });
    assert.ok(line.args.includes("--print"), `depth ${depth} with no terminal runs interactively`);
    assert.equal(line.stdin, "/dev/null", `depth ${depth} runs pi --print with stdin inherited`);
  }
});

// A pane line that kept print mode would run headless in the pane and look as
// if it worked, with nothing for a person to watch or type into.
test("a reviewer in a pane runs interactively, with the pane as its terminal", () => {
  for (const depth of depths) {
    const line = argv({ ...invocation, depth, terminal: "pane" });
    assert.ok(!line.args.includes("--print"), `depth ${depth} in a pane runs in print mode`);
    assert.ok(!line.args.includes("--mode"), `depth ${depth} in a pane sets an output mode`);
    assert.equal(line.stdin, "terminal", `depth ${depth} in a pane reads stdin from elsewhere`);
  }
});

test("the pane and the detached command lines differ in print mode and nothing else", () => {
  for (const depth of depths) {
    const detached = argv({ ...invocation, depth, terminal: "none" });
    const pane = argv({ ...invocation, depth, terminal: "pane" });
    assert.deepEqual(detached.args.slice(0, 1), ["--print"]);
    assert.deepEqual(pane.args, detached.args.slice(1), `depth ${depth} differs beyond the mode`);
    assert.equal(pane.command, detached.command);
    assert.equal(pane.directory, detached.directory);
    assert.deepEqual(pane.environment, detached.environment);
  }
});

/**
 * The reports reach the round through the file this names, in a pane and
 * detached alike. A line without it leaves the extension writing nothing and
 * answering every call as accepted.
 */
test("every command line names the report file the extension writes to", () => {
  for (const terminal of ["pane", "none"] as const) {
    for (const depth of depths) {
      const line = argv({ ...invocation, depth, terminal });
      assert.equal(line.environment[REPORTS_VARIABLE], invocation.reportsFile, `${terminal}, ${depth}`);
    }
  }
});

/** Nothing reads `pi`'s output any longer, so nothing asks it for the event stream. */
test("no command line asks pi for its event stream", () => {
  for (const terminal of ["pane", "none"] as const) {
    assert.ok(!argv({ ...invocation, terminal }).args.includes("--mode"), terminal);
  }
});

/**
 * `--no-session` keeps the session in memory, and then there is nothing to
 * resume. `--session-dir` is where it goes instead of the user's own history.
 */
test("the session is kept, in the directory handed over, wherever the reviewer runs", () => {
  for (const terminal of ["pane", "none"] as const) {
    for (const depth of depths) {
      const { args } = argv({ ...invocation, depth, terminal });
      assert.ok(!args.includes("--no-session"), `${terminal}, ${depth}: the session is not kept`);
      assert.equal(args[args.indexOf("--session-dir") + 1], invocation.sessionDirectory);
    }
  }
});

test("depth arrives as a parameter, and each value produces its own grant", () => {
  const reporting = [...reportingTools];
  assert.deepEqual(toolsAt("read"), ["read", "grep", "find", "ls", ...reporting]);
  assert.deepEqual(toolsAt("deep"), ["read", "grep", "find", "ls", ...reporting, "bash"]);
});

/**
 * The grant is the only thing that decides whether the reviewer can report at
 * all. `pi` drops a tool the grant does not name, with exit status 0 and an
 * empty stderr, so a grant short of a reporting call is a round that returns
 * nothing and says nothing about why.
 */
test("every reporting call is in the grant, at both depths", () => {
  for (const depth of depths) {
    for (const call of reportingTools) {
      assert.ok(
        toolsAt(depth).includes(call),
        `depth ${depth} withholds ${call}, so the reviewer has no way to report through it`,
      );
    }
  }
});

test("the reporting calls are loaded from a file that is there to load", () => {
  const { args } = lineAt("read");
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
test("no extension but the harness's own is loaded, at both depths", () => {
  for (const depth of depths) {
    assert.ok(lineAt(depth).args.includes("--no-extensions"), `depth ${depth} loads what it finds`);
  }
});

/**
 * `pi` merges a trusted project's own `.pi/settings.json` over the user's global
 * settings, and a trust decision saved against any directory above the worktree
 * trusts it. A tree under review that set `shellCommandPrefix` would replace the
 * line the round records its shell groups with, and no shell would record
 * anything: the round would report itself prepared with the mechanism absent.
 *
 * The same file could name the model the review runs on and the prompt the charter
 * is appended to, so what this withholds is not the prefix alone.
 */
test("the tree under review is not trusted to configure the reviewer, at either depth", () => {
  for (const depth of depths) {
    assert.ok(
      lineAt(depth).args.includes("--no-approve"),
      `depth ${depth} lets the tree under review set pi's own settings`,
    );
  }
});

// The level is the largest thing the harness decides about a round, and a
// command line missing it hands that decision to a file on the machine.
test("the level the harness set reaches the command line, at both depths", () => {
  for (const depth of depths) {
    for (const level of levels) {
      assert.equal(
        thinkingAt(depth, level),
        level,
        `depth ${depth} passed a level other than the ${level} it was given`,
      );
    }
  }
});

test("edit and write appear in no command line, at either depth", () => {
  for (const depth of depths) {
    const line = lineAt(depth);
    // The extension's path is the machine's rather than the harness's, and
    // whatever a checkout is called is not a tool name on the command line.
    const whole = [line.command, ...line.args.filter((arg) => arg !== extensionFile)].join(" ");
    for (const writer of ["edit", "write"]) {
      assert.ok(
        !toolsAt(depth).includes(writer),
        `depth ${depth} grants ${writer}, which lets the reviewer change the code it is reviewing`,
      );
      assert.ok(
        !whole.includes(writer),
        `depth ${depth} names ${writer} somewhere on its command line: ${whole}`,
      );
    }
  }
});

/**
 * Nothing is refused at `read`, and the grant is why: the shell is not there and
 * neither writer is. A round at `read` that refused nothing is the grant holding
 * rather than the handler having gone missing, and that reading only stands
 * while the grant carries none of them.
 */
test("the read grant carries nothing the refusal would have to catch", () => {
  for (const name of [...refusedTools, "bash"]) {
    assert.ok(
      !grants.read.includes(name),
      `depth read grants ${name}, so a round at read that refused nothing says nothing about the handler`,
    );
  }
});

test("adding the reporting calls did not add the writers pi grants by default", () => {
  for (const depth of depths) {
    assert.deepEqual(
      toolsAt(depth).filter((name) => ["edit", "write"].includes(name)),
      [],
      `depth ${depth} grants a writer, so the reviewer can change the code it is reviewing`,
    );
  }
});

test("the deep grant is the read grant and the shell, so no name is spelled twice", () => {
  assert.deepEqual(
    grants.deep,
    [...grants.read, "bash"],
    "a name spelled a second time is a name that can be misspelled, and pi drops an unrecognised name in silence",
  );
});

test("a grant names each tool once", () => {
  for (const depth of depths) {
    const granted = toolsAt(depth);
    assert.deepEqual(
      [...new Set(granted)],
      granted,
      `depth ${depth} repeats a tool name: ${granted.join(",")}`,
    );
  }
});

test("the grant table holds against a caller that would add to it", () => {
  assert.throws(() => (grants.read as string[]).push("write"));
  assert.throws(() => (grants.deep as string[]).push("edit"));
});

test("the prompt is one argument, and the last", () => {
  const { args } = argv({ ...invocation, prompt: "Review pull request 142.\n\nIts diff follows." });
  assert.equal(args.at(-1), "Review pull request 142.\n\nIts diff follows.");
});

test("the working directory is where pi runs rather than something on its command line", () => {
  const line = argv({ ...invocation, directory: "/tmp/squiz/other-worktree" });
  assert.equal(line.directory, "/tmp/squiz/other-worktree");
  assert.ok(!line.args.includes("/tmp/squiz/other-worktree"));
});
