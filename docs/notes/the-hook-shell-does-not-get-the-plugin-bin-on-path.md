---
settles: "§ 3 — whether the hook registration can name the `squiz` binary directly; § 6 and § 9 — whether a marketplace install puts the plugin's bin/ on the Bash tool's PATH"
issue: [39, 54]
recorded: 2026-09-09
versions: { claude-code: 2.1.263 and 2.1.285, node: 24.15.0 }
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
- **A hook that cannot resolve its command looks exactly like a hook with
  nothing to say.** Both leave an empty transcript. Nothing about the plugin
  loading says the command will run, so the two are told apart by the exit code
  in the event stream rather than by output.
- **The name the coding agent runs resolves under an install as it does under
  `--plugin-dir`.** An install puts the plugin's `bin/` on the Bash tool's `PATH`,
  so `squiz threads` and `squiz reply` find the binary either way. What was
  established is the lookup of `squiz` itself; which commands it dispatches is its
  own question and nothing here measures it.

## Needs your input

Nothing. § 6 now says which `PATH` each caller gets and registers the hook
through `${CLAUDE_PLUGIN_ROOT}`. 2026-10-05: the registration is now in § 3 The
Claude Code hooks, on `Stop` as well as `SubagentStop`.

## Reference

### The command that runs

```
${CLAUDE_PLUGIN_ROOT}/bin/squiz hook
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

### Under a marketplace install

An install reaches the same two places as `--plugin-dir`, and needs no
interactive session to set up. The marketplace takes a path, so the repository is
its own marketplace while one is being tested:

```
claude plugin marketplace add <repository> --scope local
claude plugin install squiz@<marketplace> --scope local
```

Both want a `.claude-plugin/marketplace.json` naming the plugin with
`"source": "./"`. `claude plugin list` reads the install back, and
`claude plugin uninstall` and `claude plugin marketplace remove` undo it.

In a session started after that install, with no `--plugin-dir`:

- **The Bash tool's `PATH` held the plugin's `bin/`.** `command -v squiz`
  resolved to it, and the entry sat 16th. The entries before it were the user's
  own.
- **The `SubagentStop` hook ran and exited 0**, so `${CLAUDE_PLUGIN_ROOT}`
  resolves under an install as it does under `--plugin-dir`. The stream carried:

  ```json
  {"subtype":"hook_started","hook_name":"SubagentStop","hook_event":"SubagentStop"}
  {"subtype":"hook_response","hook_name":"SubagentStop","stdout":"","stderr":"","exit_code":0,"outcome":"success"}
  ```

  Both streams empty and the exit 0 are what say the path resolved: a
  `CLAUDE_PLUGIN_ROOT` that did not expand gives 127 and the shell's message on
  `stderr`, which is the failing registration recorded above.

- **`--debug-file` recorded the load**: `Read hooks.json for plugin squiz
  (enabled=true)`, `Loading hooks from plugin: squiz`, then `Registered 1 hooks
  from 2 plugins` — the second being a built-in.

**Print mode fires `SubagentStop`.** An earlier attempt to see it with `--debug`
and a hook rewritten to leave a file behind observed nothing and read that as
print mode running no hook at all. That was the wrong instrument rather than a
finding: `--include-hook-events` with `--output-format stream-json --verbose` is
what puts the firing in the stream, and it was there.

## Limits

- **The install was from a directory, not from a git host.** The marketplace
  source was the repository, so the plugin that ran was the repository and the
  `PATH` entry was its own `bin/`. An install from a remote marketplace copies
  the plugin elsewhere, and the entry would be that copy's `bin/`. What was
  established is that an install extends the Bash tool's `PATH` with the plugin's
  `bin/`, not the literal path it extends it with.
- **The install was declared at `local` scope.** Whether `user` scope resolves
  `CLAUDE_PLUGIN_ROOT` differently was not tested.
- **Whether `${CLAUDE_PLUGIN_ROOT}` is expanded by the runtime or by the shell
  it runs the command under was not distinguished.** Both would work for this
  registration; a command that quoted it differently might not.
- **One machine, print mode, one subagent per run, `claude-sonnet-5`.** Three
  runs on macOS for the `--plugin-dir` findings and one for the install.
