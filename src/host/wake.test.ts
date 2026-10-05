/**
 * Each test serves the owner's socket with a `node:net` server of its own, which
 * stands in for the owner session.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { deliverNote, waitingNotes, writeNote } from "../sessions/notes.ts";
import { wakeOwner } from "./wake.ts";

const SESSION = "60517e1f-e1dc-49b1-8e39-6fcbe686f3fb";
const TEXT = "Squiz reviewed PR #41 at 3f9c2e0: 1 thread is open. Run `squiz review 41` to read it.";

type Fixture = { readonly notes: string; readonly socket: string; readonly name: string };

/** Run `body` with one note waiting for SESSION and a socket path beside it, and remove both after. */
async function withNote(body: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "squiz-wake-"));
  try {
    const notes = join(root, "notes");
    const written = writeNote(notes, SESSION, { to: SESSION, text: TEXT });
    if (written.outcome !== "written") assert.fail(`the note was not written: ${written.reason}`);
    await body({ notes, socket: join(root, "s.sock"), name: written.name });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

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

function waiting(notes: string): readonly string[] {
  const listed = waitingNotes(notes, SESSION);
  if (listed.outcome !== "listed") assert.fail(`the notes were not listed: ${listed.reason}`);
  return listed.notes.map((note) => note.name);
}

test("the note is claimed before its text is posted, and stays delivered once the post arrives", async () => {
  await withNote(async ({ notes, socket, name }) => {
    const claimedWhenConnected: boolean[] = [];
    const server = await serving(socket, (connection) => {
      claimedWhenConnected.push(existsSync(join(notes, SESSION, "delivered", name)) && waiting(notes).length === 0);
      connection.resume();
    });
    try {
      const woken = await wakeOwner({ notes, sessionId: SESSION, name, socket, text: TEXT });

      assert.deepEqual(woken, { outcome: "woken" });
      assert.deepEqual(claimedWhenConnected, [true], "the post began before the note was claimed, or never began");
      assert.deepEqual(waiting(notes), []);
      assert.ok(existsSync(join(notes, SESSION, "delivered", name)), "the note is not in delivered/");
    } finally {
      await closed(server);
    }
  });
});

test("a note already claimed is not posted", async () => {
  await withNote(async ({ notes, socket, name }) => {
    let connections = 0;
    const server = await serving(socket, (connection) => {
      connections += 1;
      connection.resume();
    });
    try {
      assert.deepEqual(deliverNote(notes, SESSION, name), { outcome: "delivered" });

      const woken = await wakeOwner({ notes, sessionId: SESSION, name, socket, text: TEXT });

      assert.deepEqual(woken, { outcome: "already delivered" });
      assert.equal(connections, 0, "the owner was posted a note someone else had claimed");
    } finally {
      await closed(server);
    }
  });
});

test("a post to a socket that has gone leaves the note waiting, and says why", async () => {
  await withNote(async ({ notes, socket, name }) => {
    const woken = await wakeOwner({ notes, sessionId: SESSION, name, socket, text: TEXT });

    assert.equal(woken.outcome, "not woken");
    assert.ok(woken.outcome === "not woken" && woken.reason.includes(socket), `the reason does not name the socket: ${JSON.stringify(woken)}`);
    assert.deepEqual(waiting(notes), [name]);
  });
});
