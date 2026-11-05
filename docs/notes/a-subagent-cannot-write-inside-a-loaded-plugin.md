---
settles: "executing-milestones § 8 — where squiz is loaded from when it is used on this repository's own work"
issue: 272
recorded: 2026-10-03
versions: { claude-code: 2.1.288 }
recheck-when: Claude Code changes how auto mode judges a write inside a loaded plugin's directory
---

# A subagent in auto mode cannot write inside a loaded plugin's directory

## Intent

- Why auto mode refused every `Write` the subagents on #258 and #264 made to
  their worktrees, while squiz was loaded with `claude --plugin-dir ./`.
- How to load squiz on this repository so that a subagent can write to its
  worktree.

## Decisions

- **Load squiz from a checkout outside the repository, never with
  `--plugin-dir ./`.** With `./`, the plugin's directory is the whole repository,
  and every worktree under `.claude/worktrees/` is inside it. A subagent's write
  there is refused. The same write is allowed once the plugin is loaded from
  anywhere else.
- **Refresh that checkout after each merge, and restart only when the merge
  changed `hooks/hooks.json`.** A merged change reaches a session only through
  the checkout it loaded. Each firing of the hook runs `bin/squiz` as a new
  process, so a refreshed `src/` or `bin/` reaches the next round. The session
  reads `hooks/hooks.json` when it starts (unverified).

## Needs your input

Nothing.

## Reference

### The commands

```
git worktree add --detach ../squiz-plugin origin/main     # once
claude --plugin-dir ../squiz-plugin
git fetch -q origin && git -C ../squiz-plugin checkout -q --detach origin/main   # after each merge
```

### What it rests on

Auto mode refused a subagent's `Write` to the repository's worktree whenever this
repository was the loaded plugin, and allowed it with no plugin, with a copy of
the repository loaded from elsewhere, and to a target outside the repository.
Loading `.claude-plugin/plugin.json`, `hooks/hooks.json` or `bin/` alone from
elsewhere did not bring the refusal back, so neither the content, the hook nor
the binaries decides it. What decides it is a subagent writing inside the
directory of a plugin the session has loaded.

A project that installs squiz from the marketplace never writes inside the
plugin's directory, so only work on squiz itself is affected.

## Limits

- In the same sessions, the main session's own edits went through, and so did
  those of three other subagents. Whether every subagent's write inside the
  plugin is refused, or only most, was not established.
- Only `Write` was measured. `Edit`, and a write made through the Bash tool,
  were not.
