/**
 * The Copilot extension the plugin ships, run as Copilot runs it: as a process
 * of its own, with `@github/copilot-sdk/extension` supplied from outside. A
 * stand-in session takes the SDK's place and prints a line for each call the
 * extension makes on it.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { readFiringWithSocket } from "./sessions/firing.ts";
import { listening, postMessage } from "./sessions/messaging.ts";

const extension = fileURLToPath(new URL("../extensions/squiz-wake/extension.mjs", import.meta.url));
const sdkHooks = fileURLToPath(new URL("./testing/copilot-sdk-hooks.ts", import.meta.url));

const SESSION_ID = "57444f75-0c1e-4d6b-9a2f-3b8e1d7c5a60";
const BOUND_MS = 5_000;
const NOTE = "Squiz reviewed PR #41 at 3f9c2e0: 1 thread is open. Run `squiz review 41` to read it.";

/** The extension running against a stand-in session, and what it has called on it. */
type Running = {
  readonly child: ChildProcess;
  readonly socket: string;
  readonly workspace: string;
  /** Each call the extension made on the session, as the stand-in printed it. */
  readonly calls: () => readonly Record<string, unknown>[];
};

/**
 * Run `body` with the extension started in a fresh session directory, and stop
 * it after.
 *
 * The directory is under `/tmp`, where a socket path stays inside the 104 bytes
 * macOS allows. `before` runs once the directory exists and before the
 * extension starts.
 */
async function withExtension(body: (running: Running) => Promise<void>, before?: (workspace: string) => void): Promise<void> {
  const home = mkdtempSync("/tmp/squiz-ex-");
  const workspace = join(home, "session-state", SESSION_ID);
  mkdirSync(workspace, { recursive: true });
  before?.(workspace);
  const child = spawn(process.execPath, ["--import", sdkHooks, extension], {
    env: { ...process.env, SQUIZ_STAND_IN_WORKSPACE: workspace },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const calls: Record<string, unknown>[] = [];
  let pending = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) calls.push(JSON.parse(line) as Record<string, unknown>);
  });
  const socket = join(workspace, "squiz.sock");
  try {
    for (let waited = 0; !(await listening(socket, 200)); waited += 20) {
      if (waited > BOUND_MS) assert.fail(`the extension did not start listening: ${JSON.stringify(calls)}`);
      await sleep(20);
    }
    await body({ child, socket, workspace, calls: () => calls });
  } finally {
    child.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  }
}

async function until(done: () => boolean, failure: string): Promise<void> {
  for (let waited = 0; !done(); waited += 20) {
    if (waited > BOUND_MS) assert.fail(failure);
    await sleep(20);
  }
}

function sends(calls: readonly Record<string, unknown>[]): readonly unknown[] {
  return calls.filter((call) => "send" in call).map((call) => call["send"]);
}

test("the round host's post reaches the session as one system message carrying the note", async () => {
  await withExtension(async ({ socket, calls }) => {
    const posted = await postMessage(socket, NOTE, BOUND_MS);

    assert.deepEqual(posted, { outcome: "delivered" });
    await until(() => sends(calls()).length > 0, "the session was sent nothing");
    assert.deepEqual(sends(calls()), [{ prompt: NOTE, source: "system" }]);
  });
});

test("the hook's check, a connection that writes nothing, sends the session nothing", async () => {
  await withExtension(async ({ socket, calls }) => {
    assert.equal(await listening(socket, BOUND_MS), true);
    await postMessage(socket, NOTE, BOUND_MS);

    await until(() => sends(calls()).length > 0, "the session was sent nothing");
    await sleep(100);
    assert.deepEqual(sends(calls()), [{ prompt: NOTE, source: "system" }]);
  });
});

test("a line that is not a user message is dropped, and the lines around it are sent", async () => {
  await withExtension(async ({ socket, calls }) => {
    const line = (content: unknown): string => JSON.stringify({ type: "user", message: { role: "user", content } });
    const lines = [line("first"), "not json", JSON.stringify({ type: "control" }), line(["not", "text"]), line("second")];
    await new Promise<void>((resolve, reject) => {
      const connection = createConnection(socket, () => connection.end(`${lines.join("\n")}\n`));
      connection.on("error", reject);
      connection.on("close", () => resolve());
    });

    await until(() => sends(calls()).length >= 2, "the session was not sent both messages");
    await sleep(100);
    assert.deepEqual(sends(calls()), [
      { prompt: "first", source: "system" },
      { prompt: "second", source: "system" },
    ]);
  });
});

test("a socket file a killed extension left is replaced by a listening one", async () => {
  await withExtension(
    async ({ socket }) => {
      assert.equal(await listening(socket, BOUND_MS), true);
    },
    (workspace) => writeFileSync(join(workspace, "squiz.sock"), "", "utf8"),
  );
});

test("the socket is removed when the session shuts down", async () => {
  await withExtension(async ({ child, socket }) => {
    child.stdin?.write("shutdown\n");

    await until(() => !existsSync(socket), "the socket is still there after the session shut down");
  });
});

test("the socket is removed when Copilot stops the extension", async () => {
  await withExtension(async ({ child, socket }) => {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;

    assert.equal(existsSync(socket), false, "the socket is still there after SIGTERM");
  });
});

test("a session directory too long for a socket path gets a warning in the session, and no socket", async () => {
  const home = mkdtempSync("/tmp/squiz-ex-");
  // Past the 104 bytes macOS allows a socket path, and the 108 Linux allows.
  const workspace = join(home, "x".repeat(60), "session-state", SESSION_ID);
  mkdirSync(workspace, { recursive: true });
  const child = spawn(process.execPath, ["--import", sdkHooks, extension], {
    env: { ...process.env, SQUIZ_STAND_IN_WORKSPACE: workspace },
    stdio: ["pipe", "pipe", "inherit"],
  });
  try {
    let printed = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => (printed += chunk));
    await until(() => printed.includes("\n"), "the extension logged nothing");

    const call = JSON.parse(printed.split("\n")[0] ?? "") as Record<string, unknown>;
    assert.match(String(call["log"]), /^squiz cannot wake this session: /u);
    assert.deepEqual(call["options"], { level: "warning" });
    assert.equal(existsSync(join(workspace, "squiz.sock")), false);
  } finally {
    child.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  }
});

test("the hook records the socket the shipped extension listens on", async () => {
  await withExtension(async ({ socket, workspace }) => {
    const payload = JSON.stringify({
      hook_event_name: "Stop",
      session_id: SESSION_ID,
      cwd: "/work/repo",
      transcript_path: join(workspace, "events.jsonl"),
      stop_reason: "end_turn",
      stop_hook_active: false,
    });

    const read = await readFiringWithSocket(payload, { COPILOT_CLI: "1" });

    assert.deepEqual(read.outcome === "read" ? read.firing.owner : read, { sessionId: SESSION_ID, socket });
  });
});
