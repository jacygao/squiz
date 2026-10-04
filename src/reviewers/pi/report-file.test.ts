import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { reportFileAt } from "./report-file.ts";

const run = promisify(execFile);

/** A directory of the test's own, removed when the test ends. */
function scratch(t: { after: (fn: () => void) => void }): string {
  const directory = mkdtempSync(join(tmpdir(), "squiz-report-file-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function linesOf(path: string): unknown[] {
  const text = readFileSync(path, "utf8");
  assert.ok(text.endsWith("\n"), "the file does not end with a newline");
  return text.slice(0, -1).split("\n").map((line) => JSON.parse(line) as unknown);
}

test("each line recorded is one line of JSON, in the order recorded", (t) => {
  const path = join(scratch(t), "reports.jsonl");
  const file = reportFileAt(path);
  file.record({ type: "finish" });
  file.record({
    type: "refused",
    call: "report_finding",
    reason: "the finding\nspans two lines — and a dash",
    stopped: false,
  });
  file.record({ type: "finish" });

  assert.deepEqual(linesOf(path), [
    { type: "finish" },
    {
      type: "refused",
      call: "report_finding",
      reason: "the finding\nspans two lines — and a dash",
      stopped: false,
    },
    { type: "finish" },
  ]);
});

test("a file that cannot be written throws, rather than dropping the line", (t) => {
  const path = join(scratch(t), "no-such-directory", "reports.jsonl");
  assert.throws(() => reportFileAt(path).record({ type: "finish" }), /ENOENT/u);
});

test("no file named records nothing, and throws nothing", () => {
  reportFileAt(undefined).record({ type: "finish" });
  reportFileAt("").record({ type: "finish" });
});

/**
 * Several processes appending at once, each line large, is where a line written
 * in two pieces gets another writer's line between them.
 */
test("lines appended by several processes at once are never split", async (t) => {
  const path = join(scratch(t), "reports.jsonl");
  const module = fileURLToPath(new URL("./report-file.ts", import.meta.url));
  const writers = 6;
  const each = 300;
  const script = `
    const { reportFileAt } = await import(${JSON.stringify(module)});
    const file = reportFileAt(process.argv[1]);
    for (let n = 0; n < ${each}; n += 1) {
      file.record({ type: "refused", call: "bash", reason: "x".repeat(20000), stopped: true });
    }
  `;
  await Promise.all(
    Array.from({ length: writers }, () =>
      run(process.execPath, ["--input-type=module", "-e", script, path]),
    ),
  );
  assert.equal(linesOf(path).length, writers * each);
});
