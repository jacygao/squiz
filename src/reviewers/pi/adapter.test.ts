import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Depth } from "../../config/config.ts";
import type { Invocation } from "../adapter.ts";
import { pi } from "./adapter.ts";

const invocation: Invocation = {
  directory: "/tmp/squiz/worktree",
  charterFile: "/tmp/squiz/plugin/charter.md",
  prompt: "Review pull request 142.",
  sessionDirectory: ".squiz/agent-7/session",
  promptFile: ".squiz/7/rounds/1/prompt.md",
  reportsFile: ".squiz/7/rounds/1/reports.jsonl",
  scratchDirectory: ".squiz/agent-7/scratch",
  githubConfigDirectory: ".squiz/agent-7/rounds/1/gh",
  depth: "read",
  thinking: "medium",
  model: null,
  terminal: "none",
};

/**
 * The four parts are one value, so that a second reviewer CLI is a second
 * value of this shape and no other change anywhere.
 */
test("the adapter carries a command line, what it confines with, a reader and the grants", () => {
  assert.equal(pi.argv(invocation).command, "pi");
  assert.deepEqual(Object.keys(pi.grants).toSorted(), ["deep", "read"]);
  assert.equal(typeof pi.parse, "function");
  assert.deepEqual(pi.confine(invocation), { outcome: "prepared", environment: {} });
});

test("the adapter checks a configured model before pi starts", () => {
  // No pi lists this, and a pi that is missing or cannot list fails it too.
  const unlisted = pi.confine({ ...invocation, model: "no-provider-lists-this/model" });
  assert.equal(unlisted.outcome, "failed", JSON.stringify(unlisted));
});

test("the grant on the command line is the one the adapter names", () => {
  for (const depth of ["read", "deep"] as readonly Depth[]) {
    const { args } = pi.argv({ ...invocation, depth });
    assert.equal(args[args.indexOf("--tools") + 1], pi.grants[depth].join(","));
  }
});

test("the adapter reads the report file, not pi's output", async () => {
  const usage = {
    type: "usage",
    stopReason: "stop",
    usage: { totalTokens: 100, cost: { total: 0.001 } },
  };
  const run = await pi.parse(oneChunk(`${JSON.stringify(usage)}\n{"type":"finish"}\n`));
  assert.deepEqual(run.result, { kind: "reviewed", findings: [], verdicts: [] });
  assert.equal(run.cost?.tokens, 100);
});

test("the adapter resumes the session the reviewer kept, under the directory's name it is given", () => {
  const directory = mkdtempSync(join(tmpdir(), "squiz-pi-resume-"));
  try {
    const header = { type: "session", version: 3, id: "0193f2c4", timestamp: "2026-10-04T10:50:44.689Z", cwd: "/tmp" };
    writeFileSync(join(directory, "kept.jsonl"), `${JSON.stringify(header)}\n`);
    assert.deepEqual(pi.resume?.(directory, ".squiz/41/rounds/2/session"), [
      "pi",
      "--session-dir",
      ".squiz/41/rounds/2/session",
      "--session",
      "0193f2c4",
    ]);
    assert.equal(pi.resume?.(join(directory, "never-made"), "never-made"), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function* oneChunk(text: string): AsyncGenerator<string> {
  yield text;
}
