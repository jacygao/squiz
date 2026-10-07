---
settles: "§ 3 — how a round a hook queued could wake an idle Copilot session, and what Not in the first version leaves open for Copilot; § 8 — what the plugin would ship for Copilot; § 9 — what a Copilot session must be started with"
issue: 591
recorded: 2026-10-06
versions: { copilot: 1.0.92, model: gpt-5-mini, node: 24.15.0, macos: 26.6.2 }
recheck-when: Copilot CLI upgrades past 1.0.92, extensions leave experimental, the plugin manifest's `extensions` field changes, or `session.sendSystemNotification` or the inbox becomes public
---

# An extension a plugin ships wakes an idle Copilot session from outside

Copilot CLI has a supported way in, and it is experimental. A plugin can ship an
extension. Copilot starts the extension as a child process, and the extension
joins the session in front of the user. Its `session.send()` starts a turn in
that session even when the session is idle. The extension can listen on a Unix
socket in the session's own state directory, so squiz's round host can reach
it. Three live runs woke an idle session this way, after 1 minute idle and
after 7. The turn started within 200 milliseconds of the delivery. Nothing else
gets in: the inbox and `session.sendSystemNotification` are internal, and no
hook, MCP notification or ACP call reaches a session another process owns.

## Intent

- Whether Copilot CLI has a supported route for a process outside a session to
  deliver a message to it while it is idle.
- If not, whether one is requested or planned, and whether to file a request.
- What squiz would need in order to use it.

## Decisions

- **There is a route today: an extension that calls `session.send()`, shipped
  by the plugin.** Copilot's documentation describes extensions. Its
  documented examples watch a file and call `session.send()` when it changes.
  The plugin manifest's `extensions` field names a directory of them. In each
  run the message became a `user.message`, followed by `assistant.turn_start`,
  in a session that had been idle. That held for a file dropped in a watched
  directory and for text written to the extension's socket. It held both when
  the extension came from `--plugin-dir` and when it sat in the user's
  extensions directory.
- **The route is experimental, and a session started without `--experimental`
  loads no extension.** The first run left the flag off and the extension never
  started. With the flag on, it joined before the first turn. Copilot gates
  extensions on its `EXTENSIONS` feature flag, which is available only with
  experimental features on. The changelog has called extensions experimental
  since 1.0.3.
- **Do not use the inbox.** The inbox holds the `new_inbox_message`
  notification. Only Copilot's built-in sidekick agents write to it, through a
  `send_inbox` tool that rejects any caller that is not a sidekick. The
  sidekicks Copilot ships load from its own package, and neither the
  documentation nor the code shows a plugin or a user defining one.
  `senderType` lists `plugin` and `hook`, but the only sender type the runtime
  spells out is `sidekick-agent`.
  The method that
  queues a system notification, `session.sendSystemNotification`, is marked
  `"visibility": "internal"` and is not in the SDK's session API.
- **Do not file a request for a way in. File one asking to make extensions
  stable, if the experimental flag is the obstacle.** The way in exists, so a
  request for one would add nothing. No issue asks Copilot to take extensions
  out of experimental, and nothing announced says it will. The nearest requests
  ask for something wider, such as one session coordinating another, and no
  GitHub staff member has answered any of them.
- **Squiz needs four things to use it:**
  - an extension in the plugin, named by an `extensions` field in the manifest
    Copilot reads;
  - a socket the extension listens on in its session's state directory;
  - a hook that records where that socket is;
  - a round host that writes the note to it.

  All four are built, as
  `the-round-hosts-own-post-wakes-an-idle-copilot-session-through-the-plugins-extension.md`
  records.

## Needs your input

- **Whether to build the Copilot wake on an extension, given that the coding
  agent's session must run with `--experimental`.** The flag turns on every
  experimental feature, not just extensions. § 9 would have to tell a project to
  start Copilot with it, or to turn it on once with `/experimental on`.
  Recommendation: build it, as a later milestone's work and not M13's. The
  socket sits in a directory only the user can open, unlike the `--ui-server`
  port, and the extension is a few dozen lines. Until it lands, keep the wake
  that M13 settled: the session runs `squiz review` in the background.

  2026-10-07: built in M13. § 9 has a Copilot user turn experimental features
  on, and squiz's Copilot support is experimental as a whole.
- **Whether to file a request upstream to take extensions out of experimental.**
  Recommendation: file it only once squiz depends on the route. Link #1705,
  #2065 and #3856 from it, since each touches an extension or a coordinator
  sending into a session.

## Reference

### What the extension did

`extension.mjs` in a directory the plugin's manifest names:

```json
{ "name": "squiz-591-probe", "version": "0.0.1", "extensions": "extensions" }
```

```js
import { joinSession } from "@github/copilot-sdk/extension";
import net from "node:net";

const session = await joinSession({});
process.chdir(session.workspacePath);
net.createServer((sock) => {
  let buf = "";
  sock.on("data", (d) => { buf += d; });
  sock.on("end", () => {
    session.send({ prompt: buf, source: "system" });
    sock.end("ok\n");
  });
}).listen("w.sock");
```

- `@github/copilot-sdk/extension` resolves without being installed. Copilot
  supplies it.
- `session.workspacePath` is `<COPILOT_HOME>/session-state/<session id>`. The
  directory's mode is `drwx------`.
- The socket is bound by a relative path after `chdir`. Under a long
  `COPILOT_HOME` the absolute path can exceed macOS's 104-byte limit for a
  socket path. A client connects the same way.
- The extension's parent is the `copilot` process. Copilot reloads it when the
  foreground session changes, for example on `/clear`, and stops it when the CLI
  exits.

### What the session recorded

The socket delivery with `source: "system"`, after 436 seconds idle:

```
10:50:54.339Z user.message {"content": "squiz review 14 exited 0. Reply with the single word WOKEN-BY-SOCKET.", "source": "system"}
10:50:54.341Z assistant.turn_start
10:50:59.381Z assistant.message {"content": "WOKEN-BY-SOCKET"}
10:50:59.384Z assistant.turn_end
```

The extension saw `session.idle` when that turn ended. A message without
`source` arrived as an ordinary `user.message`, and the pane showed it as a
typed prompt.

### What squiz would carry

- The hook already has the session id, as `session_id` in the `Stop` payload,
  and `COPILOT_HOME` in its environment. Those two give
  `<COPILOT_HOME>/session-state/<session_id>`, the directory the extension
  listens in. Where `COPILOT_HOME` is unset, Copilot uses `~/.copilot`. The hook
  as built takes the directory from the payload's `transcript_path` instead,
  because a hook's environment carries `COPILOT_HOME` only where the user set
  it.
- `MessageOptions.mode` takes `"enqueue"`, the default, or `"immediate"`.
  `"immediate"` interjects in a running turn (unverified: only the default was
  sent).

### Requests and plans upstream, as of 2026-10-06

None asks for exactly this, and none has a staff answer about it.

- **#1705** "Copilot Instance Coordination", open since 2026-02-26. Asks for one
  instance to pass queries to others through a local socket or registry.
  https://github.com/github/copilot-cli/issues/1705
- **#2436** "Cross-Session Context Querying", open since 2026-03-31. Asks to
  query an idle session as if it were a subagent.
  https://github.com/github/copilot-cli/issues/2436
- **#2065**, open since 2026-03-16. Asks for an extension to send to a
  background agent instead of waking the chat with `session.send()`.
  https://github.com/github/copilot-cli/issues/2065
- **#3856**, open since 2026-06-18. After repeated `/resume`, an extension's
  `session.send()` wakes a context the user cannot see.
  https://github.com/github/copilot-cli/issues/3856
- **#1143**, open since 2026-01-27. Asks for a background daemon with local IPC.
  https://github.com/github/copilot-cli/issues/1143
- **#3073**, open since 2026-05-02. Asks for MCP resource subscriptions. A staff
  member answered on 2026-07-23 that it "remains an open capability gap".
  https://github.com/github/copilot-cli/issues/3073
- **AHP**, the Agent Host Protocol. The 1.0.80-0 prerelease notes say
  `copilot --ahp` lets several terminals attach to one session, and gate it on
  the staff-only `AHP_CLIENT` feature flag. Nothing says it will open up.
- **ACP.** The specification gives no client a way to push into a session
  another client owns. Proposals to inject into or remind a session are open
  discussions in `agentclientprotocol/agent-client-protocol`, and its v2 draft
  is not stable. Copilot's `--acp` documents only the base methods.

### Routes ruled out

- **`--ui-server`, `--server` and `--headless`.** The owner ruled out the
  `--ui-server` port. The other two start a runtime separate from the
  interactive session.
- **Hooks.** No hook fires on an outside event. The `notification` hook's
  `additionalContext` can start a turn, but it fires only on Copilot's own
  notifications.
- **MCP.** A server's notifications do not start a turn. The documentation lists
  only sampling approval as a server-to-client feature.
- **`/every`, `/after` and `/loop`.** These poll on a timer the user sets, and
  run only while the session that set them is open.
- **`--remote`.** It takes prompts only from GitHub's web and mobile clients,
  and has no API.

## Limits

- **One run per case, on macOS, with `gpt-5-mini`.** The session ran in a
  pseudo-terminal that nothing was typed into. A scratch `COPILOT_HOME` trusted
  the work folder, the run carried `--allow-all`, and every `CLAUDE*` variable
  was unset.
- **The longest idle stretch was 7 minutes.** Hours idle, a sleeping machine, a
  delivery during a running turn, and two sessions at once were not tried.
- **Not established:**
  - whether an extension prompts for permission when the session does not carry
    `--allow-all`;
  - whether `--experimental` can be replaced by a setting in the project;
  - whether a plugin installed from a marketplace loads its extension the way
    `--plugin-dir` did.
- **Read, not tried:**
  - `session.sendSystemNotification`, because it is internal and not in the
    SDK's session API;
  - writing to the inbox, because only built-in sidekicks can.
- **Whether the pane showed the `source: "system"` prompt** could not be read
  from the captured output. It did show the reply.
