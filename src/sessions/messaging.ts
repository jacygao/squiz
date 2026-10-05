/**
 * A post to a Claude Code session's messaging socket, which starts a turn in it
 * when it is idle.
 *
 * A post is one JSON line naming a user message. The socket writes nothing back,
 * so a post is delivered once every byte of it has reached the socket and the
 * connection has been ended without an error. A peer that closes before the
 * whole post has reached it fails the post. One that closes after, without
 * reading it, cannot be told from one that read it.
 *
 * Nothing here throws. Every answer is a value the caller reads.
 */

import { createConnection } from "node:net";

export type Posted = { readonly outcome: "delivered" } | { readonly outcome: "failed"; readonly reason: string };

/** Post `text` to the socket at `socketPath`, within `boundMs`. */
export function postMessage(socketPath: string, text: string, boundMs: number): Promise<Posted> {
  const line = `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;
  return new Promise((resolve) => {
    let settled = false;
    const settle = (posted: Posted): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(posted);
    };
    const failed = (why: string): void => settle({ outcome: "failed", reason: `the post to ${socketPath} did not arrive: ${why}` });

    const timer = setTimeout(() => failed(`it had not finished within ${boundMs}ms`), boundMs);
    const socket = createConnection(socketPath);
    socket.on("error", (error) => failed(error.message));
    socket.on("connect", () => socket.end(line));
    // Emitted once the end has flushed every byte, and never after an error.
    socket.on("finish", () => settle({ outcome: "delivered" }));
  });
}
