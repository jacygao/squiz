import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";

import type { Firing, FiringRead, HookEnvironment } from "../sessions/firing.ts";
import { readPayloadFrom, type PayloadStream } from "./payload.ts";

/** The subagent's id, in the shape every id the runtime has emitted holds. */
const AGENT_ID = "a1e3196c5ad0f2410";

const SESSION_ID = "60517e1f-e1dc-49b1-8e39-6fcbe686f3fb";

/** A firing as the runtime writes it, every field included. */
function payloadText(over: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    session_id: SESSION_ID,
    transcript_path: "/transcripts/60517e1f.jsonl",
    cwd: "/work/session-directory",
    prompt_id: "59893e32-bf05-4243-8b68-062d0f8767ef",
    permission_mode: "acceptEdits",
    agent_id: AGENT_ID,
    agent_type: "general-purpose",
    effort: { level: "xhigh" },
    hook_event_name: "SubagentStop",
    stop_hook_active: false,
    agent_transcript_path: `/transcripts/60517e1f/subagents/agent-${AGENT_ID}.jsonl`,
    last_assistant_message: "The change is on the branch.",
    background_tasks: [],
    session_crons: [],
    ...over,
  });
}

/** The firing read from `stream`, or the assertion that one was read. */
async function firingFrom(stream: PayloadStream, environment: HookEnvironment = {}): Promise<Firing> {
  const read = await readPayloadFrom(stream, environment);
  assert.equal(read.outcome, "read", `the payload was not read: ${JSON.stringify(read)}`);
  if (read.outcome !== "read") throw new Error("unreachable");
  return read.firing;
}

function reasonFrom(read: FiringRead): string {
  assert.equal(read.outcome, "unreadable", `the payload was read: ${JSON.stringify(read)}`);
  return read.outcome === "unreadable" ? read.reason : "";
}

test("an empty stdin is unreadable rather than an empty firing", async () => {
  for (const text of ["", "   ", "\n"]) {
    assert.match(reasonFrom(await readPayloadFrom(Readable.from([text]), {})), /no payload/u);
  }
});

test("the hook's environment names the owner's socket", async () => {
  const firing = await firingFrom(Readable.from([payloadText()]), { CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc.sock" });

  assert.deepEqual(firing, {
    event: "SubagentStop",
    directory: "/work/session-directory",
    owner: { sessionId: SESSION_ID, socket: "/tmp/cc.sock" },
    subagent: AGENT_ID,
  });
});

test("a payload arriving in pieces is read whole", async () => {
  // The runtime writes the payload to a pipe, which delivers it in whatever
  // pieces it likes. A character split across two of them must not come out as
  // two replacements.
  const text = payloadText({ last_assistant_message: "reviewed “café” and é" });
  const bytes = Buffer.from(text, "utf8");
  const pieces = [bytes.subarray(0, 40), bytes.subarray(40, 41), bytes.subarray(41)];

  const firing = await firingFrom(Readable.from(pieces));

  assert.equal(firing.event === "SubagentStop" ? firing.subagent : "", AGENT_ID);
});

test("a stdin that is a terminal is nobody's payload, and is not waited on", async () => {
  // Reading to the end of input from a terminal would hold the coding agent's
  // turn open until the runtime killed the hook.
  let read = false;
  const terminal: PayloadStream = {
    isTTY: true,
    async *[Symbol.asyncIterator](): AsyncGenerator<string> {
      read = true;
      yield payloadText();
    },
  };

  const result = await readPayloadFrom(terminal, {});

  assert.equal(result.outcome, "unreadable");
  assert.equal(read, false, "a terminal was read from");
});

test("a stdin that fails mid-read is unreadable rather than a throw", async () => {
  const broken = Readable.from(
    (async function* (): AsyncGenerator<string> {
      yield '{"agent_id":';
      throw new Error("the pipe was closed");
    })(),
  );

  const read = await readPayloadFrom(broken, {});

  assert.match(reasonFrom(read), /the pipe was closed/u);
});
