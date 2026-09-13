/**
 * `pi`'s stdout, read one line at a time and turned into the events its
 * consumers asked for.
 *
 * The stream runs to tens of megabytes, and its bulk and its largest line are
 * different events. Almost every line is a small `message_update` delta, and
 * the largest single line is `agent_end`, which repeats the whole transcript
 * and which nothing reads. So a line's type is read from its first bytes,
 * before `JSON.parse`, and a line no consumer wants is dropped as it arrives
 * rather than assembled and then thrown away. What is held at once is one
 * wanted line, never the stream.
 *
 * Nothing here interprets an event. What a cost is and what a finding is belong
 * to the code that consumes these.
 */

/** The four dollar figures `pi` priced a message at, and their sum. */
export type PiCost = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly total: number;
};

/** What one message spent, in tokens and in dollars. */
export type PiUsage = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /** A subset of `output`, not an addition to it. Absent on a model that does not reason. */
  readonly reasoning?: number;
  readonly totalTokens: number;
  readonly cost: PiCost;
};

/**
 * One block of a message's content.
 *
 * `text`, `thinking` and `toolCall` are what a clean run emits, and the fields
 * under each differ by type. Reading one is the consumer's, which is why every
 * field but the discriminant arrives as `unknown`.
 */
export type PiContentBlock = {
  readonly type: string;
  readonly [field: string]: unknown;
};

/** A message `pi` finished, as much of it as any consumer reads. */
export type PiMessage = {
  /** `user`, `assistant` or `toolResult`. A role this has never seen is carried, not refused. */
  readonly role: string;
  readonly content: readonly PiContentBlock[];
  readonly stopReason?: string;
  /** Why a message stopped with `stopReason` of `error`. `pi` writes nothing to stderr. */
  readonly errorMessage?: string;
  readonly model?: string;
  /** Only an assistant message carries one. */
  readonly usage?: PiUsage;
};

/** A message `pi` finished, whoever it was from. */
export type MessageEnd = {
  readonly type: "message_end";
  readonly message: PiMessage;
};

/** The reviewer reached for a tool. */
export type ToolExecutionStart = {
  readonly type: "tool_execution_start";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
};

/**
 * The tool answered.
 *
 * The answer itself is not carried. It is the tool's whole output, and progress
 * is what these two events are read for.
 */
export type ToolExecutionEnd = {
  readonly type: "tool_execution_end";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly isError: boolean;
};

/**
 * A line the reader could not turn into an event.
 *
 * It is reported rather than thrown, and the stream carries on. What an
 * unreadable line means for the round is the caller's decision.
 */
export type Unreadable = {
  readonly type: "unreadable";
  readonly reason: string;
};

export type PiEvent = MessageEnd | ToolExecutionStart | ToolExecutionEnd | Unreadable;

/** The first key of every line `pi` emits, and what the discriminator reads. */
const TYPE_MARKER = '{"type":"';

/**
 * How far past the marker a type name may run before the line is judged not to
 * be an event. The longest `pi` emits is `tool_execution_start`, at 20.
 */
const TYPE_NAME_LIMIT = 32;

/** As much of a line as a reason quotes, and as much as the discriminator reads. */
const EXCERPT_LIMIT = TYPE_MARKER.length + TYPE_NAME_LIMIT + 1;

/**
 * The events a consumer asked for. Every other type is dropped unparsed.
 *
 * `agent_end` is the one that matters: it repeats the whole transcript, it is
 * the largest line in the stream, and `pi` emits a fresh one for every attempt
 * it makes at a failed request.
 */
const wanted: ReadonlySet<string> = new Set([
  "message_end",
  "tool_execution_start",
  "tool_execution_end",
]);

/** What is being done with the line arriving now. */
type Mode = "deciding" | "keeping" | "skipping" | "unreadable";

/**
 * Read `pi`'s stdout as the events its consumers asked for.
 *
 * Chunks arrive at whatever size the stream hands over, split mid-line and
 * mid-character. Nothing accumulates across lines: an unwanted line is dropped
 * as its bytes arrive, so the transcript `agent_end` carries is never held.
 *
 * A line that is not an event yields `unreadable` and the stream continues.
 * Nothing here throws on the stream's content; a stream that fails at the
 * source still raises through the iteration.
 */
export async function* readEvents(
  stdout: AsyncIterable<string | Uint8Array>,
): AsyncGenerator<PiEvent> {
  const decoder = new TextDecoder();
  let kept = "";
  let mode: Mode = "deciding";

  /**
   * What to do with the line, decided from as much of its head as has arrived.
   *
   * `agent_start` and `agent_settled` share a prefix, as do `message_start`,
   * `message_update` and `message_end`, so the name is read to its closing
   * quote and never guessed from fewer bytes.
   */
  const decide = (): Mode => {
    if (kept.length < TYPE_MARKER.length) {
      return TYPE_MARKER.startsWith(kept) ? "deciding" : "unreadable";
    }
    if (!kept.startsWith(TYPE_MARKER)) return "unreadable";
    const close = kept.indexOf('"', TYPE_MARKER.length);
    if (close === -1) {
      return kept.length < EXCERPT_LIMIT ? "deciding" : "unreadable";
    }
    return wanted.has(kept.slice(TYPE_MARKER.length, close)) ? "keeping" : "skipping";
  };

  const take = (piece: string): void => {
    if (mode === "skipping" || mode === "unreadable") return;
    if (mode === "keeping") {
      kept += piece;
      return;
    }
    // Only the head is held while the line is undecided, so that a chunk
    // carrying a whole agent_end is dropped rather than held and then dropped.
    const head = piece.slice(0, EXCERPT_LIMIT - kept.length);
    kept += head;
    mode = decide();
    if (mode === "skipping") kept = "";
    if (mode === "keeping") kept += piece.slice(head.length);
  };

  const complete = (): PiEvent | undefined => {
    const line = kept;
    const decided = mode;
    kept = "";
    mode = "deciding";
    if (decided === "keeping") return interpret(line);
    if (decided === "unreadable") return notAnEvent(line);
    // The newline that ends the last line leaves an empty one behind it.
    if (decided === "deciding" && line !== "") return notAnEvent(line);
    return undefined;
  };

  for await (const chunk of stdout) {
    const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let from = 0;
    for (;;) {
      const newline = text.indexOf("\n", from);
      if (newline === -1) {
        take(text.slice(from));
        break;
      }
      take(text.slice(from, newline));
      const event = complete();
      if (event !== undefined) yield event;
      from = newline + 1;
    }
  }

  // A multi-byte character the last chunk cut in half.
  take(decoder.decode());
  const last = complete();
  if (last !== undefined) yield last;
}

/** A wanted line, parsed and read as the event its type says it is. */
function interpret(line: string): PiEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { type: "unreadable", reason: `a line is not JSON: ${excerptOf(line)}` };
  }
  const event = recordOf(parsed);
  if (event === null) {
    return { type: "unreadable", reason: `a line is not an object: ${excerptOf(line)}` };
  }
  switch (event["type"]) {
    case "message_end": {
      const message = messageOf(event["message"]);
      if (message === null) return incomplete("message_end", "a message", line);
      return { type: "message_end", message };
    }
    case "tool_execution_start": {
      const toolCallId = textOf(event["toolCallId"]);
      const toolName = textOf(event["toolName"]);
      if (toolCallId === null || toolName === null) {
        return incomplete("tool_execution_start", "a tool call id and a tool name", line);
      }
      return { type: "tool_execution_start", toolCallId, toolName, args: event["args"] };
    }
    case "tool_execution_end": {
      const toolCallId = textOf(event["toolCallId"]);
      const toolName = textOf(event["toolName"]);
      const isError = event["isError"];
      if (toolCallId === null || toolName === null || typeof isError !== "boolean") {
        return incomplete(
          "tool_execution_end",
          "a tool call id, a tool name and an error flag",
          line,
        );
      }
      return { type: "tool_execution_end", toolCallId, toolName, isError };
    }
    // A second `type` key is the one way a kept line reads as another event:
    // the discriminator takes the first, and JSON.parse keeps the last.
    default:
      return {
        type: "unreadable",
        reason: `a line carries a second type: ${excerptOf(line)}`,
      };
  }
}

/**
 * A message read as the fields a consumer needs, or `null` where it is not one.
 *
 * The content blocks come through whole and everything else is dropped. A
 * message carries its own timestamps and request ids, and nothing reads them.
 */
function messageOf(value: unknown): PiMessage | null {
  const record = recordOf(value);
  if (record === null) return null;

  const role = textOf(record["role"]);
  if (role === null) return null;

  const content = contentOf(record["content"]);
  if (content === null) return null;

  const stopReason = optionalTextOf(record["stopReason"]);
  const errorMessage = optionalTextOf(record["errorMessage"]);
  const model = optionalTextOf(record["model"]);
  if (stopReason === null || errorMessage === null || model === null) return null;

  const usage = record["usage"] === undefined ? undefined : usageOf(record["usage"]);
  if (usage === null) return null;

  return {
    role,
    content,
    ...(stopReason.text === undefined ? {} : { stopReason: stopReason.text }),
    ...(errorMessage.text === undefined ? {} : { errorMessage: errorMessage.text }),
    ...(model.text === undefined ? {} : { model: model.text }),
    ...(usage === undefined ? {} : { usage }),
  };
}

/** Content read as its blocks, or `null` where it is not a list of them. */
function contentOf(value: unknown): readonly PiContentBlock[] | null {
  if (!Array.isArray(value)) return null;
  const items: readonly unknown[] = value;
  const blocks: PiContentBlock[] = [];
  for (const item of items) {
    const block = recordOf(item);
    if (block === null || textOf(block["type"]) === null) return null;
    blocks.push(block as PiContentBlock);
  }
  return blocks;
}

/**
 * Usage read as its tokens and dollars, or `null` where a field it must carry
 * is missing.
 *
 * A field `pi` renamed reads here as a message that cannot be read, which is
 * the loud version of a round that silently cost nothing.
 */
function usageOf(value: unknown): PiUsage | null {
  const record = recordOf(value);
  if (record === null) return null;

  const cost = costOf(record["cost"]);
  if (cost === null) return null;

  const input = numberOf(record["input"]);
  const output = numberOf(record["output"]);
  const cacheRead = numberOf(record["cacheRead"]);
  const cacheWrite = numberOf(record["cacheWrite"]);
  const totalTokens = numberOf(record["totalTokens"]);
  if (
    input === null ||
    output === null ||
    cacheRead === null ||
    cacheWrite === null ||
    totalTokens === null
  ) {
    return null;
  }

  if (record["reasoning"] === undefined) {
    return { input, output, cacheRead, cacheWrite, totalTokens, cost };
  }
  const reasoning = numberOf(record["reasoning"]);
  if (reasoning === null) return null;
  return { input, output, cacheRead, cacheWrite, reasoning, totalTokens, cost };
}

/** The dollar breakdown, or `null` where a figure is missing. */
function costOf(value: unknown): PiCost | null {
  const record = recordOf(value);
  if (record === null) return null;
  const input = numberOf(record["input"]);
  const output = numberOf(record["output"]);
  const cacheRead = numberOf(record["cacheRead"]);
  const cacheWrite = numberOf(record["cacheWrite"]);
  const total = numberOf(record["total"]);
  if (
    input === null ||
    output === null ||
    cacheRead === null ||
    cacheWrite === null ||
    total === null
  ) {
    return null;
  }
  return { input, output, cacheRead, cacheWrite, total };
}

/** A value read as its fields, or `null` where it is not an object at all. */
function recordOf(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Readonly<Record<string, unknown>>;
}

/** A field read as a non-empty string, or `null` where it is anything else. */
function textOf(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  return value;
}

/**
 * A field that need not be there, read as a string.
 *
 * The wrapper is what tells an absent field from one whose value this cannot
 * read: `null` is the second, and a `text` of `undefined` the first.
 */
function optionalTextOf(value: unknown): { readonly text: string | undefined } | null {
  if (value === undefined) return { text: undefined };
  const text = textOf(value);
  return text === null ? null : { text };
}

/** A field read as a finite number, or `null` where it is anything else. */
function numberOf(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function incomplete(event: string, needed: string, line: string): Unreadable {
  return { type: "unreadable", reason: `a ${event} carries no ${needed}: ${excerptOf(line)}` };
}

function notAnEvent(line: string): Unreadable {
  return {
    type: "unreadable",
    reason: `a line does not begin with an event type: ${excerptOf(line)}`,
  };
}

/** As much of a line as a reason carries. A line has no length this can rely on. */
function excerptOf(line: string): string {
  return line.length > EXCERPT_LIMIT ? `${line.slice(0, EXCERPT_LIMIT - 3)}...` : line;
}
