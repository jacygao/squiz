---
settles: "§ 6 — which `PATH` a command a person types after `!` in a Claude Code session gets; § 9 — how a Claude Code user runs `squiz doctor` and `squiz init`"
issue: [657, 678]
recorded: 2026-10-07
versions: { claude-code: 2.1.292, plugin-version: 0.1.0, platform: macOS }
recheck-when: Claude Code changes how a plugin's bin/ reaches PATH, or how `!` shell mode starts its shell
---

# A command typed after `!` in Claude Code runs squiz by name

A command a person types after `!` in a Claude Code session gets the plugin's
`bin/` on `PATH`, as the Bash tool does. `! squiz doctor` and `! squiz init` ran
by name from a marketplace install, with no link and no `--plugin-dir`. Claude
Code's documentation says the plugin's `bin/` is on the Bash tool's `PATH`, and
says nothing about `!`.

## Intent

- Whether `!` shell mode has the plugin's `bin/` on `PATH`, so a Claude Code
  user can run `squiz doctor` and `squiz init` before any link exists.

## Decisions

- **Tell a Claude Code user to type `! squiz doctor` and `! squiz init`.** Both
  resolve to the installed copy's `bin/squiz`, which is the squiz the hooks run,
  so the link `squiz init` makes points at the right one.

## Needs your input

Nothing.

## Reference

### Reproducing it

Install into a scratch config from a clean environment, never `~/.claude`:

```sh
env -i HOME=<home> PATH=/usr/bin:/bin:/usr/sbin:/sbin:<node and git dirs> \
  CLAUDE_CONFIG_DIR=<config> claude plugin marketplace add jacygao/squiz
env -i ... CLAUDE_CONFIG_DIR=<config> claude plugin install squiz@squiz
```

Start an interactive `claude` on that config in tmux, with the same clean
environment and no `--plugin-dir`, and type:

```
! command -v squiz; echo "CLAUDECODE=$CLAUDECODE"
  ⎿  <config>/plugins/cache/squiz/squiz/0.1.0/bin/squiz
     CLAUDECODE=1
! squiz doctor; echo "exit $?"
  ⎿  ...
     squiz link: none on PATH. Not required in Claude Code, whose own shell runs squiz; for another coding agent, run squiz init
     exit 0
! squiz init; echo "exit $?"
  ⎿  squiz: linked <home>/.local/bin/squiz to <config>/plugins/cache/squiz/squiz/0.1.0/bin/squiz
     exit 0
```

`CLAUDECODE=1` says the command ran in Claude Code's shell rather than in a
shell that inherited squiz from somewhere else.

### The trap

A terminal started from a session that loads squiz with `--plugin-dir` carries
that plugin's `bin/` too. Run the check from a clean environment, or the `squiz`
found is the checkout's rather than the install's.

## Limits

- **One run, on macOS, at user scope.** Linux was not tried.
- **The run's exact environment was not recorded.** The `env -i` lines above are
  its shape, and the `PATH` they set is (unverified). `!` needs no model, so the
  config's sign-in does not bear on what was seen.
- **Only `PATH` was observed.** Which other variables a `!` command gets beyond
  `CLAUDECODE` was not recorded.
