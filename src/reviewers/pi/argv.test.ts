import assert from "node:assert/strict";
import { test } from "node:test";

import type { Depth } from "../../config/config.ts";
import { argv, type CommandLine, grants, type Invocation } from "./argv.ts";

/**
 * An invocation whose paths and prompt spell no tool name, so the only place a
 * tool name can enter the command line is the grant.
 */
const invocation: Invocation = {
  directory: "/tmp/squiz/worktree",
  charterFile: "/tmp/squiz/plugin/charter.md",
  prompt: "Review pull request 142.",
  sessionDirectory: ".squiz/agent-7/session",
  depth: "read",
};

const depths: readonly Depth[] = ["read", "deep"];

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
      "--tools",
      "read,grep,find,ls",
      "--append-system-prompt",
      "/tmp/squiz/plugin/charter.md",
      "Review pull request 142.",
    ],
  });
});

test("depth arrives as a parameter, and each value produces its own grant", () => {
  assert.deepEqual(toolsAt("read"), ["read", "grep", "find", "ls"]);
  assert.deepEqual(toolsAt("deep"), ["read", "grep", "find", "ls", "bash"]);
});

test("edit and write appear in no command line, at either depth", () => {
  for (const depth of depths) {
    const line = lineAt(depth);
    const whole = [line.command, ...line.args].join(" ");
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
