/**
 * A stand-in for the Copilot SDK's `joinSession`, for an extension run outside
 * Copilot.
 *
 * Each call the extension makes on the session is printed to stdout as one JSON
 * line. The session's directory is `SQUIZ_STAND_IN_WORKSPACE`. A line
 * `shutdown` on stdin fires `session.shutdown`.
 */

import { createInterface } from "node:readline";

type Handler = (event: { readonly type: string }) => void;

function print(call: Readonly<Record<string, unknown>>): void {
  process.stdout.write(`${JSON.stringify(call)}\n`);
}

export async function joinSession(): Promise<unknown> {
  const handlers = new Map<string, Handler[]>();
  createInterface({ input: process.stdin }).on("line", (line) => {
    if (line !== "shutdown") return;
    for (const handler of handlers.get("session.shutdown") ?? []) handler({ type: "session.shutdown" });
  });
  return {
    sessionId: "stand-in",
    workspacePath: process.env["SQUIZ_STAND_IN_WORKSPACE"],
    send(options: unknown): Promise<string> {
      print({ send: options });
      return Promise.resolve("message-id");
    },
    log(message: string, options?: unknown): Promise<void> {
      print({ log: message, options });
      return Promise.resolve();
    },
    on(event: string, handler: Handler): () => void {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => undefined;
    },
  };
}
