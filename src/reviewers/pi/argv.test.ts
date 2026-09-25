import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

import type { Depth, Thinking } from "../../config/config.ts";
import type { CommandLine, Invocation } from "../adapter.ts";
import { argv, extensionFile, grants } from "./argv.ts";
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
  scratchDirectory: ".squiz/agent-7/scratch",
  depth: "read",
  thinking: "medium",
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
    args: [
      "--print",
      "--mode",
      "json",
      "--no-session",
      "--session-dir",
      ".squiz/agent-7/session",
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
