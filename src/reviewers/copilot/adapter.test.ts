import assert from "node:assert/strict";
import { test } from "node:test";

import type { Invocation } from "../adapter.ts";
import { copilot } from "./adapter.ts";

const invocation: Invocation = {
  directory: "/tmp/squiz/worktree",
  charterFile: "/tmp/squiz/plugin/charter.md",
  prompt: "Review pull request 142.",
  sessionDirectory: ".squiz/7/rounds/1/session",
  promptFile: ".squiz/7/rounds/1/prompt.md",
  reportsFile: ".squiz/7/rounds/1/reports.jsonl",
  scratchDirectory: ".squiz/7/scratch",
  depth: "read",
  thinking: "medium",
  roundSpace: undefined,
  terminal: "none",
};

test("the adapter carries a command line, what it confines with, a reader, the grants and a resume", () => {
  assert.equal(copilot.argv(invocation).command, "sh");
  assert.deepEqual(Object.keys(copilot.grants).toSorted(), ["deep", "read"]);
  assert.equal(typeof copilot.parse, "function");
  assert.equal(typeof copilot.resume, "function");
});

test("the grant on the command line is the one the adapter names", () => {
  const script = copilot.argv(invocation).args[1] ?? "";
  assert.ok(script.includes(` --available-tools=${copilot.grants.read.join(",")} `), script);
});

test("the adapter reads the report file the reporting server writes", async () => {
  async function* file(): AsyncGenerator<string> {
    yield '{"type":"finish"}\n';
  }
  assert.deepEqual((await copilot.parse(file())).result, { kind: "reviewed", findings: [], verdicts: [] });
});
