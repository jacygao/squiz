---
settles: "§ 3 — which directory a subagent's SubagentStop hook runs in, and where a hook's stderr goes when it exits 0"
issue: 264
recorded: 2026-10-03
versions: { claude-code: 2.1.288 }
recheck-when: Claude Code changes how it sets a hook's working directory, or how it reports a hook that exits 0
---

# A subagent's hook runs where the subagent was dispatched, and isolation puts it in the subagent's worktree

## Intent

- Which directory a subagent's `SubagentStop` hook runs in, and whether anything
  the subagent or its dispatcher does later moves it.
- Whether `isolation: "worktree"` on the Agent call puts the hook in the
  subagent's own worktree.
- Where a line a hook writes to stderr goes when it exits 0.

## Decisions

- **Dispatch a subagent that opens a pull request with `isolation: "worktree"`,
  and have it run `git switch -c <branch> origin/main` first.** The hook then
  runs in `.claude/worktrees/agent-<agent_id>`, git resolves the subagent's own
  branch there, and the existing gate reviews the right pull request with no
  code change.
- **Never dispatch such a subagent by path.** Its hook runs in the directory the
  dispatcher's shell stood in at the moment of the Agent call, usually the
  primary tree on `main`. Telling the subagent to work in another tree, and the
  subagent `cd`ing there, change nothing.
- **Resolve the worktree from the hook's own working directory, as the code
  already does.** The payload's `cwd` equals it in every firing, so reading
  `cwd` adds nothing. 2026-10-06: the hook now resolves the worktree from the
  payload's `cwd`, because Copilot runs a plugin's hook in the plugin root.
  Under Claude Code the two are still the same directory.
- **Do not depend on `agent-<id>.meta.json`.** It is undocumented, and nothing
  else says whether a subagent was isolated.
- **Write the gate's pass to stderr, and do not count on a person seeing it.**
  In print mode the line reaches the subagent's transcript, the debug log, and
  the stream only under `--include-hook-events`. Neither the parent's model nor
  the result is given it.

## Needs your input

- **Whether an interactive session shows an exit-0 hook's stderr to a person.**
  Print mode cannot show it. Recommendation: look once, in an interactive
  session, at a subagent stopping on a branch with no pull request. If nothing
  appears, the pass line is a record for whoever reads the transcript, and the
  only defence against a mis-dispatched subagent is the dispatch shape above.

## Reference

### Where the hook ran, per dispatch

Five print-mode sessions, each dispatching one `general-purpose` subagent, with a
plugin whose `SubagentStop` hook logged `pwd`, the toplevel, the branch,
`CLAUDE_PROJECT_DIR` and the payload. The session started in `repo/`, on `main`.

| Dispatch | Hook `pwd` and payload `cwd` | Branch git resolved |
|---|---|---|
| By path: told to `cd .claude/worktrees/x`, which is on `feat/x` | `repo` | `main` |
| In the background, then the parent `cd`s into `x` | `repo` | `main` |
| The parent `cd`s into `x`, dispatches, then `cd`s back | `repo/.claude/worktrees/x` | `feat/x` |
| `isolation: "worktree"`, no switch | `repo/.claude/worktrees/agent-aad3baa0e112f5313` | `worktree-agent-aad3baa0e112f5313` |
| `isolation: "worktree"`, then `git switch -c area/probe-e origin/main` | `repo/.claude/worktrees/agent-ac35bf69e15948fdd` | `area/probe-e` |

`CLAUDE_PROJECT_DIR` was `repo` in all five. The payload had the same fourteen
fields that `an-episode-keys-on-agent-id.md` records, with `agent_type`
`general-purpose`. No field says whether the subagent was isolated.

### What isolation leaves behind

- The Agent result carries `worktreePath`, the isolated worktree's absolute
  path, and `worktreeBranch`.
- The worktree is created from `origin/main`, not from the dispatcher's `HEAD`.
- It is kept when the subagent left changes in it.
- The `worktree-agent-<agent_id>` branch stays after the subagent switches off
  it, and nothing removes it.
- `agent-<agent_id>.meta.json`, beside the subagent's transcript, carries
  `worktreePath` for isolated subagents only.

### Where an exit-0 hook's stderr went

A hook that wrote one line to stderr and exited 0:

- **The subagent's transcript** carries it as an attachment:

  ```json
  {"type":"hook_success","hookName":"SubagentStop","hookEvent":"SubagentStop",
   "stdout":"","stderr":"squiz: I264-STDERR-MARKER no open pull request has main as its head\n",
   "exitCode":0}
  ```

- **`--debug-file`** logs `Hook SubagentStop (SubagentStop) success:` followed by
  the line.
- **The `stream-json` output** carries it only with `--include-hook-events`, as
  the `stderr` and `output` of a `hook_response` event. Without that flag there
  is no `SubagentStop` event in the stream at all.
- **The parent session's transcript and the result** do not carry it. Asked to
  report any hook output it saw, the parent said it saw none.

## Limits

- **Print mode only.** What an interactive session displays was not observable.
- **One subagent per session, `general-purpose` only.** Concurrent isolated
  subagents, and other agent types, were not run.
- **Only `origin/main` as the isolation base.** Whether isolation can start from
  another ref was not tested.
- **A subagent resumed with `SendMessage`** was not run, so whether its hook
  stays in the isolated worktree is unknown.
