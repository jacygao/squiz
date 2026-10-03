import assert from "node:assert/strict";
import { test } from "node:test";

import { changedFiles, summarise, type Run } from "./summary.ts";

const diff = [
  "diff --git a/docs/notes/a.md b/docs/notes/a.md",
  "index 1..2 100644",
  "--- a/docs/notes/a.md",
  "+++ b/docs/notes/a.md",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "diff --git a/src/old name.ts b/src/new name.ts",
  "similarity index 90%",
  "rename from src/old name.ts",
  "rename to src/new name.ts",
  "",
].join("\n");

function call(toolName: string, args: unknown): string {
  return JSON.stringify({ type: "tool_execution_start", toolCallId: "c", toolName, args });
}

const run: Run = {
  label: "after-1",
  tree: "/runs/after-1/tree",
  seconds: 212.4,
  round: {
    outcome: "reviewed",
    cost: { dollars: 0.1834, tokens: 612_000, messages: 14 },
    findings: [
      {
        scope: "line",
        file: "docs/notes/a.md",
        line: 1,
        severity: "low",
        headline: "Says new where it means old",
        reasoning: ["One."],
        suggestedFix: "Say old.",
      },
      {
        scope: "change",
        severity: "medium",
        headline: "Duplicates the summary",
        reasoning: ["Two."],
        suggestedFix: "Reuse it.",
      },
    ],
  },
};

test("a renamed file counts under its new name", () => {
  assert.deepEqual(changedFiles(diff), ["docs/notes/a.md", "src/new name.ts"]);
});

test("a read or a grep of a changed file is inside the diff, and every other look is outside it", () => {
  const stream = [
    call("read", { path: "docs/notes/a.md" }),
    call("read", { path: "./src/new name.ts", offset: 10 }),
    call("grep", { pattern: "x", path: "/runs/after-1/tree/docs/notes/a.md" }),
    call("read", { path: "src/reviewers/groups.ts" }),
    call("grep", { pattern: "judge" }),
    call("ls", {}),
    call("find", { pattern: "*.md", path: "docs/notes/a.md" }),
    call("report_finding", { headline: "x" }),
    '{"type":"message_end","message":{"role":"assistant"}}',
    "not json",
    "",
  ].join("\n");
  const summary = summarise(run, stream, diff);
  assert.equal(summary.toolCalls, 8);
  assert.equal(summary.looks, 7);
  assert.deepEqual(summary.outside, [
    'read {"path":"src/reviewers/groups.ts"}',
    'grep {"pattern":"judge"}',
    "ls {}",
    'find {"pattern":"*.md","path":"docs/notes/a.md"}',
  ]);
});

test("the summary carries the cost, the time and each finding by its headline", () => {
  const summary = summarise(run, "", diff);
  assert.equal(summary.label, "after-1");
  assert.equal(summary.outcome, "reviewed");
  assert.equal(summary.messages, 14);
  assert.equal(summary.tokens, 612_000);
  assert.equal(summary.seconds, 212);
  assert.equal(summary.dollars, 0.18);
  assert.deepEqual(summary.findings, [
    "low docs/notes/a.md:1 Says new where it means old",
    "medium (change) Duplicates the summary",
  ]);
});
