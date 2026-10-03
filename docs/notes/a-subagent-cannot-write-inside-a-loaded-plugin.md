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
- **Refresh that checkout after each merge, then restart the session.** A merged
  change reaches a session only through the checkout it loaded, so the refresh is
  the step that delivers it.

## Needs your input

Nothing.

## Reference

### The commands

```
git worktree add --detach ../squiz-plugin origin/main     # once
claude --plugin-dir ../squiz-plugin
git fetch -q origin && git -C ../squiz-plugin checkout -q --detach origin/main   # after each merge
```

### The refusal

```
The server-side auto mode classifier gave no verdict (it skipped this action), so auto mode cannot determine the safety of Write. This is a hard failure, not a transient one …
```

### The measurement

Each row is one `claude -p --permission-mode auto` session in a worktree of this
repository, where a `general-purpose` subagent `Write`s a file.

| Plugin loaded | Target | Result |
|---|---|---|
| this repository | a 248-line note in the worktree, three runs | refused 3 of 3 |
| none | the same note, three runs | written 3 of 3 |
| this repository | a three-line plain note in the worktree | refused |
| `plugin.json` alone, from the scratchpad | the 248-line note | written |
| `hooks/hooks.json` alone, from the scratchpad | the 248-line note | written |
| `bin/` alone, from the scratchpad | the 248-line note | written |
| a copy of this repository, from the scratchpad | the three-line note in the worktree | written |
| this repository | the three-line note in the scratchpad | written |

Neither the content, the hook nor the binaries decides it. What decides it is a
subagent writing inside the directory of a plugin the session has loaded.

A project that installs squiz from the marketplace never writes inside the
plugin's directory, so only work on squiz itself is affected.

## Limits

- In the same sessions, the main session's own edits went through, and so did
  those of three other subagents. Whether every subagent's write inside the
  plugin is refused, or only most, was not established.
- Only `Write` was measured. `Edit`, and a write made through the Bash tool,
  were not.
