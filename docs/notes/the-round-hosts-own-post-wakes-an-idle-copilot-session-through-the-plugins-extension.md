---
settles: "§ 3 — how a round a hook queued wakes an idle Copilot session, what the hook records under Copilot, and what Not in the first version keeps for Copilot; § 8 — the extension the plugin ships; § 9 — how a Copilot user turns the wake on"
issue: 594
recorded: 2026-10-07
versions: { copilot: 1.0.92, models: "gpt-6-astra, gpt-5-mini, claude-haiku-4.5", reviewer: gpt-6-astra, herdr: 0.9.3, node: "24.15.0, and Copilot's own 24.20.0 for the extension", macos: 26.6.2 }
recheck-when: Copilot CLI upgrades past 1.0.92, extensions leave experimental, the manifest's `extensions` field or `session.send()` changes, the round host's note text changes, or `postMessage` changes what it writes
---

# The round host's own post wakes an idle Copilot session through the plugin's extension

An extension the plugin ships listens on `squiz.sock` in each Copilot session's
state directory and reads exactly what the round host already posts to Claude
Code's messaging socket. In seven live sessions on a scratch repository, every
session started with experimental features on was woken by the round host's
note, between 64 and 110 seconds after it went idle. The note was the turn's
first user message, and the turn started within 6 milliseconds of it. Every
woken session ran `squiz review` at once. Of the four with threads to work,
three brought the review to exit 0, and one disputed its thread and stopped at
exit 2. A session started with experimental features off recorded no socket,
and its note waited.

## Intent

- Whether an extension in the plugin can take the round host's post unchanged
  and turn it into a turn, so the core needs no new path.
- How the hook knows the extension is listening, and that it records nothing
  where none is.
- What `gpt-6-astra`, `gpt-5-mini` and `claude-haiku-4.5` do with the note.
- What happens without `--experimental`.
- Whether `/experimental on` persists across sessions, and what else
  `--experimental` turns on in 1.0.92.
- Whether a subagent's stop can be woken this way.
- What becomes of the socket when a session ends or its extension dies.

## Decisions

- **Ship the wake as `extensions/squiz-wake/extension.mjs`, named by
  `"extensions": "extensions"` in `.claude-plugin/plugin.json`.** Copilot read
  the field from that manifest and started the extension in each session.
  Claude Code's validator says it ignores the field. The round host, the note,
  `wakeOwner` and `postMessage` are unchanged.
- **Take the socket from the payload's `transcript_path`, not from
  `COPILOT_HOME`.** A hook's environment carries `COPILOT_HOME` only where the
  user set it. The transcript is `<COPILOT_HOME>/session-state/<session
  id>/events.jsonl`, the directory the extension listens in. The hook reads it
  only where the transcript's session is the payload's `session_id`.
- **Record the socket only once a connection to it is accepted.** The hook
  connects and closes without writing, within one second, and the extension
  sends nothing for an empty connection. The session with experimental features
  off recorded `{"sessionId": "<id>"}` alone, exactly as before. A socket file
  left by an extension killed with `SIGKILL` refused the connection, and the
  hook recorded none.
- **Count the wake as working on every model.** Each woken turn's first user
  message was the note, with `"source": "system"`, and each model ran
  `squiz review <number>` as its first command. The note needs no rewording for
  Copilot.
- **A subagent's stop wakes its parent.** Copilot's `SubagentStop` carries the
  parent's `session_id` and transcript, so the hook recorded the parent's
  socket with the subagent named. The parent was woken with the note naming the
  subagent's work, and worked the thread itself.
- **Tell a Copilot user that experimental features are a per-user switch, and
  that a repository cannot turn them on.** `copilot --experimental` and
  `/experimental on` each write `"experimental": true` to
  `<COPILOT_HOME>/settings.json`, and later sessions load extensions with no
  flag. `copilot --no-experimental` writes `false`. The same key in a
  repository's `.github/copilot/settings.json` loaded no extension.
- **Expect a dead extension's socket to cost one failed post, no more.** The
  extension removed its socket when the session ended with `/exit`. After
  `SIGKILL` the file stayed, and Copilot did not restart the extension. The
  hook records no socket for such a session, and a post to a socket that has
  died since the hook recorded it fails once and leaves the note to be pulled.

## Needs your input

- **Whether to accept `gpt-6-astra` without seeing it work a thread to exit 0
  or 3.** In runs a and a2 the reviewer found nothing, so the woken session
  only read the close. In run d it disputed its one thread, which stayed open
  after round 2, and stopped at exit 2. Recommendation: accept it. The wake
  is what this issue tests, and the three runs show it. Working threads on
  `gpt-6-astra` was settled by #573.
- **Whether § 9 should ask users to turn on every experimental feature for
  this.** The switch is all or nothing, per user, and stays on once flipped.
  Recommendation: keep it optional, as § 9 now says.

  2026-10-07: settled another way. § 9 has a Copilot user turn experimental
  features on as part of setup, and a Copilot session without them is
  unsupported.
- **Whether to file the upstream request to take extensions out of
  experimental now that squiz uses them.** Recommendation: file it, linking
  #1705, #2065 and #3856 in `github/copilot-cli`.

## Reference

### What each session did

The coding model, the scratch pull request, how long the session had been idle
when the note arrived, and how it ended. `squiz review` exit codes are as § 6
gives them. The plugin still shipped the `squiz-review` skill, since removed.

| Run | Model | PR | Idle | After the note |
|---|---|---|---|---|
| a | `gpt-6-astra` | #21 | 76 s | Ran `squiz review 21`, read the close, reported. No thread to work |
| a2 | `gpt-6-astra` | #25 | 64 s | The same. The planted defect was in the change, and the reviewer did not flag it |
| d | `gpt-6-astra`, through a `task` subagent | #26 | 66 s | Ran `squiz review 26`, disputed the one thread with `squiz reply`, ran it again, and stopped at exit 2 with the thread open |
| b | `gpt-5-mini` | #23 | 110 s | Fixed both threads, replied on each, pushed, and ran `squiz review` until round 3 exited 0. Summary `Fixed 3 · Open 0` |
| e | `gpt-5-mini` | #24 | 97 s | Loaded the skill, fixed the thread, pushed, and round 2 exited 0. It replied on no thread |
| c | `claude-haiku-4.5` | #22 | 76 s | Loaded the skill, fixed both threads, replied on one, pushed, and round 2 exited 0. Summary `Fixed 2 · Open 0` |
| f | `gpt-5-mini`, experimental features off | #27 | — | Not woken. The record's owner had no socket, and the note stayed in `notes/<session id>/`, undelivered |

`gpt-5-mini` and `claude-haiku-4.5` ignored the skill in #573. Woken by the note,
both ran `squiz review` and worked the threads.

The `gpt-5-mini` sessions ran `squiz review` with `initial_wait` 30 in run b,
and polled the shell with `read_bash` until it ended.

### What a wake looks like in `events.jsonl`

Run c, from the end of the turn that opened the pull request:

```
23:03:57.948Z assistant.turn_end
23:03:57.952Z hook.start agentStop
23:03:59.197Z hook.end agentStop
23:05:15.312Z user.message {"content":"Squiz reviewed PR #22 at 3b234d4: 2 threads are open. Run `squiz review 22` to read them.","source":"system"}
23:05:15.315Z assistant.turn_start
```

`host.log` wrote `woke its owner through <socket>` at 23:05:15.267Z. Copilot
does not write `session.idle` to `events.jsonl`. Idle shows as `hook.end` with
no event after it until the note.

The hook took 1.2 to 1.4 seconds in every run, with or without an extension.

### The post and what the extension does with it

The round host writes one line and ends the connection:

```json
{"type":"user","message":{"role":"user","content":"<the note's text>"}}
```

The extension calls `session.send({ prompt: <content>, source: "system" })` for
each such line, and writes nothing back. A connection that writes nothing sends
nothing. Without `source`, a message shows in the pane as a typed prompt.

### The socket's path

`<COPILOT_HOME>/session-state/<session id>/squiz.sock`, with a 36-character
session id. It must fit in 104 bytes on macOS. Under the 49-character macOS
`TMPDIR` a scratch `COPILOT_HOME` does not fit: the runs used `/tmp/s594/ch`.
Where it does not fit, `listen` fails with `EINVAL`, and the extension logs
`squiz cannot wake this session: <reason>` as a warning in the session.

### What `--experimental` turns on in 1.0.92

`/experimental show` lists:

- slash commands `/after`, `/every` and `/loop`, `/extensions`, `/sandbox`, and
  `/search`;
- feature flags `CLI_CLOUD_SESSIONS`, `MCP_TASKS`, `INLINE_IMAGES`,
  `HYDRAFUSION`, `EXTENSIONS`, `MCP_APPS`, `AUTOPILOT_NO_PROGRESS_STOP`,
  `SANDBOX`, `EVERY_AND_AFTER`, `TOOL_SEARCH`, `AUTO_APPROVAL` and `DIFF_V2`.

The 1.0.92 changelog adds that a change made with `/experimental` takes effect
after a restart.

### Setup

As #573 set it up: the plugin from `--plugin-dir <this worktree>`, `squiz` on
`PATH` through `squiz init` run with a scratch `HOME`, `.squiz.json` naming the
`copilot` reviewer, a scratch `COPILOT_HOME` trusting the clones, no `CLAUDE*`
variable, and a new Herdr tab per run with nothing typed into it. Each session
started with:

```
copilot --experimental --plugin-dir <worktree> --model <model> --allow-all \
  --log-dir <dir> --log-level debug -i "<prompt>"
```

Run f left out `--experimental` and used a `COPILOT_HOME` no experimental launch
had touched. The prompt was #573's paging task, ending: `Do not run squiz
review yourself: squiz reviews the pull request on its own and sends you a
message when its review is done.` Runs a2 and d also required `M` to be
`pageCount`'s result unadjusted, which keeps the `pageCount` defect on `main` in
the change. Run d's prompt told the session to give the whole job to one `task`
subagent in `sync` mode.

## Limits

- **One machine, one try per configuration.** Every session ran with
  `--allow-all` on macOS.
- **The longest idle stretch was 110 seconds.** Hours idle and a sleeping
  machine were not tried.
- **Run e's `COPILOT_HOME` already had experimental features on.** It was
  meant as the run without them, but an earlier `--experimental` launch had
  written the setting, so it counts as a second `gpt-5-mini` run. Run f is the
  run without them.
- **The runs shared one scratch repository at once.** Run d's subagent read
  the other runs' branches before writing its own.
- **Not tried:** a post during a running turn, two sessions with one session
  id, a plugin installed from a marketplace rather than `--plugin-dir`, and a
  session that asks for permissions.
