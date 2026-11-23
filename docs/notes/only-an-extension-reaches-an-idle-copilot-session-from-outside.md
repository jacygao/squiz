---
settles: "§ 3: the route by which a process outside a Copilot session starts a turn in it while it is idle; § 10: why a Copilot session needs experimental features on"
issue: 591
recorded: 2026-10-06
versions: { copilot: 1.0.92, model: gpt-5-mini, node: 24.15.0, macos: 26.6.2 }
recheck-when: Copilot CLI upgrades past 1.0.92, extensions leave experimental, or `session.sendSystemNotification`, the inbox or ACP opens to other processes
---

# Only an extension reaches an idle Copilot session from outside

## Intent

- Whether Copilot CLI has a supported route for a process outside a session to
  deliver a message to it while it is idle.
- Whether to ask upstream for one.

## Decisions

- **Wake an idle Copilot session through an extension the plugin ships, calling
  `session.send()`.** The message became a `user.message` followed by
  `assistant.turn_start` in a session that had been idle for 1 and for 7
  minutes, within 200 milliseconds of the delivery. That held for a file
  dropped in a watched directory and for text written to the extension's
  socket. How squiz ships it is in
  `the-round-hosts-own-post-wakes-an-idle-copilot-session-through-the-plugins-extension.md`.
- **Expect the route to need experimental features on.** A session started
  without them loads no extension: Copilot gates extensions on its
  `EXTENSIONS` feature flag, which only experimental features turn on, and its
  changelog has called extensions experimental since 1.0.3.
- **Use no other route.** Each is closed or reaches the wrong session:
  - the inbox takes messages only from Copilot's built-in sidekick agents, whose
    `send_inbox` tool rejects any other caller;
  - `session.sendSystemNotification` is marked `"visibility": "internal"` and is
    not in the SDK's session API;
  - no hook fires on an outside event, and the `notification` hook fires only on
    Copilot's own notifications;
  - an MCP server's notifications do not start a turn;
  - `--ui-server` is ruled out by the owner, and `--server` and `--headless`
    start a runtime separate from the interactive session;
  - ACP gives no client a way to push into a session another client owns;
  - `/every`, `/after` and `/loop` poll on a timer the user sets;
  - `--remote` takes prompts only from GitHub's web and mobile clients.
- **Do not ask upstream for a way in.** One exists. What could be asked for is
  extensions leaving experimental, which nothing announced promises.

## Needs your input

- **Whether to file a request upstream to take extensions out of experimental.**
  Recommendation: file it, since the Copilot wake depends on the route. Link
  the open requests that touch an extension or a coordinator:
  github/copilot-cli#1705 (instance coordination over a local socket),
  github/copilot-cli#2065 (an extension sending to a background agent) and
  github/copilot-cli#3856 (`session.send()` waking a hidden context after
  `/resume`).

## Reference

- **`@github/copilot-sdk/extension` resolves without being installed.** Copilot
  supplies it. `joinSession({})` joins the session in front of the user.
- **`session.workspacePath` is `<COPILOT_HOME>/session-state/<session id>`**,
  mode `drwx------`. The extension's parent is the `copilot` process. Copilot
  reloads it when the foreground session changes, for example on `/clear`, and
  stops it when the CLI exits.
- **`session.send({ prompt, source: "system" })`** arrives as a `user.message`
  with `"source": "system"`. Without `source` it arrives as an ordinary
  `user.message`, and the pane shows it as a typed prompt.
- **A socket path over 104 bytes cannot be bound on macOS.** Under a long
  `COPILOT_HOME` the absolute path to a socket in `workspacePath` can exceed it.
- **`MessageOptions.mode` takes `"enqueue"`, the default, or `"immediate"`**,
  which interjects in a running turn (unverified: only the default was sent).

## Limits

- **One run per case, on macOS, with `gpt-5-mini`**, under `--allow-all`.
- **The longest idle stretch was 7 minutes.** Hours idle, a sleeping machine, a
  delivery during a running turn, and two sessions at once were not tried.
- **Whether an extension asks for permission** in a session without
  `--allow-all` was not established.
- **The inbox and `session.sendSystemNotification` were read in Copilot's code,
  not tried.**
