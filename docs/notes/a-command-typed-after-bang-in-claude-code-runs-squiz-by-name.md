---
settles: "§ 7: which `PATH` a command a person types after `!` in a Claude Code session gets; § 10: how a Claude Code user runs `squiz doctor` and `squiz init`"
issue: [657, 678]
recorded: 2026-10-07
versions: { claude-code: 2.1.292, plugin-version: 0.1.0, platform: macOS }
recheck-when: Claude Code changes how a plugin's bin/ reaches PATH, or how `!` shell mode starts its shell
---

# A command typed after `!` in Claude Code runs squiz by name

## Intent

- Whether `!` shell mode has the plugin's `bin/` on `PATH`, so a Claude Code
  user can run `squiz doctor` and `squiz init` before any link exists.

## Decisions

- **Tell a Claude Code user to type `! squiz doctor` and `! squiz init`.** A
  command typed after `!` gets the plugin's `bin/` on `PATH`, as the Bash tool
  does, so both resolve to the installed copy's `bin/squiz`. That is the squiz
  the hooks run, so the link `squiz init` makes points at the right one. Claude
  Code's documentation says this of the Bash tool and nothing of `!`.

## Needs your input

Nothing.

## Reference

From a marketplace install, with no link and no `--plugin-dir`:

```
! command -v squiz; echo "CLAUDECODE=$CLAUDECODE"
  ⎿  <config>/plugins/cache/squiz/squiz/0.1.0/bin/squiz
     CLAUDECODE=1
! squiz init; echo "exit $?"
  ⎿  squiz: linked <home>/.local/bin/squiz to <config>/plugins/cache/squiz/squiz/0.1.0/bin/squiz
     exit 0
```

`CLAUDECODE=1` says the command ran in Claude Code's shell rather than in a
shell that inherited squiz from somewhere else.

**A terminal started from a session that loads squiz with `--plugin-dir`
carries that plugin's `bin/` too.** Check from a clean environment, or the
`squiz` found is the checkout's rather than the install's.

## Limits

- **One run, on macOS, at user scope.** Linux was not tried.
- **Only `PATH` was observed.** Which other variables a `!` command gets beyond
  `CLAUDECODE` was not recorded.
