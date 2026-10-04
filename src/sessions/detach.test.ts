import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { startDetached, type Detached } from "./detach.ts";
import { stillRunning, type ProcessIdentity } from "./process.ts";

const BOUND_MS = 10_000;

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "squiz-sessions-detach-"));
}

function startedIdentity(started: Detached): ProcessIdentity {
  assert.equal(started.outcome, "started", `started as ${JSON.stringify(started)}`);
  return started.outcome === "started" ? started.identity : { pid: 0, startedAt: 0 };
}

/** Stop the process `identity` names, if it is still the one holding its pid. */
function stop(identity: ProcessIdentity): void {
  if (stillRunning(identity, BOUND_MS).outcome !== "running") return;
  try {
    process.kill(identity.pid, "SIGKILL");
  } catch {
    // Gone between the check and the kill.
  }
}

/** Wait until `done` holds, polling, and fail the test if it does not within `ms`. */
async function until(done: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) assert.fail(`${what} did not happen within ${ms}ms`);
    await sleep(50);
  }
}

/** One `ps` column for `pid`, trimmed. */
function psColumn(pid: number, column: string): string {
  return spawnSync("ps", ["-o", `${column}=`, "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
}

/**
 * A Node process, leading a process group of its own, that starts `sleep 60`
 * detached and prints the identity it got back as one line of JSON. It then
 * exits, or with `linger` keeps running until it is killed.
 */
function caller(directory: string, linger: boolean) {
  const module = pathToFileURL(join(import.meta.dirname, "detach.ts")).href;
  const script = [
    `import { startDetached } from ${JSON.stringify(module)};`,
    `const started = startDetached({ command: "sleep", args: ["60"], cwd: ${JSON.stringify(directory)}, logPath: ${JSON.stringify(join(directory, "target.log"))} }, ${BOUND_MS});`,
    `process.stdout.write(JSON.stringify(started) + "\\n");`,
    linger ? "setInterval(() => {}, 1000);" : "",
  ].join("\n");
  return spawn(process.execPath, ["--input-type=module", "-e", script], {
    detached: true,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

test("a started process has left its caller's process group and been reparented", () => {
  const directory = scratch();
  const identity = startedIdentity(
    startDetached({ command: "sleep", args: ["60"], cwd: directory, logPath: join(directory, "log") }, BOUND_MS),
  );
  try {
    assert.deepEqual(stillRunning(identity, BOUND_MS), { outcome: "running" });
    assert.equal(psColumn(identity.pid, "pgid"), String(identity.pid), "it does not lead a process group");
    assert.notEqual(psColumn(identity.pid, "ppid"), String(process.pid), "it is still the caller's child");
    if (process.platform === "linux") {
      assert.equal(psColumn(identity.pid, "sid"), String(identity.pid), "it does not lead a session");
    }
  } finally {
    stop(identity);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a started process reads /dev/null and appends both its streams to the log", async () => {
  const directory = scratch();
  const log = join(directory, "log");
  writeFileSync(log, "before\n", "utf8");
  const identity = startedIdentity(
    startDetached(
      { command: "sh", args: ["-c", "cat; echo out; echo err >&2; pwd; sleep 1"], cwd: directory, logPath: log },
      BOUND_MS,
    ),
  );
  try {
    await until(() => stillRunning(identity, BOUND_MS).outcome === "gone", BOUND_MS, "the target exiting");
    const pwd = spawnSync("pwd", ["-P"], { cwd: directory, encoding: "utf8" }).stdout;
    assert.equal(readFileSync(log, "utf8"), `before\nout\nerr\n${pwd}`);
  } finally {
    stop(identity);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a command that cannot be started is a failure, not a pid", () => {
  const directory = scratch();
  try {
    const started = startDetached(
      { command: "squiz-no-such-command", args: [], cwd: directory, logPath: join(directory, "log") },
      BOUND_MS,
    );
    assert.equal(started.outcome, "failed", `started as ${JSON.stringify(started)}`);
    assert.match("reason" in started ? started.reason : "", /ENOENT/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a log that cannot be opened is a failure, and nothing is started", () => {
  const directory = scratch();
  try {
    const started = startDetached(
      { command: "sleep", args: ["60"], cwd: directory, logPath: join(directory, "missing", "log") },
      BOUND_MS,
    );
    assert.equal(started.outcome, "failed", `started as ${JSON.stringify(started)}`);
    assert.match("reason" in started ? started.reason : "", /ENOENT/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("whatever reads the caller's output reaches its end while the started process runs on", async () => {
  const directory = scratch();
  const child = caller(directory, false);
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
  let ended = false;
  child.stdout.on("close", () => (ended = true));
  try {
    await until(() => ended, BOUND_MS, "the end of the caller's output");
    const identity = startedIdentity(JSON.parse(output) as Detached);
    try {
      assert.deepEqual(stillRunning(identity, BOUND_MS), { outcome: "running" });
    } finally {
      stop(identity);
    }
  } finally {
    child.kill("SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a started process outlives a kill of its caller's whole process group", async () => {
  const directory = scratch();
  const child = caller(directory, true);
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
  let exited = false;
  child.on("exit", () => (exited = true));
  try {
    await until(() => output.includes("\n"), BOUND_MS, "the caller printing the identity");
    const identity = startedIdentity(JSON.parse(output) as Detached);
    try {
      process.kill(-(child.pid ?? 0), "SIGKILL");
      await until(() => exited, BOUND_MS, "the caller dying");
      assert.deepEqual(stillRunning(identity, BOUND_MS), { outcome: "running" });
    } finally {
      stop(identity);
    }
  } finally {
    if (!exited) child.kill("SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
});
