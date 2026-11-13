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
  githubConfigDirectory: ".squiz/7/rounds/1/gh",
  thinking: "medium",
  model: null,
  terminal: "none",
};

test("the adapter carries a command line, what it confines with, a reader, the grant and a resume", () => {
  assert.equal(copilot.argv(invocation).command, "sh");
  assert.ok(copilot.grants.length > 0);
  assert.equal(typeof copilot.parse, "function");
  assert.equal(typeof copilot.resume, "function");
});

test("the grant on the command line is the one the adapter names", () => {
  const script = copilot.argv(invocation).args[1] ?? "";
  assert.ok(script.includes(` --available-tools=${copilot.grants.join(",")} `), script);
});

test("the adapter reads the report file the reporting server writes", async () => {
  async function* file(): AsyncGenerator<string> {
    yield '{"type":"finish"}\n';
  }
  assert.deepEqual((await copilot.parse(file())).result, { kind: "reviewed", findings: [], verdicts: [], read: [] });
});

/**
 * What Copilot CLI 1.0.109 printed on stderr, and exited 1 with, when it found
 * no login. A Copilot that changes it stops matching, and the round falls back
 * to the generic reason with these words in it.
 */
const SIGNED_OUT = [
  "Error: No authentication information found.",
  "",
  "Copilot can be authenticated with GitHub using an OAuth Token or a Fine-Grained Personal Access Token.",
  "",
  "To authenticate, you can use any of the following methods:",
  "  • Start 'copilot' and run the '/login' command",
  "  • Set the COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN environment variable",
  "  • Run 'gh auth login' to authenticate with the GitHub CLI",
].join("\n");

test("a run that says it found no login is diagnosed as not signed in (#849)", () => {
  assert.equal(
    copilot.diagnose?.(SIGNED_OUT),
    'the reviewer is not signed in to Copilot: it said "Error: No authentication information found."',
  );
});

test("a run that said anything else is left undiagnosed", () => {
  assert.equal(copilot.diagnose?.(""), undefined);
  assert.equal(
    copilot.diagnose?.("Error: Authentication token found but could not be validated.\n\n  Failed to fetch PAT user login (401): GitHub returned: Bad credentials"),
    undefined,
    "a token GitHub refused may be the network, so it is not called a sign-out",
  );
  assert.equal(copilot.diagnose?.('Error: Model "gpt-0" is not available.'), undefined);
});
