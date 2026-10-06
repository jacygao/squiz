---
settles: "§ 6 — how the `squiz` binary reaches a Copilot session's shell; § 9 — whether Copilot loads squiz's plugin directory as it is"
issue: [534, 553]
recorded: 2026-10-06
versions: { copilot: 1.0.92, model: gpt-5-mini, node: 24.15.0, macos: 26.6.2 }
recheck-when: Copilot CLI upgrades past 1.0.92, or changes how it reads a plugin's manifest, skills, hooks or bin/
---

# Copilot loads the plugin directory, but leaves `bin/` off `PATH`

## Intent

- Whether `copilot --plugin-dir` pointed at a squiz checkout lists the
  `squiz-review` skill, and loads it when asked.
- Whether a shell call in that session runs `squiz` by name.
- Where the directory does not load as it is, what Copilot expects instead.

## Decisions

- **Load squiz into Copilot with `--plugin-dir <checkout>`, as the directory
  is.** Copilot reads `.claude-plugin/plugin.json`, lists the plugin as
  `squiz (v0.1.0)`, and lists `squiz-review` among its `Plugin skills`. A
  session asked for the skill called its `skill` tool, got `Skill "squiz-review"
  loaded successfully`, and quoted the skill's `Exit 3:` bullet word for word.
  Without `--plugin-dir` the same call failed with `Skill not found:
  squiz-review`, and nothing was listed.
- **Something other than the plugin has to put `squiz` on the shell's `PATH`.**
  Copilot does not add a plugin's `bin/` to it. The shell saw exactly the `PATH`
  Copilot was started with, and `squiz` was `command not found`, exit 127, with
  the plugin loaded as without it. Copilot's help, its plugin reference and its
  changelog name no `bin/` directory and no manifest field or setting that adds
  one, so there is nothing to put in its place.
- **`squiz init` links `bin/squiz` into a directory already on `PATH`
  (decided 2026-10-06).** The owner chose the link over naming the binary by
  path in the skill, on the condition that it never makes two coding agents on
  one machine run different squizzes. It keeps one skill text for both
  runtimes, and `squiz review` and `squiz reply` keep the same names under
  both. § 6 `squiz init` says which directory and which conflicts.

## Needs your input

Nothing.

## Reference

### Reproducing it

From a scratch directory outside any squiz checkout, with a `PATH` holding no
`squiz`:

```
copilot --plugin-dir <checkout> plugin list
copilot --plugin-dir <checkout> skill list --json
COPILOT_MODEL=gpt-5-mini copilot --plugin-dir <checkout> -p "<prompt>" --allow-all-tools --no-ask-user
```

The first two make no model call. The prompt asked for one shell call,
`command -v squiz; echo "exit=$?"; echo "PATH=$PATH"; squiz --help; echo
"squiz-exit=$?"`, and for the skill's `Exit 3:` bullet quoted verbatim, or `NO
SKILL`. The control is the same three commands without `--plugin-dir`.

`skill list --json` gives the skill's source:

```json
{ "name": "squiz-review", "source": "plugin", "path": "<checkout>/skills/squiz-review", "enabled": true }
```

### Where the load shows

The session's `events.jsonl`, under `~/.copilot/session-state/<session id>/`,
records the load as a `skill.invoked` event whose `path` is
`<checkout>/skills/squiz-review/SKILL.md`, then a `skill.invoked_ref` carrying
`"source":"plugin","pluginName":"squiz","trigger":"agent-invoked"`. The debug
log (`--log-dir <dir> --log-level debug`) records `Plugins loaded: ["squiz"]`.

### The hooks load too

Loading the directory as it is loads `hooks/hooks.json` with it. Its `Stop`
registration fired as Copilot's `agentStop` at the end of a `-p` run, which the
control did not record. A stand-in plugin with squiz's `hooks.json` and a
`bin/squiz` that recorded its call showed what the hook gets:

- **The command resolved.** `${CLAUDE_PLUGIN_ROOT}/bin/squiz hook` ran with
  `argv` `<plugin root>/bin/squiz hook`.
- **The environment** carried `CLAUDE_PLUGIN_ROOT`, `COPILOT_PLUGIN_ROOT` and
  `PLUGIN_ROOT`, all the plugin root; `CLAUDE_PLUGIN_DATA` and
  `COPILOT_PLUGIN_DATA`, both
  `~/.copilot/plugin-data/_direct/<hash>`; and `CLAUDE_PROJECT_DIR`, the
  session's working directory. Its `PATH` held no plugin entry.
- **The working directory was the plugin root**, not the session's.
- **The payload was Claude Code's shape**:

  ```json
  {"hook_event_name":"Stop","session_id":"<copilot session id>","timestamp":"…","cwd":"<session directory>","transcript_path":"~/.copilot/session-state/<id>/events.jsonl","stop_reason":"end_turn","stop_hook_active":false}
  ```

So the real `squiz hook` ran at the end of the plugin run above, from the
plugin checkout's own directory.

## Limits

- **One machine, one model, `-p` only.** An interactive session was not tried,
  and neither was a plugin installed with `copilot plugin install` rather than
  mounted with `--plugin-dir`.
- **The skill was loaded because the prompt named it.** Whether Copilot loads it
  unprompted, from its description alone, was not tested here.
- **Whether `squiz hook` did anything under Copilot was not established.** The
  run left no `.squiz/` in the plugin checkout. What the hook should do there,
  and whether `asyncRewake` and `timeout` mean anything to Copilot, belong to
  the hooks question rather than to this one.
- **The hook's environment also held `CLAUDE_CODE_MESSAGING_SOCKET` and other
  `CLAUDE_CODE_*` variables**, because the Copilot run was started from inside a
  Claude Code session and inherited them. A Copilot session started from a plain
  terminal would not carry them.
- **That no `bin/` mechanism exists was read from Copilot's help, its online
  plugin reference and its changelog**, not from its source.
