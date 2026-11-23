---
settles: "§ 3: how a round a hook queued wakes an idle Copilot session, and what the hook records under Copilot; § 9: the extension the plugin ships; § 10: how a Copilot user turns the wake on"
issue: 594
recorded: 2026-10-07
versions: { copilot: 1.0.92, models: "gpt-6-astra, gpt-5-mini, claude-haiku-4.5", reviewer: gpt-6-astra, herdr: 0.9.3, node: "24.15.0, and Copilot's own 24.20.0 for the extension", macos: 26.6.2 }
recheck-when: Copilot CLI upgrades past 1.0.92, extensions leave experimental, the manifest's `extensions` field or `session.send()` changes, the round host's note text changes, or `postMessage` changes what it writes
---

# The round host's own post wakes an idle Copilot session through the plugin's extension

## Intent

- Whether an extension in the plugin can take the round host's post unchanged
  and turn it into a turn, so the core needs no new path.
- How the hook knows the extension is listening, and that it records nothing
  where none is.
- What `gpt-6-astra`, `gpt-5-mini` and `claude-haiku-4.5` do with the note.
- What happens without experimental features, and whether turning them on
  persists.
- Whether a subagent's stop can be woken this way.
- What becomes of the socket when a session ends or its extension dies.

## Decisions

- **Ship the wake as `extensions/squiz-wake/extension.mjs`, named by
  `"extensions": "extensions"` in `.claude-plugin/plugin.json`.** Copilot reads
  the field from that manifest and starts the extension in each session. Claude
  Code's validator ignores it. The extension listens on `squiz.sock` in the
  session's state directory and reads exactly what the round host already posts
  to Claude Code's messaging socket, so the round host, the note, `wakeOwner` and
  `postMessage` need nothing of their own for Copilot.
- **Take the socket from the payload's `transcript_path`, not from
  `COPILOT_HOME`.** A hook's environment carries `COPILOT_HOME` only where the
  user set it. The transcript is
  `<COPILOT_HOME>/session-state/<session id>/events.jsonl`, the directory the
  extension listens in. The hook reads it only where the transcript's session is
  the payload's `session_id`.
- **Record the socket only once a connection to it is accepted.** The hook
  connects and closes without writing, within one second, and the extension
  sends nothing for an empty connection. A session without experimental features
  records `{"sessionId": "<id>"}` alone. A socket file left by an extension
  killed with `SIGKILL` refuses the connection, and the hook records none.
- **Use one note for every model.** In every woken session the turn's first user
  message was the note, with `"source": "system"`, and each of the three models
  ran `squiz review <number>` as its first command.
- **Let a subagent's stop wake its parent.** Copilot's `SubagentStop` carries the
  parent's `session_id` and transcript, so the hook records the parent's socket
  with the subagent named, and the parent is woken with the note naming the
  subagent's work.
- **Tell a Copilot user that experimental features are a per-user switch that a
  repository cannot turn on.** `copilot --experimental` and `/experimental on`
  each write `"experimental": true` to `<COPILOT_HOME>/settings.json`, and later
  sessions load extensions with no flag. `copilot --no-experimental` writes
  `false`. The same key in a repository's `.github/copilot/settings.json` loads
  no extension. A session without them is not woken, and its note waits in
  `notes/<session id>/` to be pulled.
- **Expect a dead extension's socket to cost one failed post, no more.** The
  extension removes its socket when the session ends with `/exit`. After
  `SIGKILL` the file stays and Copilot does not restart the extension. A post to
  a socket that died after the hook recorded it fails once, and leaves the note
  to be pulled.

## Needs your input

- **Whether to file the upstream request to take extensions out of
  experimental.** Recommendation: file it, linking issues 1705, 2065 and 3856 in
  `github/copilot-cli`.

## Reference

### The post and what the extension does with it

The round host writes one line and ends the connection:

```json
{"type":"user","message":{"role":"user","content":"<the note's text>"}}
```

The extension calls `session.send({ prompt: <content>, source: "system" })` for
each such line and writes nothing back. Without `source`, the message shows in
the pane as a typed prompt.

### What a wake looks like in `events.jsonl`

```
23:03:57.948Z assistant.turn_end
23:03:57.952Z hook.start agentStop
23:03:59.197Z hook.end agentStop
23:05:15.312Z user.message {"content":"<the note>","source":"system"}
23:05:15.315Z assistant.turn_start
```

`host.log` writes `woke its owner through <socket>` as the post lands. Copilot
does not write `session.idle` to `events.jsonl`: idle shows as a `hook.end` with
no event after it until the note. The turn started within 6 ms of the note, after
64 to 110 seconds idle. The hook took 1.2 to 1.4 seconds with or without an
extension.

### The socket's path

`<COPILOT_HOME>/session-state/<session id>/squiz.sock`, with a 36-character
session id, must fit in 104 bytes on macOS. A `COPILOT_HOME` under the
49-character macOS `TMPDIR` does not fit. Where it does not, `listen` fails with
`EINVAL`, and the extension logs `squiz cannot wake this session: <reason>` as a
warning in the session.

### What `--experimental` turns on in 1.0.92

`/experimental show` lists:

- slash commands `/after`, `/every` and `/loop`, `/extensions`, `/sandbox`, and
  `/search`;
- feature flags `CLI_CLOUD_SESSIONS`, `MCP_TASKS`, `INLINE_IMAGES`,
  `HYDRAFUSION`, `EXTENSIONS`, `MCP_APPS`, `AUTOPILOT_NO_PROGRESS_STOP`,
  `SANDBOX`, `EVERY_AND_AFTER`, `TOOL_SEARCH`, `AUTO_APPROVAL` and `DIFF_V2`.

A change made with `/experimental` takes effect after a restart.

## Limits

- **One machine, one try per configuration, every session with `--allow-all`.**
- **`gpt-6-astra` was not seen to work a thread to exit 0 or 3.** Its woken
  sessions either had no thread or disputed their one thread and stopped at
  exit 2.
- **The longest idle stretch was 110 seconds.** Hours idle and a sleeping
  machine were not tried.
- **Not tried:** a post during a running turn, two sessions with one session id,
  a plugin installed from a marketplace rather than `--plugin-dir`, and a session
  that asks for permissions.
