---
settles: "§ 6 — whether the SubagentStop registration can name the `squiz` binary directly"
issue: 39
recorded: 2026-09-09
versions: { claude-code: 2.1.263, node: 24.15.0 }
recheck-when: Claude Code changes how a plugin's bin/ reaches PATH
---

# The hook's shell does not get the plugin's `bin/` on `PATH`

The Bash tool does. In a session started with `claude --plugin-dir ./`,
`command -v squiz` resolved to the plugin's own `bin/squiz` and `squiz hook`
exited 0. The hook did not: registered as `squiz hook`, it fired and exited 127
with `/bin/sh: squiz: command not found`, and the `PATH` the hook process was
given held nothing the plugin had added. Registered as
`${CLAUDE_PLUGIN_ROOT}/bin/squiz hook`, the same hook ran the same binary and
exited 0.

## Decisions

- **The registration is `${CLAUDE_PLUGIN_ROOT}/bin/squiz hook`, exactly.** The
  runtime sets `CLAUDE_PLUGIN_ROOT` to the plugin root for the hook, so the
  registration still writes down no install path.
- **§ 6 is contradicted in one clause and holds in the rest.** "A plugin's
  `bin/` is added to the Bash tool's `PATH` while the plugin is enabled" is
  true, and it is what `squiz threads`, `squiz reply` and `squiz resolve` rest
  on. "The hook registration names it directly" is false: the hook is not run
  by the Bash tool and does not get that `PATH`.
- **A hook that cannot resolve its command looks exactly like a hook with
  nothing to say.** Both leave an empty transcript. Nothing about the plugin
  loading says the command will run, so the two are told apart by the exit code
  in the event stream rather than by output.

## Needs your input

**Whether § 6's sentence about the registration is amended, and how.** The
recommendation is to keep the claim about the Bash tool's `PATH`, since the
coding agent's three commands depend on it, and to say that the hook is
registered through `${CLAUDE_PLUGIN_ROOT}` because a hook does not run under
that `PATH`. Nothing in the harness's behaviour changes either way.

## Reference

### The registration that runs

```json
{
  "hooks": {
    "SubagentStop": [
      {
        "hooks": [
          { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/bin/squiz hook" }
        ]
      }
    ]
  }
}
```

### The hook's environment, as observed

The hook body recorded its own `process.env` on a real firing:

- **`PATH`** was the user's login `PATH`, character for character, with no entry
  from the plugin anywhere in it.
- **`CLAUDE_PLUGIN_ROOT`** was the plugin root — the directory `--plugin-dir`
  was given.
- **`CLAUDE_PROJECT_DIR`** was the same directory in this run, because the
  session was started at the plugin root. They are not the same thing and only
  the first names the plugin.
- **`process.argv`** was `["<node>", "<plugin root>/src/cli.ts", "hook"]`, so
  the shim resolved the entry point from its own location rather than from the
  working directory.

### Seeing that a hook ran at all

A `SubagentStop` hook that exits 0 in silence and one whose command does not
exist produce the same nothing in a transcript. Two flags separate them:

- `--include-hook-events`, with `--output-format stream-json --verbose`, puts
  `hook_started` and `hook_response` in the stream. `hook_response` carries
  `exit_code`, `stdout`, `stderr` and `outcome`. The failing registration gave
  `"exit_code": 127, "outcome": "error"` with the shell's message in `stderr`;
  the working one gave `"exit_code": 0, "outcome": "success"` with both streams
  empty.
- `--debug-file <path>` records the load — `Read hooks.json for plugin squiz`,
  `Loading hooks from plugin: squiz`, `Registered 1 hooks from 1 plugins` — and
  logs the hook's error line. A plugin that failed to load is told apart from a
  hook that never fired here.

## Limits

- **Only an inline plugin, loaded with `--plugin-dir`.** Whether a plugin
  installed from a marketplace puts its `bin/` on the hook's `PATH` was not
  tested, and nothing here says the two are the same.
- **Where the plugin's `bin/` sits in the Bash tool's `PATH` was not
  recorded**, only that `command -v squiz` found it there. The first two entries
  were the user's own.
- **Whether `${CLAUDE_PLUGIN_ROOT}` is expanded by the runtime or by the shell
  it runs the command under was not distinguished.** Both would work for this
  registration; a command that quoted it differently might not.
- **One machine, one Claude Code version, print mode, one subagent per run,
  `claude-sonnet-5`.** Three runs on macOS.
