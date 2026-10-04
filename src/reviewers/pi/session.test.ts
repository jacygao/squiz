import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { type Resume, resumeLine } from "./session.ts";

/** The header `pi` 0.85.1 wrote as the first line of a session it kept. */
function header(id: string, timestamp: string): string {
  return JSON.stringify({ type: "session", version: 3, id, timestamp, cwd: "/tmp/squiz/tree" });
}

/** A session file as `pi` names it, holding its header and one entry after it. */
function writeSession(directory: string, name: string, firstLine: string): void {
  const entry = JSON.stringify({ type: "message", id: "a1b2c3d4", parentId: null });
  writeFileSync(join(directory, name), `${firstLine}\n${entry}\n`);
}

function inADirectory(body: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "squiz-session-"));
  try {
    body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const id = "01a10689-9e50-77f6-897f-fea5bbd5decc";

const none = { kind: "none" } as const;

function resuming(directory: string, session: string): Resume {
  return { kind: "resumable", line: ["pi", "--session-dir", directory, "--session", session] };
}

test("a session the run wrote is resumed by the id its header carries", () => {
  inADirectory((directory) => {
    writeSession(directory, `2026-10-04T10-50-44-689Z_${id}.jsonl`, header(id, "2026-10-04T10:50:44.689Z"));
    assert.deepEqual(resumeLine(directory), resuming(directory, id));
  });
});

// pi documents the header and not the file name, which is only what it happens
// to call the file today.
test("the id is the header's, whatever the file is called", () => {
  inADirectory((directory) => {
    writeSession(directory, "renamed.jsonl", header(id, "2026-10-04T10:50:44.689Z"));
    assert.deepEqual(resumeLine(directory), resuming(directory, id));
  });
});

/**
 * `pi` writes nothing until the first assistant message arrives, so a run
 * stopped before then has no session, and neither has a directory never made.
 */
test("a run that wrote no session has nothing to resume", () => {
  inADirectory((directory) => {
    assert.deepEqual(resumeLine(directory), none);
    assert.deepEqual(resumeLine(join(directory, "never-made")), none);
    writeFileSync(join(directory, "notes.txt"), `${header(id, "2026-10-04T10:50:44.689Z")}\n`);
    assert.deepEqual(resumeLine(directory), none, "a file pi would not list is not a session");
  });
});

// A round that retries starts a second process in the same directory, and the
// later one is the run the round's result came from.
test("of two sessions, the later one is resumed", () => {
  inADirectory((directory) => {
    const later = "01a1068f-0000-7000-8000-000000000002";
    writeSession(directory, `b_${id}.jsonl`, header(id, "2026-10-04T10:50:44.689Z"));
    writeSession(directory, `a_${later}.jsonl`, header(later, "2026-10-04T10:58:01.002Z"));
    assert.deepEqual(resumeLine(directory), resuming(directory, later));
  });
});

// The line is written to a file a person pastes into a shell, so an id pi would
// not have generated is not put on it.
test("a session whose header is not one pi wrote is not resumed", () => {
  inADirectory((directory) => {
    writeSession(directory, "a.jsonl", "not json");
    writeSession(directory, "b.jsonl", JSON.stringify({ type: "message", id }));
    writeSession(directory, "c.jsonl", header("$(touch pwned)", "2026-10-04T10:50:44.689Z"));
    writeSession(directory, "d.jsonl", header(id, "not a time"));
    assert.deepEqual(resumeLine(directory), none);
  });
});

// Passing it over would resume the older session, which is a different
// conversation from the run the round's result came from.
test("a newer session that cannot be read is reported, not passed over for an older one", () => {
  inADirectory((directory) => {
    const later = "01a1068f-0000-7000-8000-000000000002";
    writeSession(directory, `a_${id}.jsonl`, header(id, "2026-10-04T10:50:44.689Z"));
    writeSession(directory, `b_${later}.jsonl`, header(later, "2026-10-04T10:58:01.002Z"));
    chmodSync(join(directory, `b_${later}.jsonl`), 0o000);
    const resumed = resumeLine(directory);
    assert.equal(resumed.kind, "unreadable", `came back as ${JSON.stringify(resumed)}`);
    assert.match(resumed.kind === "unreadable" ? resumed.reason : "", /b_01a1068f/u);
  });
});

test("a session directory that cannot be listed is reported, not read as empty", () => {
  inADirectory((directory) => {
    writeSession(directory, `a_${id}.jsonl`, header(id, "2026-10-04T10:50:44.689Z"));
    chmodSync(directory, 0o000);
    try {
      const resumed = resumeLine(directory);
      assert.equal(resumed.kind, "unreadable", `came back as ${JSON.stringify(resumed)}`);
    } finally {
      chmodSync(directory, 0o700);
    }
  });
});
