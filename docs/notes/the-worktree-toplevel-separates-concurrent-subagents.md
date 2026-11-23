---
settles: "§ 3: how a hook names an episode's worktree, so that two concurrent subagents in two worktrees are two episodes"
issue: 15
recorded: 2026-09-06
versions: { claude-code: 2.1.261, git: 2.50.1 }
recheck-when: Claude Code changes how it sets a hook's working directory
---

# The worktree toplevel separates two concurrent subagents, and `cwd` does not

## Intent

- Whether two concurrent subagents, each in its own git worktree, are told apart
  by the hook.
- Which of the directories a hook can see names the episode's worktree.

## Decisions

- **Locate an episode's worktree with `git rev-parse --show-toplevel`, run from
  the payload's `cwd`.** Across seven firings from two concurrent subagents, each
  resolved the worktree of the subagent that fired it. The toplevel is stable,
  normalised and different per worktree, and every per-episode thing hangs off
  it. It is run from `cwd` because Copilot runs a plugin's hook in the plugin
  root.
- **Never key an episode on `cwd` or the hook's own working directory.** Both are
  the subagent's directory, which is where its dispatcher stood, and equal the
  worktree root only when it was dispatched from there. In a session started at
  `<worktree>/sub`, both were `<worktree>/sub` while the toplevel was
  `<worktree>`. Two sessions in two subdirectories of one worktree would read as
  two episodes.

## Needs your input

Nothing.

## Reference

| Answer | Where it comes from | What it is |
|---|---|---|
| `cwd` | the payload | the subagent's directory |
| `pwd` | the hook process | the subagent's directory |
| `git rev-parse --show-toplevel` | run by the hook | the worktree root |

`git rev-parse --abbrev-ref HEAD` from the hook returns the branch checked out in
that worktree, so the payload need not carry it.

Separating state by toplevel removes contention between worktrees and none
within one: twelve hook processes incrementing one counter file left it at 6.
Every change to an episode's state file is made under `state.lock`.

## Limits

- **Two concurrent episodes in one shared worktree were not run.** What this
  note says about a shared tree is reasoned from the subdirectory result.
- **One run of the concurrent pair**, print mode, `--model sonnet`, macOS, on
  worktrees of a throwaway repository. Nothing about more than two at once.
- **`--include-hook-events` carries no timestamps**, so ordering across two
  sessions has to come from the hook's own clock.
