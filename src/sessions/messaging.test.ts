/**
 * Each test serves the socket with a `node:net` server of its own, which stands
 * in for the session that would read it.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { postMessage } from "./messaging.ts";

const BOUND_MS = 2_000;

/** Run `body` with a fresh directory to put a socket in, and remove it after. */
async function withDirectory<T>(body: (directory: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "squiz-msg-"));
  try {
    return await body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** A server listening at `path` that runs `onConnection` for each connection. */
async function serving(path: string, onConnection: (socket: Socket) => void): Promise<Server> {
  const server = createServer(onConnection);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return server;
}

async function closed(server: Server): Promise<void> {
  server.close();
  await new Promise<void>((resolve) => server.once("close", resolve));
}

/** A server that reads each connection to its end and keeps what it read. */
async function reader(path: string): Promise<{ readonly server: Server; readonly received: () => readonly string[] }> {
  const received: string[] = [];
  const server = await serving(path, (socket) => {
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (text += chunk));
    socket.on("end", () => received.push(text));
  });
  return { server, received: () => received };
}

test("a post writes the text to the socket as one user message line, and is delivered", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "s.sock");
    const { server, received } = await reader(path);
    try {
      const text = "Squiz reviewed PR #41 at 3f9c2e0: 1 thread is open.\nRun `squiz review 41` to read it.";

      const posted = await postMessage(path, text, BOUND_MS);

      assert.deepEqual(posted, { outcome: "delivered" });
      // Read once the server has seen the connection end, which may be after the post resolves.
      for (let waited = 0; received().length === 0 && waited < BOUND_MS; waited += 10) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.deepEqual(received(), [`${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`]);
    } finally {
      await closed(server);
    }
  });
});

test("a socket with nothing at its path fails, naming the path", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "gone.sock");

    const posted = await postMessage(path, "hello", BOUND_MS);

    assert.equal(posted.outcome, "failed");
    assert.ok(posted.outcome === "failed" && posted.reason.includes(path), `the reason does not name the path: ${JSON.stringify(posted)}`);
  });
});

test("a path that refuses the connection fails", async () => {
  await withDirectory(async (directory) => {
    // A plain file where the socket was: what is left when no process listens there.
    const path = join(directory, "refusing.sock");
    writeFileSync(path, "", "utf8");

    const posted = await postMessage(path, "hello", BOUND_MS);

    assert.equal(posted.outcome, "failed", `posted as ${JSON.stringify(posted)}`);
  });
});

// The text is larger than the socket's buffer can hold, so the post cannot have
// finished before the server closed, whichever of the two ran first.
test("a socket that accepts and closes without reading fails", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "closing.sock");
    const server = await serving(path, (socket) => socket.destroy());
    try {
      const posted = await postMessage(path, "x".repeat(4_000_000), BOUND_MS);

      assert.equal(posted.outcome, "failed", `posted as ${JSON.stringify(posted)}`);
    } finally {
      await closed(server);
    }
  });
});

test("a socket that accepts and never reads fails once the bound has passed", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "stalled.sock");
    const held: Socket[] = [];
    const server = await serving(path, (socket) => {
      socket.pause();
      held.push(socket);
    });
    try {
      const started = Date.now();
      const posted = await postMessage(path, "x".repeat(4_000_000), 200);

      assert.equal(posted.outcome, "failed", `posted as ${JSON.stringify(posted)}`);
      assert.ok(Date.now() - started < BOUND_MS, `the post took ${Date.now() - started}ms against a bound of 200ms`);
    } finally {
      for (const socket of held) socket.destroy();
      await closed(server);
    }
  });
});
