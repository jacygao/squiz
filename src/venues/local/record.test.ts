import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import { deadlineIn } from "../../reviewers/deadline.ts";
import { addReply, listThreads, openThread, setResolved, writeFailure, writeSummary } from "./record.ts";

// Far longer than any wait these tests make, so no load on the machine reaches it.
const LONG_MS = 120_000;

const racerFile = join(import.meta.dirname, "..", "..", "testing", "threads-racer.ts");
const lockFile = pathToFileURL(join(import.meta.dirname, "..", "..", "sessions", "lock-file.ts")).href;

const reviewer = "**Squiz reviewer · high — Retry backoff resets on every enqueue**\n\n- …";
const agent = "**Squiz coding agent**\n\nThe backoff now resets only when the queue was empty.";

/** A worktree's directory of its own, removed when the test ends. */
function directoryIn(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "squiz-local-record-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function soon() {
  return { until: deadlineIn(LONG_MS) };
}

function fileIn(directory: string): unknown {
  return JSON.parse(readFileSync(join(directory, "threads.json"), "utf8"));
}

/** The ids of every thread and every comment in the file, in the order the file holds them. */
function idsIn(directory: string): { readonly threads: string[]; readonly comments: string[] } {
  const listed = listThreads(directory);
  assert.equal(listed.outcome, "listed", JSON.stringify(listed));
  const threads = listed.outcome === "listed" ? listed.threads : [];
  return {
    threads: threads.map((thread) => thread.id),
    comments: threads.flatMap((thread) => thread.comments.map((comment) => comment.id)),
  };
}

/** Run one racer to its end, and return what it printed: how many of its writes failed. */
function racer(directory: string, mode: string, label: string, count: number, at: number): Promise<string> {
  const child = spawn(process.execPath, [racerFile, directory, mode, label, String(count), String(at)], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  let printed = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (printed += chunk));
  return new Promise((resolve) => child.once("exit", (code) => resolve(`exit ${code}, failed ${printed.trim()}`)));
}

function exited(child: ChildProcess): Promise<NodeJS.Signals | null> {
  return new Promise((resolve) => child.once("exit", (_code, signal) => resolve(signal)));
}

test("threads.json holds each thread with its anchor, its comments and where it stands, as § 4 shows", (t) => {
  const directory = directoryIn(t);

  const opened = openThread(directory, "packages/sync/src/queue.ts", { at: "line", line: 134 }, reviewer, soon());
  const fileThread = openThread(directory, "README.md", { at: "file" }, reviewer, soon());
  const replied = addReply(directory, "T1", agent, soon());

  assert.equal(opened.outcome, "opened", JSON.stringify(opened));
  assert.deepEqual(opened.outcome === "opened" ? [opened.threadId, opened.commentId] : [], ["T1", "C1"]);
  assert.deepEqual(fileThread.outcome === "opened" ? [fileThread.threadId, fileThread.commentId] : fileThread, ["T2", "C2"]);
  assert.deepEqual(replied, { outcome: "acted" });
  assert.deepEqual(fileIn(directory), {
    threads: [
      {
        id: "T1",
        path: "packages/sync/src/queue.ts",
        anchor: { at: "line", line: 134 },
        isResolved: false,
        comments: [
          { id: "C1", body: reviewer },
          { id: "C3", body: agent },
        ],
      },
      { id: "T2", path: "README.md", anchor: { at: "file" }, isResolved: false, comments: [{ id: "C2", body: reviewer }] },
    ],
  });
});

test("threads are listed in the order they were opened, never outdated, and every comment's author is local", (t) => {
  const directory = directoryIn(t);
  openThread(directory, "a.ts", { at: "line", line: 3 }, reviewer, soon());
  openThread(directory, "b.ts", { at: "file" }, reviewer, soon());
  addReply(directory, "T1", agent, soon());

  const listed = listThreads(directory);

  assert.equal(listed.outcome, "listed", JSON.stringify(listed));
  const threads = listed.outcome === "listed" ? listed.threads : [];
  assert.deepEqual(
    threads.map((thread) => [thread.id, thread.path, thread.anchor, thread.isOutdated, thread.isResolved]),
    [
      ["T1", "a.ts", { at: "line", line: 3 }, false, false],
      ["T2", "b.ts", { at: "file" }, false, false],
    ],
  );
  assert.deepEqual(
    threads.flatMap((thread) => thread.comments.map((comment) => [comment.id, comment.author, comment.body])),
    [
      ["C1", "local", reviewer],
      ["C3", "local", agent],
      ["C2", "local", reviewer],
    ],
  );
});

test("a worktree's directory with no threads.json lists no threads", (t) => {
  assert.deepEqual(listThreads(directoryIn(t)), { outcome: "listed", threads: [] });
});

test("resolving and re-opening a thread changes where it stands, and nothing else", (t) => {
  const directory = directoryIn(t);
  openThread(directory, "a.ts", { at: "line", line: 3 }, reviewer, soon());

  assert.deepEqual(setResolved(directory, "T1", true, soon()), { outcome: "acted" });
  const resolved = listThreads(directory);
  assert.deepEqual(setResolved(directory, "T1", false, soon()), { outcome: "acted" });
  const reopened = listThreads(directory);

  assert.equal(resolved.outcome === "listed" && resolved.threads[0]?.isResolved, true);
  assert.equal(reopened.outcome === "listed" && reopened.threads[0]?.isResolved, false);
  assert.deepEqual(idsIn(directory), { threads: ["T1"], comments: ["C1"] });
});

test("ids count up across the file's whole life: after a resolve, a re-open, and another process's write", async (t) => {
  const directory = directoryIn(t);
  openThread(directory, "a.ts", { at: "line", line: 3 }, reviewer, soon());
  openThread(directory, "b.ts", { at: "line", line: 4 }, reviewer, soon());
  addReply(directory, "T1", agent, soon());
  setResolved(directory, "T1", true, soon());
  setResolved(directory, "T1", false, soon());

  // A process that never saw the writes above reads where the count stands from the file.
  assert.equal(await racer(directory, "open-and-reply", "later", 1, 0), "exit 0, failed 0");
  const opened = openThread(directory, "c.ts", { at: "file" }, reviewer, soon());

  assert.deepEqual(opened.outcome === "opened" ? [opened.threadId, opened.commentId] : opened, ["T4", "C6"]);
  assert.deepEqual(idsIn(directory), { threads: ["T1", "T2", "T3", "T4"], comments: ["C1", "C3", "C5", "C2", "C4", "C6"] });
});

test("ten threads and more are counted as numbers, so T10 follows T9 and C10 is the newest", (t) => {
  const directory = directoryIn(t);
  for (let step = 0; step < 9; step += 1) openThread(directory, "a.ts", { at: "line", line: step + 1 }, reviewer, soon());

  const tenth = openThread(directory, "a.ts", { at: "line", line: 10 }, reviewer, soon());
  addReply(directory, "T1", agent, soon());
  const listed = listThreads(directory);

  assert.deepEqual(tenth.outcome === "opened" ? tenth.threadId : tenth, "T10");
  const replies = listed.outcome === "listed" ? (listed.threads[0]?.comments ?? []) : [];
  assert.deepEqual(
    replies.map((comment) => [comment.id, comment.databaseId]),
    [
      ["C1", 1],
      ["C11", 11],
    ],
    "the newest reply must carry the highest number, which is how the latest activity is told",
  );
});

test("a reply or a resolve on an id the file does not hold is refused, and the file is left as it was", (t) => {
  const directory = directoryIn(t);
  openThread(directory, "a.ts", { at: "line", line: 3 }, reviewer, soon());
  const before = readFileSync(join(directory, "threads.json"));

  const outcomes = [
    addReply(directory, "T2", agent, soon()),
    addReply(directory, "C1", agent, soon()),
    addReply(directory, "PRRT_kwDOabc", agent, soon()),
    setResolved(directory, "T9", true, soon()),
  ];

  for (const outcome of outcomes) {
    assert.equal(outcome.outcome, "failed", JSON.stringify(outcome));
    assert.match(outcome.outcome === "failed" ? outcome.reason : "", /holds no thread/u);
  }
  assert.deepEqual(readFileSync(join(directory, "threads.json")), before);
});

test("every body is stored and listed byte for byte as it was handed over", (t) => {
  const directory = directoryIn(t);
  const bodies = [
    "trailing spaces and a tab   \t",
    "trailing newlines\n\n\n",
    "CRLF line one\r\nCRLF line two\r\n",
    "a lone CR\rand a NUL \u0000 and a BOM ﻿",
    "unicode: café, 漢字, emoji 🧪, combining é, RTL ‮",
    '{"threads": [], "id": "T1"} `code` **bold** <!-- squiz --> \\ \\n " \' ${x}',
    "",
  ];

  openThread(directory, "a.ts", { at: "line", line: 1 }, bodies[0] ?? "", soon());
  for (const body of bodies.slice(1)) addReply(directory, "T1", body, soon());

  const listed = listThreads(directory);
  const stored = listed.outcome === "listed" ? (listed.threads[0]?.comments ?? []).map((comment) => comment.body) : [];
  assert.deepEqual(
    stored.map((body) => Buffer.from(body, "utf8")),
    bodies.map((body) => Buffer.from(body, "utf8")),
  );
});

test("writers in four processes at once lose no thread and no reply, and ids stay unique and counting up", { timeout: 120_000 }, async (t) => {
  const directory = directoryIn(t);
  openThread(directory, "a.ts", { at: "line", line: 1 }, reviewer, soon());
  const count = 40;
  const labels = ["A", "B", "C", "D"];
  // Far enough ahead that every process has loaded and is spinning toward it.
  const at = Date.now() + 1_500;

  const ended = await Promise.all(labels.map((label) => racer(directory, "open-and-reply", label, count, at)));

  assert.deepEqual(ended, labels.map(() => "exit 0, failed 0"));
  const listed = listThreads(directory);
  assert.equal(listed.outcome, "listed", JSON.stringify(listed));
  const threads = listed.outcome === "listed" ? listed.threads : [];
  const bodies = new Set(threads.flatMap((thread) => thread.comments.map((comment) => comment.body)));
  const missing = labels.flatMap((label) =>
    Array.from({ length: count }, (_, step) => [`${label}-open-${step}`, `${label}-reply-${step}`]).flat(),
  ).filter((body) => !bodies.has(body));
  assert.deepEqual(missing, [], `${missing.length} of ${2 * count * labels.length} writes were lost to a write that read before another wrote`);

  const total = 1 + count * labels.length;
  assert.deepEqual(threads.map((thread) => thread.id), Array.from({ length: total }, (_, index) => `T${index + 1}`));
  const comments = threads.flatMap((thread) => thread.comments.map((comment) => Number(comment.id.slice(1)))).sort((a, b) => a - b);
  assert.deepEqual(comments, Array.from({ length: total + count * labels.length }, (_, index) => index + 1));
});

test("a reader never sees part of threads.json, even when its writer is killed in the middle of writing", { timeout: 120_000 }, async (t) => {
  const directory = directoryIn(t);
  // Large enough that writing the file takes many system calls.
  openThread(directory, "a.ts", { at: "line", line: 1 }, "x".repeat(8 * 1024 * 1024), soon());

  for (let kill = 0; kill < 6; kill += 1) {
    const writer = spawn(process.execPath, [racerFile, directory, "toggle", "W", "1000", "0"], { stdio: "ignore" });
    const ending = exited(writer);
    const until = Date.now() + 200 + Math.random() * 400;
    let reads = 0;
    while (Date.now() < until) {
      const listed = listThreads(directory);
      assert.equal(listed.outcome, "listed", `read ${reads}: ${JSON.stringify(listed).slice(0, 300)}`);
      reads += 1;
    }
    writer.kill("SIGKILL");
    assert.equal(await ending, "SIGKILL");
    const listed = listThreads(directory);
    assert.equal(listed.outcome, "listed", `after kill ${kill}: ${JSON.stringify(listed).slice(0, 300)}`);
    // The killed writer may have died holding the lock, and must not stop the next write.
    assert.deepEqual(setResolved(directory, "T1", false, soon()), { outcome: "acted" }, `after kill ${kill}`);
  }
});

test("a lock left by a writer killed while holding it is taken over, and the write is made", { timeout: 30_000 }, async (t) => {
  const directory = directoryIn(t);
  openThread(directory, "a.ts", { at: "line", line: 1 }, reviewer, soon());
  const script = [
    `import { takeLock } from ${JSON.stringify(lockFile)};`,
    `const taking = takeLock(${JSON.stringify(directory)}, "threads.lock", { boundMs: 5000 });`,
    `if (taking.outcome !== "taken") process.exit(1);`,
    `process.kill(process.pid, "SIGKILL");`,
  ].join("\n");
  const killed = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "inherit" });
  assert.equal(await exited(killed), "SIGKILL");
  assert.equal(existsSync(join(directory, "threads.lock")), true, "the killed writer left no lock to take over");

  assert.deepEqual(addReply(directory, "T1", agent, soon()), { outcome: "acted" });
  assert.deepEqual(idsIn(directory), { threads: ["T1"], comments: ["C1", "C2"] });
  assert.equal(existsSync(join(directory, "threads.lock")), false);
});

test("a lock held by a live process is never broken: the write fails at its deadline, naming the holder, and writes nothing", { timeout: 30_000 }, async (t) => {
  const directory = directoryIn(t);
  openThread(directory, "a.ts", { at: "line", line: 1 }, reviewer, soon());
  const before = readFileSync(join(directory, "threads.json"));
  // Takes the lock, says so, and keeps it until its input closes.
  const script = [
    `import { takeLock } from ${JSON.stringify(lockFile)};`,
    `const taking = takeLock(${JSON.stringify(directory)}, "threads.lock", { boundMs: 5000 });`,
    `process.stdout.write(taking.outcome + "\\n");`,
    `process.stdin.resume();`,
  ].join("\n");
  const holder = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => holder.kill("SIGKILL"));
  const said = await new Promise<string>((resolve) => holder.stdout?.setEncoding("utf8").once("data", resolve));
  assert.equal(said.trim(), "taken");

  const replied = addReply(directory, "T1", agent, { until: deadlineIn(1_000) });

  assert.equal(replied.outcome, "failed", JSON.stringify(replied));
  // The last look at the holder can be cut short by the deadline, which reports it unknown rather than running.
  assert.match(replied.outcome === "failed" ? replied.reason : "", new RegExp(`process ${holder.pid}, started at`, "u"));
  assert.deepEqual(readFileSync(join(directory, "threads.json")), before);
});

test("a threads.json that cannot be read fails every call with one line naming it, throws nothing, and is left as it was", (t) => {
  for (const text of ["{\"threads\": [", "[]", "{\"threads\": [{\"id\": \"T1\"}]}", "{\"threads\": [{\"id\": \"T1\", \"path\": \"a\", \"anchor\": {\"at\": \"line\", \"line\": 0}, \"isResolved\": false, \"comments\": [{\"id\": \"C1\", \"body\": \"x\"}]}]}"]) {
    const directory = directoryIn(t);
    writeFileSync(join(directory, "threads.json"), text);

    const outcomes = [
      listThreads(directory),
      openThread(directory, "a.ts", { at: "file" }, reviewer, soon()),
      addReply(directory, "T1", agent, soon()),
      setResolved(directory, "T1", true, soon()),
    ];

    for (const outcome of outcomes) {
      assert.equal(outcome.outcome, "failed", `${text}: ${JSON.stringify(outcome)}`);
      const reason = outcome.outcome === "failed" ? outcome.reason : "";
      assert.match(reason, /threads\.json/u, text);
      assert.doesNotMatch(reason, /\n/u, text);
    }
    assert.equal(readFileSync(join(directory, "threads.json"), "utf8"), text);
  }
});

test("a threads.json holding one id twice is refused by every call, and left as it was", (t) => {
  const thread = (id: string, comment: string) => ({
    id,
    path: "a.ts",
    anchor: { at: "file" },
    isResolved: false,
    comments: [{ id: comment, body: "x" }],
  });
  for (const threads of [[thread("T1", "C1"), thread("T1", "C2")], [thread("T1", "C1"), thread("T2", "C1")]]) {
    const directory = directoryIn(t);
    const text = JSON.stringify({ threads });
    writeFileSync(join(directory, "threads.json"), text);

    const outcomes = [listThreads(directory), addReply(directory, "T1", agent, soon()), setResolved(directory, "T1", true, soon())];

    for (const outcome of outcomes) {
      assert.equal(outcome.outcome, "failed", `${text}: ${JSON.stringify(outcome)}`);
      assert.match(outcome.outcome === "failed" ? outcome.reason : "", /threads\.json.*twice/u);
    }
    assert.equal(readFileSync(join(directory, "threads.json"), "utf8"), text);
  }
});

test("a deadline that runs out while the record is being read is not taken for one already spent, and nothing is written", (t) => {
  const directory = directoryIn(t);
  openThread(directory, "a.ts", { at: "line", line: 1 }, reviewer, soon());
  const before = readFileSync(join(directory, "threads.json"));
  let at = 0;
  // Each look at the clock moves it on 60ms, so the 100ms deadline is live at
  // the call's first look and has passed by its second.
  const ticking = (): number => (at += 60);

  const replied = addReply(directory, "T1", agent, { until: deadlineIn(100, ticking) });

  assert.equal(replied.outcome, "failed", JSON.stringify(replied));
  assert.deepEqual(readFileSync(join(directory, "threads.json")), before, "the reply was written after its deadline had passed");
});

test("a directory that cannot be written fails with the reason and throws nothing", (t) => {
  const file = join(directoryIn(t), "a-file");
  writeFileSync(file, "");

  const outcomes = [
    listThreads(file),
    openThread(file, "a.ts", { at: "file" }, reviewer, soon()),
    writeSummary(file, "summary", deadlineIn(LONG_MS)),
    writeFailure(file, "failure", deadlineIn(LONG_MS)),
  ];

  for (const outcome of outcomes) assert.equal(outcome.outcome, "failed", JSON.stringify(outcome));
});

test("a call whose deadline has nothing left is not made, and writes nothing", (t) => {
  const directory = directoryIn(t);
  const spent = { until: deadlineIn(-1) };

  const outcomes = [
    openThread(directory, "a.ts", { at: "file" }, reviewer, spent),
    addReply(directory, "T1", agent, spent),
    setResolved(directory, "T1", true, spent),
    writeSummary(directory, "summary", spent.until),
    writeFailure(directory, "failure", spent.until),
  ];

  for (const outcome of outcomes) {
    assert.equal(outcome.outcome, "failed", JSON.stringify(outcome));
    assert.match(outcome.outcome === "failed" ? outcome.reason : "", /deadline/u);
  }
  assert.deepEqual(readdirSync(directory), []);
});

test("the summary is summary.md, written whole and byte for byte, and a later one replaces it", (t) => {
  const directory = directoryIn(t);
  const first = "## Squiz review\r\n\nfirst 🧪  \n";
  const second = "## Squiz review\n\nsecond";

  assert.deepEqual(writeSummary(directory, first, deadlineIn(LONG_MS)), { outcome: "posted" });
  assert.deepEqual(readFileSync(join(directory, "summary.md")), Buffer.from(first, "utf8"));
  assert.deepEqual(writeSummary(directory, second, deadlineIn(LONG_MS)), { outcome: "posted" });

  assert.deepEqual(readFileSync(join(directory, "summary.md")), Buffer.from(second, "utf8"));
  assert.deepEqual(readdirSync(directory), ["summary.md"]);
});

test("each failure comment is failure-<k>.md, numbered from 1 in the order they were written", (t) => {
  const directory = directoryIn(t);
  const bodies = ["first failure\r\n", "second 🧪", "third  "];

  for (const body of bodies) assert.deepEqual(writeFailure(directory, body, deadlineIn(LONG_MS)), { outcome: "posted" });

  assert.deepEqual(readdirSync(directory).sort(), ["failure-1.md", "failure-2.md", "failure-3.md"]);
  bodies.forEach((body, index) => {
    assert.deepEqual(readFileSync(join(directory, `failure-${index + 1}.md`)), Buffer.from(body, "utf8"));
  });
});
