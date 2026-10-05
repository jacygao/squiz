import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { follow } from "./follow.ts";

/** A directory of the test's own, removed when the test ends. */
function scratch(t: { after: (fn: () => void) => void }): string {
  const directory = mkdtempSync(join(tmpdir(), "squiz-follow-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** Everything the follower yields, as one string. */
async function textOf(chunks: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of chunks) text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((settle) => setTimeout(settle, milliseconds));
}

test("what is appended while the file is followed is read, in the order appended", async (t) => {
  const path = join(scratch(t), "reports.jsonl");
  writeFileSync(path, "");
  let end = (): void => {};
  const ended = new Promise<void>((settle) => {
    end = settle;
  });

  const read = textOf(follow(path, { ended, pollMs: 10 }));
  appendFileSync(path, "one\n");
  await pause(40);
  appendFileSync(path, "two\n");
  await pause(40);
  appendFileSync(path, "three");
  end();

  assert.equal(await read, "one\ntwo\nthree");
});

test("what was written just before the end is read, though no poll came between", async (t) => {
  const path = join(scratch(t), "reports.jsonl");
  writeFileSync(path, "");
  let end = (): void => {};
  const ended = new Promise<void>((settle) => {
    end = settle;
  });

  // A poll far longer than the test, so only the pass after the end can read it.
  const read = textOf(follow(path, { ended, pollMs: 60_000 }));
  await pause(20);
  appendFileSync(path, "the last line\n");
  end();

  assert.equal(await read, "the last line\n");
});

test("a file that never appears is read as nothing, and the follow still ends", async (t) => {
  const path = join(scratch(t), "never-written.jsonl");
  assert.equal(await textOf(follow(path, { ended: pause(30), pollMs: 10 })), "");
});

test("a follow that is abandoned ends without waiting for the end", async (t) => {
  const path = join(scratch(t), "reports.jsonl");
  writeFileSync(path, "read\n");
  const abandoned = new AbortController();
  const never = new Promise<void>(() => {});

  const read = textOf(follow(path, { ended: never, pollMs: 10, abandoned: abandoned.signal }));
  await pause(30);
  abandoned.abort();

  assert.equal(await read, "read\n");
});
