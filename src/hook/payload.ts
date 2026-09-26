/**
 * The `SubagentStop` payload, as the runtime writes it to the hook's stdin.
 *
 * One field is read from it. `agent_id` is the subagent's own: the same string
 * every time that subagent stops, and different for every subagent. It is the
 * episode's key.
 *
 * Three other fields look usable and are not. `prompt_id` is per user turn in
 * the parent session, so it is one string for every subagent running under that
 * turn and a different one between one subagent's own stops. `cwd` is the
 * session's directory rather than the worktree. `stop_hook_active` is true from
 * the second firing of an episode onward, which is every firing where the loop
 * means to block, so reading it as a reason to stop would cap every episode at
 * one round.
 *
 * Nothing here throws, and no failure carries the payload's text: a subagent's
 * last message is in there, and the one line a failure is reported as has no
 * room for it.
 */

/** What the harness reads from one firing. */
export type Payload = {
  /** The subagent's id, exactly as it arrived. */
  readonly agentId: string;
};

/** The payload read, or why nothing could be read from it. */
export type PayloadRead =
  | { readonly outcome: "read"; readonly payload: Payload }
  | { readonly outcome: "unreadable"; readonly reason: string };

/** The hook's stdin. The payload arrives on it and nothing else does. */
export type PayloadStream = AsyncIterable<string | Uint8Array> & {
  readonly isTTY?: boolean | undefined;
};

/**
 * Read the payload `stream` carries.
 *
 * A stdin that is a terminal is nobody's payload: the hook was run by hand, and
 * reading to the end of input would hold the coding agent's turn open until the
 * runtime killed the hook. It comes back as unreadable without anything being
 * read.
 */
export async function readPayloadFrom(stream: PayloadStream): Promise<PayloadRead> {
  if (stream.isTTY === true) {
    return unreadable("the hook was given no payload, because its stdin is a terminal");
  }

  const chunks: Buffer[] = [];
  try {
    for await (const chunk of stream) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
    }
  } catch (cause) {
    return unreadable(`the payload could not be read from stdin: ${reasonFor(cause)}`);
  }
  // Decoded once the whole of it has arrived. A character spanning two chunks
  // decoded per chunk would come out as two replacements.
  return readPayload(Buffer.concat(chunks).toString("utf8"));
}

/** Read `text` as a payload, on the same terms as reading it from stdin. */
export function readPayload(text: string): PayloadRead {
  if (text.trim() === "") return unreadable("the hook was given no payload on stdin");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // What the parser says about it quotes the text it choked on, which is the
    // one thing this may not put on stderr.
    return unreadable("the payload is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return unreadable("the payload is not a JSON object");
  }

  const agentId: unknown = (parsed as Readonly<Record<string, unknown>>)["agent_id"];
  if (typeof agentId !== "string" || agentId === "") {
    return unreadable('the payload carries no "agent_id", which is the episode\'s key');
  }
  return { outcome: "read", payload: { agentId } };
}

function unreadable(reason: string): PayloadRead {
  return { outcome: "unreadable", reason };
}

function reasonFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
