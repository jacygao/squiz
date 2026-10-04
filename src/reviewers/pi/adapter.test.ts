import assert from "node:assert/strict";
import { test } from "node:test";

import type { Depth } from "../../config/config.ts";
import type { Invocation } from "../adapter.ts";
import { pi } from "./adapter.ts";

const invocation: Invocation = {
  directory: "/tmp/squiz/worktree",
  charterFile: "/tmp/squiz/plugin/charter.md",
  prompt: "Review pull request 142.",
  sessionDirectory: ".squiz/agent-7/session",
  reportsFile: ".squiz/7/rounds/1/reports.jsonl",
  scratchDirectory: ".squiz/agent-7/scratch",
  depth: "read",
  thinking: "medium",
  roundSpace: undefined,
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
  assert.equal(run.cost.tokens, 100);
});

async function* oneChunk(text: string): AsyncGenerator<string> {
  yield text;
}
