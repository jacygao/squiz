import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { Depth } from "../../config/config.ts";
import type { Invocation } from "../adapter.ts";
import { pi } from "./adapter.ts";

const recordedRun = new URL("./recorded-run.jsonl", import.meta.url);

const invocation: Invocation = {
  directory: "/tmp/squiz/worktree",
  charterFile: "/tmp/squiz/plugin/charter.md",
  prompt: "Review pull request 142.",
  sessionDirectory: ".squiz/agent-7/session",
  scratchDirectory: ".squiz/agent-7/scratch",
  depth: "read",
};

/**
 * The three parts are one value, so that a second reviewer CLI is a second
 * value of this shape and no other change anywhere.
 */
test("the adapter carries a command line, a way to read output, and the grants", () => {
  assert.equal(pi.argv(invocation).command, "pi");
  assert.deepEqual(Object.keys(pi.grants).toSorted(), ["deep", "read"]);
  assert.equal(typeof pi.parse, "function");
});

test("the grant on the command line is the one the adapter names", () => {
  for (const depth of ["read", "deep"] as readonly Depth[]) {
    const { args } = pi.argv({ ...invocation, depth });
    assert.equal(args[args.indexOf("--tools") + 1], pi.grants[depth].join(","));
  }
});

test("the adapter reads a run of pi's own bytes back as what it cost and said", async () => {
  const run = await pi.parse(oneChunk(readFileSync(recordedRun, "utf8")));
  assert.equal(run.cost.messages, 2);
  assert.ok(run.cost.dollars > 0);
  assert.equal(run.result.kind, "unparsed");
});

async function* oneChunk(text: string): AsyncGenerator<string> {
  yield text;
}
