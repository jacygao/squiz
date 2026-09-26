import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";

import { readPayload, readPayloadFrom, type PayloadStream } from "./payload.ts";

/** The subagent's id, in the shape every id the runtime has emitted holds. */
const AGENT_ID = "a1e3196c5ad0f2410";

/** The id of the user turn in the parent session, which is never the key. */
const PROMPT_ID = "59893e32-bf05-4243-8b68-062d0f8767ef";

/**
 * A firing as the runtime writes it, every field included.
 *
 * The fields that are not read are here because they are what a reader of this
 * module reaches for by mistake: `prompt_id` is one string for every subagent
 * in a session, `cwd` is the session's directory, and `stop_hook_active` says
 * what happened before this firing.
 */
function payloadText(over: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    session_id: "60517e1f-e1dc-49b1-8e39-6fcbe686f3fb",
    transcript_path: "/transcripts/60517e1f.jsonl",
    cwd: "/work/session-directory",
    prompt_id: PROMPT_ID,
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

/** What `readPayload` established, or the assertion that it established nothing. */
function idIn(text: string): string {
  const read = readPayload(text);
  assert.equal(read.outcome, "read", `the payload was not read: ${JSON.stringify(read)}`);
  return read.outcome === "read" ? read.payload.agentId : "";
}

function reasonFrom(read: ReturnType<typeof readPayload>): string {
  assert.equal(read.outcome, "unreadable", `the payload was read: ${JSON.stringify(read)}`);
  return read.outcome === "unreadable" ? read.reason : "";
}

test("the key is the subagent's id", () => {
  assert.equal(idIn(payloadText()), AGENT_ID);
});

test("the key is never prompt_id, which two subagents share", () => {
  // `prompt_id` is per user turn in the parent session: the same string for two
  // subagents at once, and a different one between one subagent's own stops.
  // Keying on it would merge two episodes and split one.
  const id = idIn(payloadText());

  assert.notEqual(id, PROMPT_ID);
  assert.equal(
    reasonFrom(readPayload(JSON.stringify({ prompt_id: PROMPT_ID, cwd: "/work" }))).includes(
      "agent_id",
    ),
    true,
  );
});

test("stop_hook_active is not read, whatever it says", () => {
  // It is true from the second firing of an episode onward, which is every
  // firing where the loop means to block.
  assert.equal(idIn(payloadText({ stop_hook_active: true })), AGENT_ID);
  assert.equal(idIn(payloadText({ stop_hook_active: false })), AGENT_ID);
});

test("an id the runtime never emits is still the id that arrived", () => {
  // Nothing is asserted about the id's shape here: what a directory name may
  // hold is decided where the id becomes a path, and a payload this refused
  // would be a firing the harness could not explain.
  assert.equal(idIn(payloadText({ agent_id: "../../etc/passwd" })), "../../etc/passwd");
});

test("a payload carrying no agent_id is unreadable", () => {
  const text = JSON.stringify({ session_id: "60517e1f", hook_event_name: "SubagentStop" });

  assert.match(reasonFrom(readPayload(text)), /agent_id/u);
});

test("an agent_id that is not a string is unreadable", () => {
  for (const id of [42, null, true, ["a1e3196c5ad0f2410"], { id: "a1e3196c5ad0f2410" }, ""]) {
    assert.match(reasonFrom(readPayload(payloadText({ agent_id: id }))), /agent_id/u);
  }
});

test("a payload that is not a JSON object is unreadable", () => {
  for (const text of ["[]", '"a1e3196c5ad0f2410"', "42", "null", "[{}]"]) {
    assert.match(reasonFrom(readPayload(text)), /not a JSON object/u);
  }
});

test("an empty stdin is unreadable rather than an empty episode", () => {
  for (const text of ["", "   ", "\n"]) {
    assert.match(reasonFrom(readPayload(text)), /no payload/u);
  }
});

test("nothing the payload carried reaches the reason", () => {
  // The reason leaves on stderr, where Claude Code shows it. The payload holds
  // the subagent's last message, which is not the hook's to repeat.
  const secret = "SQUIZ-SECRET-fd41b0";
  const truncated = `{"agent_id":"${AGENT_ID}","last_assistant_message":"${secret}`;

  const reason = reasonFrom(readPayload(truncated));

  assert.equal(reason.includes(secret), false, reason);
  assert.match(reason, /not valid JSON/u);
});

test("a payload arriving in pieces is read whole", async () => {
  // The runtime writes the payload to a pipe, which delivers it in whatever
  // pieces it likes. A character split across two of them must not come out as
  // two replacements.
  const text = payloadText({ last_assistant_message: "reviewed “café” and é" });
  const bytes = Buffer.from(text, "utf8");
  const pieces = [bytes.subarray(0, 40), bytes.subarray(40, 41), bytes.subarray(41)];

  const read = await readPayloadFrom(Readable.from(pieces));

  assert.equal(read.outcome, "read");
  assert.equal(read.outcome === "read" ? read.payload.agentId : "", AGENT_ID);
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

  const result = await readPayloadFrom(terminal);

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

  const read = await readPayloadFrom(broken);

  assert.match(reasonFrom(read), /the pipe was closed/u);
});
