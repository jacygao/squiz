import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { CLAUDE_CODE_STOP, COPILOT_STOP, COPILOT_SUBAGENT_STOP } from "../testing/stop-payloads.ts";
import { readFiring, readFiringWithSocket, type Firing, type FiringRead, type HookEnvironment, type Owner } from "./firing.ts";

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

function ownerIn(read: FiringRead): Owner {
  const firing = firingIn(read);
  assert.ok("owner" in firing, `the firing names no owner: ${JSON.stringify(firing)}`);
  return firing.owner;
}

function reasonFrom(read: FiringRead): string {
  assert.equal(read.outcome, "unreadable", `the payload was read: ${JSON.stringify(read)}`);
  const reason = read.outcome === "unreadable" ? read.reason : "";
  assert.equal(reason.includes(SECRET), false, `the reason carries the payload's text: ${reason}`);
  return reason;
}

test("on Stop, the owner is the session itself, with its socket, and its final message and transcript", () => {
  assert.deepEqual(firingIn(readFiring(stopText(), WITH_SOCKET)), {
    event: "Stop",
    directory: DIRECTORY,
    owner: { sessionId: SESSION_ID, socket: SOCKET },
    lastMessage: SECRET,
    transcript: `/transcripts/${SESSION_ID}.jsonl`,
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
    lastMessage: SECRET,
    transcript: `/transcripts/${SESSION_ID}/subagents/agent-${AGENT_ID}.jsonl`,
  });
});

test("a SubagentStop with no last_assistant_message is still read whole, with its transcript", () => {
  // An older CLI, or another runtime, sends no last message. Nothing else about
  // the firing depends on it.
  const text = subagentStopText();
  const { last_assistant_message: _dropped, ...rest } = JSON.parse(text) as Record<string, unknown>;

  assert.deepEqual(firingIn(readFiring(JSON.stringify(rest), WITH_SOCKET)), {
    event: "SubagentStop",
    directory: DIRECTORY,
    owner: { sessionId: SESSION_ID, socket: SOCKET },
    subagent: AGENT_ID,
    transcript: `/transcripts/${SESSION_ID}/subagents/agent-${AGENT_ID}.jsonl`,
  });
});

test("a SubagentStop whose last message or transcript is not a non-empty string is read without it, rather than refused", () => {
  for (const value of [null, 7, "", { text: "done" }]) {
    const firing = firingIn(readFiring(subagentStopText({ last_assistant_message: value, agent_transcript_path: value }), WITH_SOCKET));

    assert.deepEqual(firing, {
      event: "SubagentStop",
      directory: DIRECTORY,
      owner: { sessionId: SESSION_ID, socket: SOCKET },
      subagent: AGENT_ID,
    }, `read with both fields as ${JSON.stringify(value)}`);
  }
});

test("a SubagentStop's transcript is kept only as an absolute path", () => {
  const firing = firingIn(readFiring(subagentStopText({ agent_transcript_path: "subagents/agent.jsonl" }), WITH_SOCKET));

  assert.equal("transcript" in firing, false, `a relative transcript path was kept: ${JSON.stringify(firing)}`);
});


test("an environment with no messaging socket gives an owner with no socket", () => {
  for (const environment of [{}, { CLAUDE_CODE_MESSAGING_SOCKET: undefined }]) {
    for (const text of [stopText(), subagentStopText()]) {
      const owner = ownerIn(readFiring(text, environment));
      assert.equal("socket" in owner, false, `a socket was given: ${JSON.stringify(owner)}`);
    }
  }
});

test("an empty messaging socket is no socket, rather than one a post would try", () => {
  for (const text of [stopText(), subagentStopText()]) {
    const owner = ownerIn(readFiring(text, { CLAUDE_CODE_MESSAGING_SOCKET: "" }));
    assert.equal("socket" in owner, false, `a socket was given: ${JSON.stringify(owner)}`);
  }
});

test("a socket named in the payload is not read", () => {
  const text = stopText({ CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/1.sock", socket: "/tmp/x.sock" });

  const owner = ownerIn(readFiring(text, {}));

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
      lastMessage: SECRET,
      transcript: `/transcripts/${SESSION_ID}.jsonl`,
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
    transcript: COPILOT_TRANSCRIPT,
  });
});

test("under Copilot, a SubagentStop is owned by the parent session, with no socket, and names the subagent", () => {
  // Copilot's carries a last message and no agent_transcript_path.
  assert.deepEqual(firingIn(readFiring(copilotSubagentStopText(), UNDER_COPILOT)), {
    event: "SubagentStop",
    directory: "/work/repo",
    owner: { sessionId: COPILOT_PARENT },
    subagent: COPILOT_SUBAGENT,
    lastMessage: SECRET,
    parentTranscript: COPILOT_TRANSCRIPT,
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
      lastMessage: SECRET,
      transcript: path,
    });
  }
});

/**
 * Run `body` with a scratch Copilot home, and remove it after.
 *
 * It is under `/tmp` rather than the system's temporary directory, whose path
 * on macOS is long enough that a socket under a session's state directory would
 * pass the 104 bytes a socket path may take.
 */
async function withCopilotHome(body: (home: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync("/tmp/squiz-ch-");
  try {
    await body(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** `text`, a payload, with its `transcript_path` the events file of `sessionId` under `home`. */
function transcriptUnder(home: string, sessionId: string, text: string): string {
  const fields = JSON.parse(text) as Record<string, unknown>;
  return JSON.stringify({ ...fields, transcript_path: join(home, "session-state", sessionId, "events.jsonl") });
}

/** A server listening at `path`, standing in for squiz's Copilot extension. */
async function listeningAt(path: string): Promise<Server> {
  mkdirSync(dirname(path), { recursive: true });
  const server = createServer((socket) => socket.resume());
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

test("under Copilot, the owner's socket is the one squiz's extension listens on beside the session's transcript", async () => {
  await withCopilotHome(async (home) => {
    const path = join(home, "session-state", COPILOT_PARENT, "squiz.sock");
    const server = await listeningAt(path);
    try {
      const stop = transcriptUnder(home, COPILOT_PARENT, copilotStopText(COPILOT_PARENT));
      const subagentStop = transcriptUnder(home, COPILOT_PARENT, copilotSubagentStopText());

      const transcript = join(home, "session-state", COPILOT_PARENT, "events.jsonl");
      assert.deepEqual(firingIn(await readFiringWithSocket(stop, UNDER_COPILOT)), {
        event: "Stop",
        directory: "/work/repo",
        owner: { sessionId: COPILOT_PARENT, socket: path },
        transcript,
      });
      // A subagent runs inside its parent's process, so the parent's extension is the one to wake.
      assert.deepEqual(firingIn(await readFiringWithSocket(subagentStop, UNDER_COPILOT)), {
        event: "SubagentStop",
        directory: "/work/repo",
        owner: { sessionId: COPILOT_PARENT, socket: path },
        subagent: COPILOT_SUBAGENT,
        lastMessage: SECRET,
        parentTranscript: transcript,
      });
    } finally {
      await closed(server);
    }
  });
});

test("under Copilot with no extension listening, the owner has no socket, even one its environment carries", async () => {
  await withCopilotHome(async (home) => {
    const stop = transcriptUnder(home, COPILOT_PARENT, copilotStopText(COPILOT_PARENT));
    const owners = [];
    // Nothing at the path, as in a session started without experimental features.
    owners.push(ownerIn(await readFiringWithSocket(stop, UNDER_COPILOT)));
    // A file nothing listens on, as an extension that was killed leaves.
    mkdirSync(join(home, "session-state", COPILOT_PARENT), { recursive: true });
    writeFileSync(join(home, "session-state", COPILOT_PARENT, "squiz.sock"), "", "utf8");
    owners.push(ownerIn(await readFiringWithSocket(stop, UNDER_COPILOT)));

    assert.deepEqual(owners, [{ sessionId: COPILOT_PARENT }, { sessionId: COPILOT_PARENT }]);
  });
});

test("under Copilot, a transcript that is not the owner's session's names no socket, wherever one listens", async () => {
  await withCopilotHome(async (home) => {
    // Beside each transcript below, so that a socket found there would be recorded.
    const servers = [
      await listeningAt(join(home, "transcripts", "squiz.sock")),
      await listeningAt(join(home, "session-state", COPILOT_SUBAGENT, "squiz.sock")),
      await listeningAt(join(home, "squiz.sock")),
    ];
    try {
      const fields = JSON.parse(copilotSubagentStopText()) as Record<string, unknown>;
      const texts = [
        JSON.stringify({ ...fields, transcript_path: undefined }),
        JSON.stringify({ ...fields, transcript_path: join(home, "transcripts", `${COPILOT_PARENT}.jsonl`) }),
        transcriptUnder(home, COPILOT_SUBAGENT, copilotSubagentStopText()),
        JSON.stringify({ ...fields, session_id: "..", transcript_path: `${home}/session-state/../events.jsonl` }),
      ];
      const owners = [];
      for (const text of texts) owners.push(ownerIn(await readFiringWithSocket(text, UNDER_COPILOT)));

      assert.deepEqual(owners, [
        { sessionId: COPILOT_PARENT },
        { sessionId: COPILOT_PARENT },
        { sessionId: COPILOT_PARENT },
        { sessionId: ".." },
      ]);
    } finally {
      for (const server of servers) await closed(server);
    }
  });
});

test("outside Copilot, the owner's socket is its environment's, whatever listens beside a Copilot transcript", async () => {
  await withCopilotHome(async (home) => {
    const server = await listeningAt(join(home, "session-state", SESSION_ID, "squiz.sock"));
    try {
      const read = await readFiringWithSocket(transcriptUnder(home, SESSION_ID, stopText()), WITH_SOCKET);

      assert.deepEqual(ownerIn(read), { sessionId: SESSION_ID, socket: SOCKET });
    } finally {
      await closed(server);
    }
  });
});

test("a payload with no firing in it reads the same with the socket looked for", async () => {
  for (const text of [copilotStopText(COPILOT_SUBAGENT), phantomText(), "not json"]) {
    assert.deepEqual(await readFiringWithSocket(text, UNDER_COPILOT), readFiring(text, UNDER_COPILOT));
  }
});

/** A `SessionStart` firing as Claude Code writes it, for a session started fresh or resumed. */
function sessionStartText(over: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    session_id: SESSION_ID,
    transcript_path: `/transcripts/${SESSION_ID}.jsonl`,
    cwd: DIRECTORY,
    hook_event_name: "SessionStart",
    source: "startup",
    ...over,
  });
}

/** A `SubagentStart` firing as Claude Code writes it. */
function subagentStartText(over: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    session_id: SESSION_ID,
    transcript_path: `/transcripts/${SESSION_ID}.jsonl`,
    cwd: DIRECTORY,
    hook_event_name: "SubagentStart",
    agent_id: AGENT_ID,
    agent_type: "general-purpose",
    ...over,
  });
}

/** Copilot's `SubagentStart`, which names the session in camelCase and has no `session_id`. */
/**
 * Copilot 1.0.107's `SubagentStart` through the plugin's Claude-format
 * registration, as captured: no `hook_event_name`, and the session in camelCase.
 */
const COPILOT_SUBAGENT_START =
  '{"sessionId":"f1a68b9a-73c2-42c1-ac30-8882b95ebe78","timestamp":1794041278779,"cwd":"/abs/proj","transcriptPath":"/Users/x/.copilot/session-state/f1a68b9a-73c2-42c1-ac30-8882b95ebe78/events.jsonl","agentName":"general-purpose","agent_id":"a8be9a13-9ff3-42eb-9fad-059e10c0037d","agent_type":"general-purpose","parent_agent_id":"f1a68b9a-73c2-42c1-ac30-8882b95ebe78"}';

/** The captured payload with `over` laid on it, a field set to `undefined` dropped. */
function copilotSubagentStartWith(over: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ ...(JSON.parse(COPILOT_SUBAGENT_START) as Record<string, unknown>), ...over });
}

test("a SessionStart and a SubagentStart are read as starts in the payload's cwd, with no owner", () => {
  for (const source of ["startup", "resume", "clear", "compact"]) {
    assert.deepEqual(firingIn(readFiring(sessionStartText({ source }), WITH_SOCKET)), { event: "SessionStart", directory: DIRECTORY });
  }
  assert.deepEqual(firingIn(readFiring(subagentStartText(), WITH_SOCKET)), { event: "SubagentStart", directory: DIRECTORY });
});

test("a start needs no session_id, and Copilot's SubagentStart, which has none, is read", async () => {
  assert.deepEqual(firingIn(readFiring(sessionStartText({ session_id: undefined }), WITH_SOCKET)), {
    event: "SessionStart",
    directory: DIRECTORY,
  });
});

test("Copilot's SubagentStart, which has no hook_event_name, is read as a start in its cwd", async () => {
  assert.deepEqual(firingIn(await readFiringWithSocket(COPILOT_SUBAGENT_START, UNDER_COPILOT)), {
    event: "SubagentStart",
    directory: "/abs/proj",
  });
});

test("a payload with no hook_event_name is a start only with agentName, sessionId and an absolute cwd, and never a stop", () => {
  for (const over of [
    { agentName: undefined },
    { agentName: "" },
    { sessionId: undefined },
    { cwd: undefined },
    { cwd: "abs/proj" },
    // A stop's own fields name no event either way.
    { agentName: undefined, session_id: SESSION_ID, last_assistant_message: SECRET },
  ]) {
    const read = readFiring(copilotSubagentStartWith(over), UNDER_COPILOT);
    assert.equal(read.outcome, "unreadable", `${JSON.stringify(over)} was read as ${JSON.stringify(read)}`);
  }
  const stopFields = readFiring(copilotSubagentStartWith({ session_id: SESSION_ID, stop_reason: "end_turn" }), UNDER_COPILOT);
  assert.deepEqual(stopFields, { outcome: "read", firing: { event: "SubagentStart", directory: "/abs/proj" } });
});

test("a start carrying no usable cwd is unreadable, since the worktree is resolved from it", () => {
  for (const cwd of [undefined, "", 42, null, "work/session-directory"]) {
    for (const text of [sessionStartText({ cwd }), subagentStartText({ cwd })]) {
      assert.match(reasonFrom(readFiring(text, WITH_SOCKET)), /cwd/u, `for ${JSON.stringify(cwd)}`);
    }
  }
});

test("#859: Claude Code 2.1.321's Stop is read with the session's final message and transcript", () => {
  assert.deepEqual(firingIn(readFiring(CLAUDE_CODE_STOP, WITH_SOCKET)), {
    event: "Stop",
    directory: "/private/tmp/claude-501/-Users-jacy-Documents-Dev-squiz/b40470cd-5c98-41d6-a7ef-16382cebe8d8/scratchpad/issue-859/repo",
    owner: { sessionId: "1525f1a6-f15f-4e61-b7cd-3e0ddc344528", socket: SOCKET },
    lastMessage: "DONE",
    transcript: "/Users/jacy/.claude/projects/-private-tmp-claude-501--Users-jacy-Documents-Dev-squiz-b40470cd-5c98-41d6-a7ef-16382cebe8d8-scratchpad-issue-859-repo/1525f1a6-f15f-4e61-b7cd-3e0ddc344528.jsonl",
  });
});

test("#859: Copilot 1.0.110's Stop, which carries no final message, is read with the session's transcript alone", () => {
  assert.deepEqual(firingIn(readFiring(COPILOT_STOP, UNDER_COPILOT)), {
    event: "Stop",
    directory: "/private/tmp/claude-501/-Users-jacy-Documents-Dev-squiz/b40470cd-5c98-41d6-a7ef-16382cebe8d8/scratchpad/issue-859/repo",
    owner: { sessionId: "af7a1b25-6bdc-459f-99e1-5c3ab2513f83" },
    transcript: "/Users/jacy/.copilot/session-state/af7a1b25-6bdc-459f-99e1-5c3ab2513f83/events.jsonl",
  });
});

test("#859: a Stop whose final message or transcript is malformed is read without that field alone", () => {
  for (const value of [null, 7, "", { text: "done" }, "relative/transcript.jsonl"]) {
    const message = firingIn(readFiring(stopText({ last_assistant_message: value }), WITH_SOCKET));
    assert.deepEqual(message, {
      event: "Stop",
      directory: DIRECTORY,
      owner: { sessionId: SESSION_ID, socket: SOCKET },
      ...(typeof value === "string" && value !== "" ? { lastMessage: value } : {}),
      transcript: `/transcripts/${SESSION_ID}.jsonl`,
    }, `read with the last message as ${JSON.stringify(value)}`);

    const transcript = firingIn(readFiring(stopText({ transcript_path: value }), WITH_SOCKET));
    assert.deepEqual(transcript, {
      event: "Stop",
      directory: DIRECTORY,
      owner: { sessionId: SESSION_ID, socket: SOCKET },
      lastMessage: SECRET,
    }, `read with the transcript as ${JSON.stringify(value)}`);
  }
});

test("#859: Copilot 1.0.110's SubagentStop names the parent's events.jsonl as where the subagent's events are", () => {
  assert.deepEqual(firingIn(readFiring(COPILOT_SUBAGENT_STOP, UNDER_COPILOT)), {
    event: "SubagentStop",
    directory: "/private/tmp/claude-501/-Users-jacy-Documents-Dev-squiz/b40470cd-5c98-41d6-a7ef-16382cebe8d8/scratchpad/issue-859/repo",
    owner: { sessionId: "af7a1b25-6bdc-459f-99e1-5c3ab2513f83" },
    subagent: "dcc0b994-3d65-4ad3-92f3-ccf70b8232d5",
    lastMessage: "PONG",
    parentTranscript: "/Users/jacy/.copilot/session-state/af7a1b25-6bdc-459f-99e1-5c3ab2513f83/events.jsonl",
  });
});

// A guard for existing behaviour: Claude Code's transcript_path is the parent's, and its subagent has a transcript of its own.
test("a Claude Code SubagentStop names no parent's transcript", () => {
  assert.equal("parentTranscript" in firingIn(readFiring(subagentStopText(), WITH_SOCKET)), false);
});
