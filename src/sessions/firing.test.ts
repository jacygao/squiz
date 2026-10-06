import assert from "node:assert/strict";
import { test } from "node:test";

import { readFiring, type Firing, type FiringRead, type HookEnvironment } from "./firing.ts";

const SESSION_ID = "60517e1f-e1dc-49b1-8e39-6fcbe686f3fb";
const AGENT_ID = "a1e3196c5ad0f2410";
const SOCKET = "/tmp/cc-socks/57053.sock";
const DIRECTORY = "/work/session-directory";

/** The hook's environment as the runtime gives it, with a messaging socket. */
const WITH_SOCKET: HookEnvironment = {
  CLAUDE_CODE_SESSION_ID: SESSION_ID,
  CLAUDE_CODE_MESSAGING_SOCKET: SOCKET,
  CLAUDE_CODE_MESSAGING_TOKEN: "token-not-read-here",
};

/** A text that must never reach a reason, put where a subagent's last message goes. */
const SECRET = "SQUIZ-SECRET-fd41b0";

/** A `Stop` firing in Claude Code 2.1.289, in print mode, every field included. */
function stopText(over: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    session_id: SESSION_ID,
    transcript_path: `/transcripts/${SESSION_ID}.jsonl`,
    cwd: DIRECTORY,
    prompt_id: "26307758-09d6-454d-9375-a29943e65963",
    permission_mode: "default",
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: SECRET,
    background_tasks: [],
    session_crons: [],
    ...over,
  });
}

/** A `SubagentStop` firing for a dispatched subagent, every field included. */
function subagentStopText(over: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    session_id: SESSION_ID,
    transcript_path: `/transcripts/${SESSION_ID}.jsonl`,
    cwd: DIRECTORY,
    prompt_id: "59893e32-bf05-4243-8b68-062d0f8767ef",
    permission_mode: "acceptEdits",
    agent_id: AGENT_ID,
    agent_type: "general-purpose",
    effort: { level: "xhigh" },
    hook_event_name: "SubagentStop",
    stop_hook_active: false,
    agent_transcript_path: `/transcripts/${SESSION_ID}/subagents/agent-${AGENT_ID}.jsonl`,
    last_assistant_message: SECRET,
    background_tasks: [
      {
        id: AGENT_ID,
        type: "subagent",
        status: "running",
        description: "Alpha worker creates alpha.txt",
        agent_type: "general-purpose",
      },
    ],
    session_crons: [],
    ...over,
  });
}

/**
 * One of the firings an interactive session makes after a turn ends, which no
 * dispatched subagent caused: an empty `agent_type`, a fresh `agent_id`, no
 * last message, and no tasks.
 */
function phantomText(): string {
  return JSON.stringify({
    session_id: SESSION_ID,
    transcript_path: `/transcripts/${SESSION_ID}.jsonl`,
    cwd: DIRECTORY,
    prompt_id: "59893e32-bf05-4243-8b68-062d0f8767ef",
    permission_mode: "default",
    agent_id: "a52d5fd4b5ef193bc",
    agent_type: "",
    hook_event_name: "SubagentStop",
    stop_hook_active: false,
    agent_transcript_path: `/transcripts/${SESSION_ID}/subagents/agent-a52d5fd4b5ef193bc.jsonl`,
    background_tasks: [],
    session_crons: [],
  });
}

function firingIn(read: FiringRead): Firing {
  assert.equal(read.outcome, "read", `the payload was not read: ${JSON.stringify(read)}`);
  if (read.outcome !== "read") throw new Error("unreachable");
  return read.firing;
}

function reasonFrom(read: FiringRead): string {
  assert.equal(read.outcome, "unreadable", `the payload was read: ${JSON.stringify(read)}`);
  const reason = read.outcome === "unreadable" ? read.reason : "";
  assert.equal(reason.includes(SECRET), false, `the reason carries the payload's text: ${reason}`);
  return reason;
}

test("on Stop, the owner is the session itself, with its socket", () => {
  assert.deepEqual(firingIn(readFiring(stopText(), WITH_SOCKET)), {
    event: "Stop",
    directory: DIRECTORY,
    owner: { sessionId: SESSION_ID, socket: SOCKET },
  });
});

test("on SubagentStop, the owner is the dispatching session, with its socket, and the subagent is named", () => {
  // The subagent runs inside its parent's process, so the socket in its hook's
  // environment is the parent's.
  assert.deepEqual(firingIn(readFiring(subagentStopText(), WITH_SOCKET)), {
    event: "SubagentStop",
    directory: DIRECTORY,
    owner: { sessionId: SESSION_ID, socket: SOCKET },
    subagent: AGENT_ID,
  });
});

test("an environment with no messaging socket gives an owner with no socket", () => {
  for (const environment of [{}, { CLAUDE_CODE_MESSAGING_SOCKET: undefined }]) {
    for (const text of [stopText(), subagentStopText()]) {
      const owner = firingIn(readFiring(text, environment)).owner;
      assert.equal("socket" in owner, false, `a socket was given: ${JSON.stringify(owner)}`);
    }
  }
});

test("an empty messaging socket is no socket, rather than one a post would try", () => {
  for (const text of [stopText(), subagentStopText()]) {
    const owner = firingIn(readFiring(text, { CLAUDE_CODE_MESSAGING_SOCKET: "" })).owner;
    assert.equal("socket" in owner, false, `a socket was given: ${JSON.stringify(owner)}`);
  }
});

test("a socket named in the payload is not read", () => {
  const text = stopText({ CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/1.sock", socket: "/tmp/x.sock" });

  const owner = firingIn(readFiring(text, {})).owner;

  assert.equal("socket" in owner, false, `a socket was given: ${JSON.stringify(owner)}`);
});

test("a SubagentStop whose agent_type is empty is no subagent's work", () => {
  assert.deepEqual(readFiring(phantomText(), WITH_SOCKET), { outcome: "no subagent's work" });
});

test("a SubagentStop carrying no agent_type is a subagent's work", () => {
  // Every measured firing carried the field, so its absence marks no firing
  // apart. Only the empty string does.
  const payload = JSON.parse(subagentStopText()) as Record<string, unknown>;
  delete payload["agent_type"];

  const firing = firingIn(readFiring(JSON.stringify(payload), WITH_SOCKET));

  assert.equal(firing.event, "SubagentStop");
  assert.equal(firing.event === "SubagentStop" ? firing.subagent : "", AGENT_ID);
});

test("an agent_type that is not a string is unreadable", () => {
  for (const type of [42, null, true, ["general-purpose"], {}]) {
    assert.match(reasonFrom(readFiring(subagentStopText({ agent_type: type }), WITH_SOCKET)), /agent_type/u);
  }
});

test("a Stop names no subagent, whatever agent fields it carries", () => {
  for (const over of [{ agent_id: AGENT_ID }, { agent_id: AGENT_ID, agent_type: "" }]) {
    assert.deepEqual(firingIn(readFiring(stopText(over), WITH_SOCKET)), {
      event: "Stop",
      directory: DIRECTORY,
      owner: { sessionId: SESSION_ID, socket: SOCKET },
    });
  }
});

test("a SubagentStop carrying no usable agent_id is unreadable", () => {
  for (const id of [undefined, "", 42, null, [AGENT_ID]]) {
    assert.match(reasonFrom(readFiring(subagentStopText({ agent_id: id }), WITH_SOCKET)), /agent_id/u);
  }
});

test("a payload carrying no usable session_id is unreadable", () => {
  for (const id of [undefined, "", 42, null, { id: SESSION_ID }]) {
    for (const text of [stopText({ session_id: id }), subagentStopText({ session_id: id })]) {
      assert.match(reasonFrom(readFiring(text, WITH_SOCKET)), /session_id/u);
    }
  }
});

test("a payload carrying no usable cwd is unreadable, since the worktree is resolved from it", () => {
  for (const cwd of [undefined, "", 42, null, ["/work"], "work/session-directory"]) {
    for (const text of [stopText({ cwd }), subagentStopText({ cwd })]) {
      assert.match(reasonFrom(readFiring(text, WITH_SOCKET)), /cwd/u, `for ${JSON.stringify(cwd)}`);
    }
  }
});

test("an event other than Stop or SubagentStop is unreadable, and is not quoted", () => {
  for (const event of [undefined, "", "PreToolUse", 42, SECRET]) {
    assert.match(reasonFrom(readFiring(stopText({ hook_event_name: event }), WITH_SOCKET)), /hook_event_name/u);
  }
});

test("a payload that is not valid JSON is unreadable, and its text is not quoted", () => {
  const truncated = `{"session_id":"${SESSION_ID}","last_assistant_message":"${SECRET}`;

  assert.match(reasonFrom(readFiring(truncated, WITH_SOCKET)), /not valid JSON/u);
});

test("a payload that is not a JSON object is unreadable", () => {
  for (const text of ["[]", `"${SECRET}"`, "42", "null", "[{}]"]) {
    assert.match(reasonFrom(readFiring(text, WITH_SOCKET)), /not a JSON object/u);
  }
});

test("an empty payload is unreadable", () => {
  for (const text of ["", "   ", "\n"]) {
    assert.match(reasonFrom(readFiring(text, WITH_SOCKET)), /no payload/u);
  }
});

// Copilot CLI 1.0.92's firings through the plugin's Claude-format registration,
// as logged. The ids keep the logged prefixes.
const COPILOT_PARENT = "57444f75-0c1e-4d6b-9a2f-3b8e1d7c5a60";
const COPILOT_SUBAGENT = "829422d1-6f3a-4b9e-8c2d-7e1f0a5b4c39";
const COPILOT_TRANSCRIPT = `/Users/someone/.copilot/session-state/${COPILOT_PARENT}/events.jsonl`;

/** A Copilot hook's environment, where Copilot was started inside a Claude Code session that passed its socket down. */
const UNDER_COPILOT: HookEnvironment = {
  COPILOT_CLI: "1",
  COPILOT_CLI_BINARY_VERSION: "1.0.92",
  CLAUDE_CODE_MESSAGING_SOCKET: SOCKET,
};

/** A Copilot `Stop`, which names the parent's transcript whichever turn ended. */
function copilotStopText(sessionId: string): string {
  return JSON.stringify({
    hook_event_name: "Stop",
    session_id: sessionId,
    timestamp: "2026-10-06T05:34:54.854Z",
    cwd: "/work/repo",
    transcript_path: COPILOT_TRANSCRIPT,
    stop_reason: "end_turn",
    stop_hook_active: false,
  });
}

function copilotSubagentStopText(): string {
  return JSON.stringify({
    hook_event_name: "SubagentStop",
    session_id: COPILOT_PARENT,
    timestamp: "2026-10-06T05:34:55.034Z",
    cwd: "/work/repo",
    transcript_path: COPILOT_TRANSCRIPT,
    agent_id: COPILOT_SUBAGENT,
    agent_type: "explore",
    agent_name: "explore",
    last_assistant_message: SECRET,
    stop_reason: "end_turn",
  });
}

test("under Copilot, a Stop for the session's own turn is owned by the session, with no socket", () => {
  assert.deepEqual(firingIn(readFiring(copilotStopText(COPILOT_PARENT), UNDER_COPILOT)), {
    event: "Stop",
    directory: "/work/repo",
    owner: { sessionId: COPILOT_PARENT },
  });
});

test("under Copilot, a SubagentStop is owned by the parent session, with no socket, and names the subagent", () => {
  assert.deepEqual(firingIn(readFiring(copilotSubagentStopText(), UNDER_COPILOT)), {
    event: "SubagentStop",
    directory: "/work/repo",
    owner: { sessionId: COPILOT_PARENT },
    subagent: COPILOT_SUBAGENT,
  });
});

test("a Copilot Stop whose session_id is not its transcript's session is a subagent's turn", () => {
  // Copilot fires it for a subagent's turn just before that subagent's
  // SubagentStop, which is the firing that names the work.
  for (const environment of [UNDER_COPILOT, {}]) {
    assert.deepEqual(readFiring(copilotStopText(COPILOT_SUBAGENT), environment), { outcome: "a subagent's turn" });
  }
});

test("a Claude Code Stop is read whatever session its transcript's file name gives", () => {
  const other = "0f1e2d3c-4b5a-6978-8a9b-acbdcedf0011";
  for (const path of [`/Users/someone/.claude/projects/-work-repo/${other}.jsonl`, `/transcripts/${other}/events.jsonl`]) {
    assert.deepEqual(firingIn(readFiring(stopText({ transcript_path: path }), WITH_SOCKET)), {
      event: "Stop",
      directory: DIRECTORY,
      owner: { sessionId: SESSION_ID, socket: SOCKET },
    });
  }
});
