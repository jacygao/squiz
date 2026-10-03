import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { endedInHandback } from "./handback.ts";

function entry(type: string, content: unknown): string {
  return JSON.stringify({ type, message: { role: type, content } });
}

function handback(report: string): string {
  return entry("assistant", [
    { type: "tool_use", id: "toolu_2", name: "SubagentHandback", input: { message: report } },
  ]);
}

async function endedInHandbackFor(lines: readonly string[]): Promise<boolean> {
  const directory = await mkdtemp(join(tmpdir(), "squiz-handback-"));
  try {
    const path = join(directory, "agent.jsonl");
    await writeFile(path, `${lines.join("\n")}\n`, "utf8");
    return endedInHandback(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const RESULT = entry("user", [{ type: "tool_result", tool_use_id: "toolu_2", content: "delivered" }]);

test("a hand-back larger than any tail read at once is still found", async () => {
  const report = "x".repeat(3 * 1024 * 1024);
  assert.equal(await endedInHandbackFor([entry("user", "go"), handback(report), RESULT]), true);
});
