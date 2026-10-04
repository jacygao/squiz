/**
 * A `Stop` or `SubagentStop` hook's payload, read into the session that owns the
 * work that just ended.
 *
 * The owner is the session in the payload's `session_id`. On `Stop` that is the
 * session whose turn ended. On `SubagentStop` it is the session that dispatched
 * the subagent, and the subagent is named from `agent_id`. The owner's messaging
 * socket comes from the hook's environment and never from the payload. A
 * subagent runs inside its parent's process, so on `SubagentStop` the socket is
 * the parent's.
 *
 * A `SubagentStop` whose `agent_type` is the empty string is none of the
 * session's subagents: an interactive session fires a few after a turn ends,
 * with no transcript behind them. One with no `agent_type` at all is read as a
 * subagent's, since the field's absence marks no firing apart.
 *
 * Nothing here throws, and no reason carries the payload's text: a subagent's
 * last message is in there.
 */

export type Owner = {
  readonly sessionId: string;
  /** Absent where the hook's environment named no socket, or an empty one. */
  readonly socket?: string;
};

export type Firing =
  | { readonly event: "Stop"; readonly owner: Owner }
  | { readonly event: "SubagentStop"; readonly owner: Owner; readonly subagent: string };

export type FiringRead =
  | { readonly outcome: "read"; readonly firing: Firing }
  | { readonly outcome: "no subagent's work" }
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
  const socket = environment["CLAUDE_CODE_MESSAGING_SOCKET"];
  const owner: Owner = socket === undefined || socket === "" ? { sessionId } : { sessionId, socket };

  if (event === "Stop") return { outcome: "read", firing: { event, owner } };

  const agentId = payload["agent_id"];
  if (typeof agentId !== "string" || agentId === "") {
    return unreadable('the payload carries no "agent_id", which names the subagent');
  }
  return { outcome: "read", firing: { event, owner, subagent: agentId } };
}

function unreadable(reason: string): FiringRead {
  return { outcome: "unreadable", reason };
}
