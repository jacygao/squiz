/**
 * The hook's payload, read from the stdin the runtime wrote it to.
 *
 * What the payload says is `readFiringWithSocket`'s to read. This only gets the
 * whole of it off the stream, and never throws.
 */

import { readFiringWithSocket, type FiringRead, type HookEnvironment } from "../sessions/firing.ts";

/** The hook's stdin. The payload arrives on it and nothing else does. */
export type PayloadStream = AsyncIterable<string | Uint8Array> & {
  readonly isTTY?: boolean | undefined;
};

/**
 * Read the firing `stream` carries, with `environment`, the hook's own.
 *
 * A stdin that is a terminal is nobody's payload: the hook was run by hand, and
 * reading to the end of input would hold it open until the runtime killed it.
 * It comes back as unreadable without anything being read.
 */
export async function readPayloadFrom(stream: PayloadStream, environment: HookEnvironment): Promise<FiringRead> {
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
  return readFiringWithSocket(Buffer.concat(chunks).toString("utf8"), environment);
}

function unreadable(reason: string): FiringRead {
  return { outcome: "unreadable", reason };
}

function reasonFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
