import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { resumeLine } from "./session.ts";

function home(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "squiz-copilot-session-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** A session as Copilot keeps it: a directory named for its id, opening with `session.start`. */
function session(directory: string, id: string, startTime: string, named = id): void {
  const kept = join(directory, "session-state", named);
  mkdirSync(kept, { recursive: true });
  const start = { type: "session.start", data: { sessionId: id, startTime, selectedModel: "gpt-5-mini" } };
  writeFileSync(join(kept, "events.jsonl"), `${JSON.stringify(start)}\n{"type":"user.message"}\n`);
}

test("the line resumes the session Copilot kept under the round's COPILOT_HOME, spelled as given", (t) => {
  const directory = home(t);
  session(directory, "a8956c61-459a-4b28-9f75-10513a454496", "2026-10-05T23:58:42.393Z");
  assert.deepEqual(resumeLine(directory, ".squiz/41/rounds/2/session"), [
    "COPILOT_HOME=.squiz/41/rounds/2/session",
    "copilot",
    "--resume=a8956c61-459a-4b28-9f75-10513a454496",
  ]);
});

// A round that ran twice keeps two sessions, and the second is the round's.
test("of two sessions, the later started is resumed", (t) => {
  const directory = home(t);
  session(directory, "bbbbbbbb-0000-4000-8000-000000000002", "2026-10-05T23:59:10.000Z");
  session(directory, "aaaaaaaa-0000-4000-8000-000000000001", "2026-10-05T23:58:00.000Z");
  assert.equal(resumeLine(directory, "s")?.at(-1), "--resume=bbbbbbbb-0000-4000-8000-000000000002");
});

test("there is nothing to resume where Copilot kept no session", (t) => {
  const directory = home(t);
  assert.equal(resumeLine(directory, "s"), undefined);
  assert.equal(resumeLine(join(directory, "never-made"), "s"), undefined);
  mkdirSync(join(directory, "session-state", ".session-operation-locks"), { recursive: true });
  assert.equal(resumeLine(directory, "s"), undefined);
});

const OLDER = "aaaaaaaa-0000-4000-8000-000000000001";

test("a later session whose record names another id, or none, is passed over", (t) => {
  const directory = home(t);
  session(directory, OLDER, "2026-10-05T23:50:00.000Z");
  session(directory, "cccccccc-0000-4000-8000-000000000003", "2026-10-05T23:58:00.000Z", "dddddddd-0000-4000-8000-000000000004");
  mkdirSync(join(directory, "session-state", "eeeeeeee-0000-4000-8000-000000000005"));
  assert.equal(resumeLine(directory, "s")?.at(-1), `--resume=${OLDER}`);
});

test("a later session whose id is not one word to a shell is passed over", (t) => {
  const directory = home(t);
  session(directory, OLDER, "2026-10-05T23:50:00.000Z");
  session(directory, "x; rm -rf ~", "2026-10-05T23:58:00.000Z", "x");
  assert.equal(resumeLine(directory, "s")?.at(-1), `--resume=${OLDER}`);
});
