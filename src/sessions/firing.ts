/**
 * A `Stop` or `SubagentStop` hook's payload, read into the session that owns the
 * work that just ended.
 *
 * The owner is the session in the payload's `session_id`. On `Stop` that is the
 * session whose turn ended. On `SubagentStop` it is the session that dispatched
 * the subagent, and the subagent is named from `agent_id`. Under Claude Code the
 * owner's messaging socket comes from the hook's environment and never from the
 * payload. A
 * subagent runs inside its parent's process, so on `SubagentStop` the socket is
 * the parent's.
 *
 * A hook whose environment carries `COPILOT_CLI` runs under Copilot, and its
 * owner's socket is never the environment's. Copilot puts none in a hook's
 * environment, so one found there belongs to a Claude Code session that started
 * Copilot, and a wake through it would reach that session instead.
 *
 * A `Stop` whose `session_id` is not the session its transcript path names is a
 * subagent's turn. Copilot fires one just before that subagent's
 * `SubagentStop`, with the subagent's id and the parent's transcript. The
 * `SubagentStop` names the work, and read as it stands this firing would make
 * the subagent the owner.
 *
 * The directory is the payload's `cwd`, the session's directory. The hook's own
 * working directory is not it under Copilot, which runs a plugin's hook in the
 * plugin root.
 *
 * A `SubagentStop` whose `agent_type` is the empty string is none of the
 * session's subagents: an interactive session fires a few after a turn ends,
 * with no transcript behind them. One with no `agent_type` at all is read as a
 * subagent's, since the field's absence marks no firing apart.
 *
 * Nothing here throws, and no reason carries the payload's text: a subagent's
 * last message is in there.
 */

import { dirname, isAbsolute, join } from "node:path";

import { listening } from "./messaging.ts";

export type Owner = {
  readonly sessionId: string;
  /** Absent where no socket reaches the owner. */
  readonly socket?: string;
};

export type Firing =
  | { readonly event: "Stop"; readonly directory: string; readonly owner: Owner }
  | { readonly event: "SubagentStop"; readonly directory: string; readonly owner: Owner; readonly subagent: string };

export type FiringRead =
  | { readonly outcome: "read"; readonly firing: Firing }
  | { readonly outcome: "no subagent's work" }
  | { readonly outcome: "a subagent's turn" }
  | { readonly outcome: "unreadable"; readonly reason: string };

export type HookEnvironment = Readonly<Record<string, string | undefined>>;

/** Read `text`, a hook's payload, with `environment`, the hook's own. */
export function readFiring(text: string, environment: HookEnvironment): FiringRead {
  if (text.trim() === "") return unreadable("the hook was given no payload");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The parser's message quotes the text it choked on.
    return unreadable("the payload is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return unreadable("the payload is not a JSON object");
  }
  const payload = parsed as Readonly<Record<string, unknown>>;

  const event = payload["hook_event_name"];
  if (event !== "Stop" && event !== "SubagentStop") {
    return unreadable('the payload\'s "hook_event_name" is neither Stop nor SubagentStop');
  }

  const agentType = payload["agent_type"];
  if (event === "SubagentStop") {
    if (agentType === "") return { outcome: "no subagent's work" };
    if (agentType !== undefined && typeof agentType !== "string") {
      return unreadable('the payload\'s "agent_type" is not a string');
    }
  }

  const sessionId = payload["session_id"];
  if (typeof sessionId !== "string" || sessionId === "") {
    return unreadable('the payload carries no "session_id", which names the owner');
  }
  const socket = underCopilot(environment) ? undefined : environment["CLAUDE_CODE_MESSAGING_SOCKET"];
  const owner: Owner = socket === undefined || socket === "" ? { sessionId } : { sessionId, socket };

  if (event === "Stop") {
    const named = transcriptSession(payload["transcript_path"]);
    if (named !== undefined && named !== sessionId) return { outcome: "a subagent's turn" };
  }

  const directory = payload["cwd"];
  // A relative path would be resolved against the hook's own directory.
  if (typeof directory !== "string" || !isAbsolute(directory)) {
    return unreadable('the payload carries no absolute "cwd", which the worktree is resolved from');
  }
  if (event === "Stop") return { outcome: "read", firing: { event, directory, owner } };

  const agentId = payload["agent_id"];
  if (typeof agentId !== "string" || agentId === "") {
    return unreadable('the payload carries no "agent_id", which names the subagent');
  }
  return { outcome: "read", firing: { event, directory, owner, subagent: agentId } };
}

/**
 * Read `text` as `readFiring` does, and under Copilot give the owner the socket
 * squiz's extension listens on in its session, where one accepts a connection.
 *
 * The extension runs only in a session started with Copilot's experimental
 * features on. It listens on `squiz.sock` in the session's state directory,
 * the directory of the transcript a firing for the session names. A socket is
 * recorded only once a connection to it has been accepted, so a session
 * without the extension, or one whose extension died, records none.
 */
export async function readFiringWithSocket(text: string, environment: HookEnvironment): Promise<FiringRead> {
  const read = readFiring(text, environment);
  if (read.outcome !== "read" || !underCopilot(environment)) return read;
  const { sessionId } = read.firing.owner;
  const socket = extensionSocket(text, sessionId);
  if (socket === undefined || !(await listening(socket, PROBE_BOUND_MS))) return read;
  return { outcome: "read", firing: { ...read.firing, owner: { sessionId, socket } } };
}

// Copilot waits on its Stop hook before the session goes idle, so a socket that
// does not answer at once costs the session no more than this.
const PROBE_BOUND_MS = 1_000;

/**
 * Where squiz's extension listens for `sessionId`, or none where the payload in
 * `text` names no Copilot transcript of that session's.
 *
 * Copilot's own `COPILOT_HOME` is not in a hook's environment unless the user
 * set it, and `--config-dir` moves the directory without it, so the transcript
 * is the one place that says where the session's directory is.
 */
function extensionSocket(text: string, sessionId: string): string | undefined {
  // `readFiring` has already read `text` as a JSON object.
  const transcript = (JSON.parse(text) as Readonly<Record<string, unknown>>)["transcript_path"];
  if (typeof transcript !== "string" || !isAbsolute(transcript)) return undefined;
  // ".." would put the socket outside every session's directory.
  if (sessionId === "." || sessionId === ".." || transcriptSession(transcript) !== sessionId) return undefined;
  return join(dirname(transcript), "squiz.sock");
}

function underCopilot(environment: HookEnvironment): boolean {
  const flag = environment["COPILOT_CLI"];
  return flag !== undefined && flag !== "";
}

/**
 * The session a Copilot transcript path, `.../session-state/<id>/events.jsonl`,
 * names, or `undefined` for any other path.
 *
 * A Claude Code path names none. Its file is named for the session, but Claude
 * Code fires no `Stop` for a subagent's turn, so reading it could only drop a
 * turn whose file was named for another session.
 */
function transcriptSession(path: unknown): string | undefined {
  if (typeof path !== "string") return undefined;
  return /\/session-state\/([^/]+)\/events\.jsonl$/u.exec(path)?.[1];
}

function unreadable(reason: string): FiringRead {
  return { outcome: "unreadable", reason };
}
