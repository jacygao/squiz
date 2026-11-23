---
settles: "§ 3 Parallel coding agents: which directory a subagent's SubagentStop hook runs in"
issue: 264
recorded: 2026-10-03
versions: { claude-code: 2.1.288 }
recheck-when: Claude Code changes how it sets a hook's working directory, or where it puts a worktree-isolated subagent's worktree
---

# A subagent's hook runs where it was dispatched

## Intent

- Which directory a subagent's `SubagentStop` hook runs in, and whether anything
  the subagent or its dispatcher does later moves it.
- Whether `isolation: "worktree"` on the Agent call puts the hook in the
  subagent's own worktree.

## Decisions

- **Dispatch a subagent that opens a pull request with `isolation: "worktree"`,
  and have it run `git switch -c <branch> origin/main` first.** The hook then
  runs in `.claude/worktrees/agent-<agent_id>`, git resolves the subagent's own
  branch there, and squiz reviews the right pull request.
- **Never dispatch such a subagent by path.** Its hook runs in the directory the
  dispatcher's shell stood in at the moment of the Agent call, usually the
  primary tree on `main`. Telling the subagent to work in another tree, and the
  subagent `cd`ing there, change nothing.
- **Resolve the worktree from the payload's `cwd`.** Under Claude Code it
  equalled the hook's own working directory in every firing. Copilot runs a
  plugin's hook in the plugin root, so only `cwd` names the session's
  directory under both.
- **Do not depend on `agent-<id>.meta.json`.** It is undocumented, and nothing
  else says whether a subagent was isolated.

## Needs your input

Nothing.

## Reference

Where the hook ran, with the session started in `repo/` on `main`:

| Dispatch | Hook `pwd` and payload `cwd` | Branch git resolved |
|---|---|---|
| Told to `cd .claude/worktrees/x`, which is on `feat/x` | `repo` | `main` |
| In the background, then the parent `cd`s into `x` | `repo` | `main` |
| The parent `cd`s into `x`, dispatches, then `cd`s back | `repo/.claude/worktrees/x` | `feat/x` |
| `isolation: "worktree"` | `repo/.claude/worktrees/agent-<agent_id>` | `worktree-agent-<agent_id>` |
| `isolation: "worktree"`, then `git switch -c <branch> origin/main` | `repo/.claude/worktrees/agent-<agent_id>` | `<branch>` |

`CLAUDE_PROJECT_DIR` was `repo` in every case. The payload had the fields that
`agent-id-names-one-subagent-and-prompt-id-does-not.md` records, and none says
whether the subagent was isolated.

What isolation leaves behind:

- The Agent result carries `worktreePath`, the isolated worktree's absolute
  path, and `worktreeBranch`.
- The worktree is created from `origin/main`, not from the dispatcher's `HEAD`.
- It is kept when the subagent left changes in it.
- The `worktree-agent-<agent_id>` branch stays after the subagent switches off
  it, and nothing removes it.
- `agent-<agent_id>.meta.json`, beside the subagent's transcript, carries
  `worktreePath` for isolated subagents only.

## Limits

- **Print mode only, one `general-purpose` subagent per session.** Concurrent
  isolated subagents, and other agent types, were not run.
- **Only `origin/main` as the isolation base.** Whether isolation can start from
  another ref was not tested.
- **A subagent resumed with `SendMessage`** was not run, so whether its hook
  stays in the isolated worktree is unknown.
