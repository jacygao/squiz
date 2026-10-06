/**
 * A post to a session's messaging socket, which starts a turn in it when it is
 * idle. The socket is Claude Code's own, or the one squiz's Copilot extension
 * listens on, which reads the same posts.
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

/**
 * Whether something accepts a connection at `socketPath` within `boundMs`.
 *
 * The check connects and ends the connection having written nothing, so a
 * reader that acts on each line it reads is sent no message. A socket file left
 * by a process that has died refuses the connection, and is not listening.
 */
export function listening(socketPath: string, boundMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (answer: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(answer);
    };
    const timer = setTimeout(() => settle(false), boundMs);
    const socket = createConnection(socketPath);
    socket.on("error", () => settle(false));
    socket.on("connect", () => socket.end());
    socket.on("finish", () => settle(true));
  });
}
