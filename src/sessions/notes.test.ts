import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

import { deliverNote, waitingNotes, writeNote, type NoteFields, type WaitingNote } from "./notes.ts";

const SESSION = "60517e1f-e1dc-49b1-8e39-6fcbe686f3fb";
const NOTES_MODULE = pathToFileURL(join(import.meta.dirname, "notes.ts")).href;

/** Run `body` with a fresh notes directory, and remove it after. */
async function withDirectory<T>(body: (directory: string) => T | Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "squiz-sessions-notes-"));
  try {
    return await body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function written(directory: string, sessionId: string, fields: NoteFields): string {
  const result = writeNote(directory, sessionId, fields);
  if (result.outcome !== "written") assert.fail(`the note was not written: ${result.reason}`);
  return result.name;
}

function listed(directory: string, sessionId: string): readonly WaitingNote[] {
  const result = waitingNotes(directory, sessionId);
  if (result.outcome !== "listed") assert.fail(`the notes were not listed: ${result.reason}`);
  return result.notes;
}

/** Every path under `directory`, relative to it. */
function everything(directory: string): readonly string[] {
  return readdirSync(directory, { recursive: true, encoding: "utf8" }).sort();
}

/** Run `source` as an ES module in a node process of its own, and resolve with its exit code and output. */
function runModule(
  source: string,
  args: readonly string[],
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", source, "--", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  return new Promise((resolve) => {
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("a note is written as the key=value lines it was given, in their order", async () => {
  await withDirectory((directory) => {
    const fields = { to: SESSION, pr: "41", text: "Squiz reviewed PR #41: 2 threads are open." };
    const name = written(directory, SESSION, fields);

    assert.equal(
      readFileSync(join(directory, SESSION, name), "utf8"),
      `to=${SESSION}\npr=41\ntext=Squiz reviewed PR #41: 2 threads are open.\n`,
    );
    assert.deepEqual(listed(directory, SESSION), [{ outcome: "read", name, fields }]);
  });
});

test("a session no note was written for has none waiting", async () => {
  await withDirectory((directory) => {
    assert.deepEqual(listed(directory, SESSION), []);
  });
});

test("notes are listed oldest first, however many share a millisecond", async () => {
  await withDirectory((directory) => {
    mock.timers.enable({ apis: ["Date"], now: 1_000 });
    try {
      const names = Array.from({ length: 30 }, (_, index) => written(directory, SESSION, { index: String(index) }));
      mock.timers.tick(1);
      names.push(written(directory, SESSION, { index: "later" }));

      assert.deepEqual(
        listed(directory, SESSION).map((note) => note.name),
        names,
      );
    } finally {
      mock.timers.reset();
    }
  });
});

test("a value with a line break reads back as written, and adds no line of its own", async () => {
  await withDirectory((directory) => {
    const fields = { to: SESSION, text: `first\nto=someone-else\r\nback\\slash\\n` };
    const name = written(directory, SESSION, fields);

    const lines = readFileSync(join(directory, SESSION, name), "utf8").split("\n").filter((line) => line !== "");
    assert.deepEqual(
      lines.map((line) => line.slice(0, line.indexOf("="))),
      ["to", "text"],
      "an encoded value must stay on its own line",
    );
    assert.deepEqual(listed(directory, SESSION), [{ outcome: "read", name, fields }]);
  });
});

test("a key that could not be read back is refused", async () => {
  await withDirectory((directory) => {
    for (const key of ["", "a=b", "a\nb", "a b"]) {
      const result = writeNote(directory, SESSION, { [key]: "value" });
      assert.equal(result.outcome, "failed", `the key ${JSON.stringify(key)} was not refused`);
    }
    assert.deepEqual(everything(directory), []);
  });
});

test("a session id that is not one plain name is refused, and nothing is written outside the directory", async () => {
  await withDirectory((parent) => {
    const directory = join(parent, "notes");
    for (const sessionId of ["", ".", "..", "../escaped", "a/b", "/absolute", "a\\b", "a\0b"]) {
      const written = writeNote(directory, sessionId, { to: "x" });
      assert.equal(written.outcome, "failed", `writing for ${JSON.stringify(sessionId)} was not refused`);
      const listing = waitingNotes(directory, sessionId);
      assert.equal(listing.outcome, "failed", `listing for ${JSON.stringify(sessionId)} was not refused`);
      const delivery = deliverNote(directory, sessionId, "000000000001000-000000-0000000000000000.note");
      assert.equal(delivery.outcome, "failed", `delivering for ${JSON.stringify(sessionId)} was not refused`);
    }
    assert.deepEqual(everything(parent), []);
  });
});

test("a notes directory that cannot be entered fails the write as a value", { skip: process.getuid?.() === 0 && "root enters any directory" }, async () => {
  await withDirectory((parent) => {
    const directory = join(parent, "notes");
    mkdirSync(directory, { mode: 0o000 });
    try {
      const result = writeNote(directory, SESSION, { to: "x" });
      assert.equal(result.outcome, "failed");
      const reason = result.outcome === "failed" ? result.reason : "";
      assert.match(reason, /EACCES[^;]*mkdir/u, "the failure must carry the write's own error");
      assert.match(reason, /temporary file was not removed: EACCES/u, "the failure must carry the cleanup's error");
    } finally {
      chmodSync(directory, 0o700);
    }
  });
});

test("a file where the notes directory should be fails the write as a value", async () => {
  await withDirectory((parent) => {
    const directory = join(parent, "notes");
    writeFileSync(directory, "");

    const result = writeNote(directory, SESSION, { to: "x" });
    assert.equal(result.outcome, "failed");
    const reason = result.outcome === "failed" ? result.reason : "";
    assert.match(reason, /ENOTDIR[^;]*mkdir/u, "the failure must carry the write's own error");
    assert.match(reason, /temporary file was not removed: ENOTDIR/u, "the failure must carry the cleanup's error");
  });
});

test("a name that is not a note's is refused rather than moved", async () => {
  await withDirectory((parent) => {
    const directory = join(parent, "notes");
    written(directory, SESSION, { to: "x" });
    writeFileSync(join(parent, "outside.note"), "to=x\n");

    for (const name of ["../../outside.note", "delivered", ".", ".."]) {
      const delivery = deliverNote(directory, SESSION, name);
      assert.equal(delivery.outcome, "failed", `delivering ${JSON.stringify(name)} was not refused`);
    }
    assert.ok(existsSync(join(parent, "outside.note")), "a file outside the session was moved");
  });
});

test("a file under any name but a note's is not listed", async () => {
  await withDirectory((directory) => {
    const name = written(directory, SESSION, { to: "x" });
    writeFileSync(join(directory, SESSION, `.${name}.tmp`), "");
    writeFileSync(join(directory, SESSION, "stray.txt"), "to=y\n");

    assert.deepEqual(
      listed(directory, SESSION).map((note) => note.name),
      [name],
    );
  });
});

test("a note no writer could have written is listed as unreadable, beside the others", async () => {
  await withDirectory((directory) => {
    const first = written(directory, SESSION, { to: "x" });
    const broken = "000000000000001-000000-0000000000000000.note";
    writeFileSync(join(directory, SESSION, broken), "no equals sign\n");
    const unknownEscape = "000000000000002-000000-0000000000000000.note";
    writeFileSync(join(directory, SESSION, unknownEscape), "text=a\\tb\n");

    assert.deepEqual(
      listed(directory, SESSION).map((note) => [note.name, note.outcome]),
      [
        [broken, "unreadable"],
        [unknownEscape, "unreadable"],
        [first, "read"],
      ],
    );
  });
});

test("delivering a note moves it into delivered/, and it is no longer waiting", async () => {
  await withDirectory((directory) => {
    const name = written(directory, SESSION, { to: SESSION });

    assert.deepEqual(deliverNote(directory, SESSION, name), { outcome: "delivered" });
    assert.deepEqual(listed(directory, SESSION), []);
    assert.equal(readFileSync(join(directory, SESSION, "delivered", name), "utf8"), `to=${SESSION}\n`);
    assert.deepEqual(deliverNote(directory, SESSION, name), { outcome: "lost" });
  });
});

test("a lister running while notes are written never sees one half-written", async () => {
  await withDirectory(async (directory) => {
    const count = 40;
    // Large, so that the writer is part way through a note for much of the time the lister runs.
    const fillerLength = 16 * 1024 * 1024;
    const filler = "x".repeat(fillerLength);
    const writer = runModule(
      `
        import { writeNote } from ${JSON.stringify(NOTES_MODULE)};
        const [directory, session, count, fillerLength] = process.argv.slice(1);
        const filler = "x".repeat(Number(fillerLength));
        for (let index = 0; index < Number(count); index++) {
          const result = writeNote(directory, session, { index: String(index), filler, end: "end" });
          if (result.outcome !== "written") throw new Error(JSON.stringify(result));
        }
      `,
      [directory, SESSION, String(count), String(fillerLength)],
    );

    let finished = false;
    void writer.then(() => (finished = true));
    // Each note is delivered once checked, so that every pass reads only the
    // notes written since the last, while they may still be being written.
    let delivered = 0;
    let passesDuringWriting = 0;
    for (;;) {
      const done = finished;
      const notes = listed(directory, SESSION);
      if (!done && notes.length > 0) passesDuringWriting++;
      for (const note of notes) {
        assert.equal(note.outcome, "read", `${note.name} was unreadable`);
        if (note.outcome !== "read") continue;
        const whole = note.fields["end"] === "end" && note.fields["filler"] === filler;
        assert.ok(whole, `${note.name} was listed before it was whole`);
        assert.deepEqual(deliverNote(directory, SESSION, note.name), { outcome: "delivered" });
        delivered++;
      }
      if (done) break;
      await sleep(0);
    }

    const { code, stderr } = await writer;
    assert.equal(code, 0, `the writer failed: ${stderr}`);
    assert.equal(delivered, count);
    assert.ok(passesDuringWriting > 1, "the lister never ran while notes were being written, so the test proved nothing");
  });
});

test("two processes racing to deliver the same notes deliver each exactly once", async () => {
  await withDirectory(async (directory) => {
    const deliverer = `
      import { existsSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      import { deliverNote, waitingNotes } from ${JSON.stringify(NOTES_MODULE)};
      const [directory, session, signals, which] = process.argv.slice(1);
      writeFileSync(join(signals, "ready-" + which), "");
      while (!existsSync(join(signals, "go"))) {}
      const delivered = [];
      let lost = 0;
      for (;;) {
        const listing = waitingNotes(directory, session);
        if (listing.outcome !== "listed") throw new Error(JSON.stringify(listing));
        if (listing.notes.length === 0) break;
        for (const note of listing.notes) {
          const delivery = deliverNote(directory, session, note.name);
          if (delivery.outcome === "delivered") delivered.push(note.name);
          else if (delivery.outcome === "lost") lost++;
          else throw new Error(JSON.stringify(delivery));
        }
      }
      process.stdout.write(JSON.stringify({ delivered, lost }));
    `;

    const rounds = 10;
    const count = 40;
    let lostInAll = 0;
    for (let round = 0; round < rounds; round++) {
      const session = `session-${round}`;
      const signals = join(directory, `signals-${round}`);
      const names = Array.from({ length: count }, (_, index) => written(directory, session, { index: String(index) }));
      mkdirSync(signals);

      const racers = ["a", "b"].map((which) => runModule(deliverer, [directory, session, signals, which]));
      while (!existsSync(join(signals, "ready-a")) || !existsSync(join(signals, "ready-b"))) await sleep(1);
      writeFileSync(join(signals, "go"), "");
      const results = await Promise.all(racers);

      const delivered: string[] = [];
      for (const { code, stdout, stderr } of results) {
        assert.equal(code, 0, `a deliverer failed: ${stderr}`);
        const report = JSON.parse(stdout) as { delivered: string[]; lost: number };
        delivered.push(...report.delivered);
        lostInAll += report.lost;
      }
      assert.deepEqual([...delivered].sort(), [...names].sort(), `round ${round}: a note was delivered twice or not at all`);
      assert.deepEqual(
        readdirSync(join(directory, session, "delivered")).sort(),
        [...names].sort(),
        `round ${round}: delivered/ does not hold every note`,
      );
      assert.deepEqual(listed(directory, session), []);
    }
    assert.ok(lostInAll > 0, "no deliverer ever lost a note to the other, so the two never raced");
  });
});
