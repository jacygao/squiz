/**
 * Lets squiz's round host wake this Copilot session when it is idle, the way
 * Claude Code's messaging socket lets it wake a Claude Code session.
 *
 * It listens on `squiz.sock` in the session's state directory and reads what
 * the round host posts to Claude Code's socket: one JSON line per message,
 * `{"type":"user","message":{"role":"user","content":"<text>"}}`, on a
 * connection the poster ends. Each such line becomes a turn, through
 * `session.send()`. Nothing is written back, since a poster reads nothing.
 *
 * One socket per session, which no longer exists once the session has ended.
 * Copilot reloads an extension when the foreground session changes and stops it
 * when the CLI exits, so the socket goes with the process. A socket file left
 * by a process that was killed refuses connections, and the hook records none.
 *
 * Copilot loads extensions only with its experimental features on.
 */

import { joinSession } from "@github/copilot-sdk/extension";
import { rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

const session = await joinSession({});
const path = join(session.workspacePath, "squiz.sock");

const server = createServer((connection) => {
  let text = "";
  connection.setEncoding("utf8");
  connection.on("data", (chunk) => (text += chunk));
  // The hook checks the socket with a connection that writes nothing, which sends nothing.
  connection.on("end", () => {
    for (const prompt of messages(text)) session.send({ prompt, source: "system" }).catch(() => undefined);
  });
  connection.on("error", () => undefined);
});

server.on("error", (error) => {
  session.log(`squiz cannot wake this session: ${error.message}`, { level: "warning" }).catch(() => undefined);
});

// A file at the path is a socket a killed run of this session left, which nothing listens on.
rmSync(path, { force: true });
server.listen(path);

session.on("session.shutdown", () => server.close());
process.on("exit", () => rmSync(path, { force: true }));
// Copilot stops an extension with SIGTERM, which would otherwise end it without the exit above.
process.on("SIGTERM", () => process.exit(0));

/** The text of each user message in `text`, one JSON line each, skipping any line that is not one. */
function messages(text) {
  const found = [];
  for (const line of text.split("\n")) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const content = parsed?.type === "user" ? parsed.message?.content : undefined;
    if (typeof content === "string") found.push(content);
  }
  return found;
}
