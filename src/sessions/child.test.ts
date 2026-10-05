import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { startChild, type ChildStart } from "./child.ts";
import { identityOf } from "./process.ts";

const BOUND_MS = 10_000;

/** One `ps` column for `pid`, trimmed. */
function psColumn(pid: number, column: string): string {
  return spawnSync("ps", ["-o", `${column}=`, "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
}

function stopGroup(started: ChildStart): void {
  if (started.outcome !== "started") return;
  try {
    process.kill(-started.identity.pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/** Everything the child writes on stdout, once it has closed it. */
async function stdoutOf(started: ChildStart): Promise<string> {
  if (started.outcome !== "started") return "";
  let said = "";
  for await (const chunk of started.child.stdout) said += String(chunk);
  return said;
}

test("a started child leads a process group of its own, and is the caller's child", async () => {
  const started = await startChild(
    { program: "sleep", arguments: ["60"], directory: tmpdir() },
    process.env,
    BOUND_MS,
  );
  try {
    assert.equal(started.outcome, "started", JSON.stringify(started));
    if (started.outcome !== "started") return;
    assert.equal(started.identity.pid, started.child.pid);
    assert.deepEqual(identityOf(started.identity.pid, BOUND_MS), { outcome: "read", identity: started.identity });
    assert.equal(psColumn(started.identity.pid, "pgid"), String(started.identity.pid), "it leads no group");
    assert.equal(psColumn(started.identity.pid, "ppid"), String(process.pid), "it is not the caller's child");
  } finally {
    stopGroup(started);
  }
});

test("a child runs in the directory, with the environment, given, and has no terminal", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "squiz-sessions-child-")));
  const script = [
    // A child that exits before its identity is read is a failed start.
    "sleep 1",
    'printf "%s\\n" "$PWD" "$CHILD_MARK"',
    "if [ -t 0 ]; then echo stdin-terminal; else echo stdin-none; fi",
    // Reading stdin ends at once only where it is empty.
    "cat",
    "echo read",
  ].join("; ");
  const started = await startChild(
    { program: "/bin/sh", arguments: ["-c", script], directory },
    { ...process.env, CHILD_MARK: "marked" },
    BOUND_MS,
  );
  try {
    assert.equal(started.outcome, "started", JSON.stringify(started));
    assert.equal(await stdoutOf(started), `${directory}\nmarked\nstdin-none\nread\n`);
  } finally {
    stopGroup(started);
  }
});

test("a program that cannot be run is a failure that started nothing", async () => {
  const started = await startChild(
    { program: "squiz-no-such-program", arguments: [], directory: tmpdir() },
    process.env,
    BOUND_MS,
  );
  assert.equal(started.outcome, "failed");
  assert.match(started.outcome === "failed" ? started.reason : "", /squiz-no-such-program/u);
});

// A command that fails at once can exit before `ps` reads it, more often the
// busier the machine. What it said on its way out is the caller's to read.
test("a child that exited before its identity was read still started, and what it said can be read", async () => {
  const started = await startChild(
    { program: "/bin/sh", arguments: ["-c", "echo no credential"], directory: tmpdir() },
    process.env,
    BOUND_MS,
    () => ({ outcome: "gone" }),
  );
  assert.equal(started.outcome, "started", JSON.stringify(started));
  assert.equal(await stdoutOf(started), "no credential\n");
});
