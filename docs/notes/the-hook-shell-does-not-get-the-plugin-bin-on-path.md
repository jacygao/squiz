---
settles: "§ 3: how the hook registration names the `squiz` binary"
issue: [39, 54, 662]
recorded: 2026-09-09
versions: { claude-code: "2.1.263, 2.1.285 and 2.1.302", copilot: 1.0.98, node: 24.15.0 }
recheck-when: Claude Code changes how a plugin's bin/ reaches PATH or how it runs a hook command
---

# The hook's shell does not get the plugin's `bin/` on `PATH`

## Intent

- Whether the hook registration can name `squiz` bare, as the Bash tool can.
- What the registration must look like to survive any plugin root.

## Decisions

- **Register every hook as `"${CLAUDE_PLUGIN_ROOT}/bin/squiz" hook`, exactly.**
  Registered as `squiz hook`, the hook exited 127 with
  `/bin/sh: squiz: command not found`: its `PATH` is the user's login `PATH`,
  with nothing the plugin added. The runtime sets `CLAUDE_PLUGIN_ROOT` to the
  plugin root for the hook under `--plugin-dir` and under a marketplace install
  alike, so the registration writes down no install path.
- **Quote the placeholder.** Claude Code runs a shell-form hook command under
  `/bin/sh` and Copilot under `/bin/bash`. Unquoted, a plugin root with a space
  in it splits into several words and the hook exits 127.

## Needs your input

Nothing.

## Reference

### The registration

```json
{ "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/bin/squiz\" hook" }
```

`claude plugin validate --strict .` warns on the unquoted form for each hook and
passes the quoted one.

### The hook's environment

- **`PATH`** is the user's login `PATH`, character for character.
- **`CLAUDE_PLUGIN_ROOT`** is the plugin root.
- **`CLAUDE_PROJECT_DIR`** is the project, which only matches the plugin root
  when the session was started there. Only `CLAUDE_PLUGIN_ROOT` names the plugin.
- **`process.argv`** is `["<node>", "<plugin root>/src/cli.ts", "hook"]`: the
  shim resolves the entry point from its own location, not the working
  directory.

### Telling a hook that failed to run from one that ran

A hook that cannot resolve its command and one that exits 0 in silence leave the
same empty transcript. The exit code tells them apart:

- `--include-hook-events`, with `--output-format stream-json --verbose`, puts
  `hook_started` and `hook_response` in the stream. A command that did not
  resolve gives `"exit_code": 127, "outcome": "error"` with the shell's message
  in `stderr`, and a working one gives `"exit_code": 0, "outcome": "success"`
  with both streams empty.
- `--debug-file <path>` records the load, `Read hooks.json for plugin squiz`,
  `Loading hooks from plugin: squiz` and `Registered 1 hooks from 1 plugins`,
  which tells a plugin that failed to load from a hook that never fired.

## Limits

- **Whether `${CLAUDE_PLUGIN_ROOT}` is expanded by the runtime or by the shell
  was not distinguished.** The quoted registration holds either way, for a root
  with no `"`, `$` or backtick in it.
- **The install was from a directory, at `local` scope.** `user` scope and a
  remote marketplace were not tried.
- **One machine, print mode, one subagent per run, `claude-sonnet-5`.**
