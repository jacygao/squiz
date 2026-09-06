---
settles: "§ 3 — whether two concurrent subagents are separated by their worktree toplevel"
issue: 15
recorded: 2026-09-06
versions: { claude-code: 2.1.261, git: 2.50.1 }
recheck-when: Claude Code changes how it sets a hook's working directory
---

# The worktree toplevel separates two concurrent subagents, and `cwd` does not

Two subagents were run at once, each in its own git worktree on its own branch,
and every hook firing resolved the worktree of the subagent that fired it. The
hook's working directory was the worktree, not the repository root, so § 3's
one worktree, one branch, one pull request, one episode holds. But the hook is
given the session's directory, not the worktree root: a session started in a
subdirectory of a worktree produced a `cwd` inside that subdirectory while
`git rev-parse --show-toplevel` still returned the worktree root.

## Decisions

- **An episode is located by `git rev-parse --show-toplevel`, resolved from the
  hook's own working directory.** It is the only one of the three available
  answers that is stable, normalised and different per subagent. § 3's
  shared-tree detection already compares this value, and the same value is what
  every other per-episode thing hangs off.
- **The harness must not use `cwd` from the payload, nor the hook process's own
  working directory, as the episode's directory or as a key.** Both are the
  session's directory. They equal the worktree root only when the session was
  started at the worktree root, which is the dispatcher's habit rather than a
  guarantee. Two sessions started in two subdirectories of one shared worktree
  would carry two different `cwd` values and one toplevel, so keying on `cwd`
  would read a shared tree as two separate episodes — the exact failure § 3's
  shared-tree detection exists to catch.
- **§ 3 holds as written.** Nothing here contradicts it. The refinement is that
  "each hook resolves its own working directory" has to mean resolving that
  directory through git, not reading it.
- **The spike's per-run state is separated by toplevel, opt-in.** Setting
  `SQUIZ_SPIKE_SPLIT_BY_TOPLEVEL` to a non-empty value gives each worktree its
  own subdirectory under `SQUIZ_SPIKE_DIR`. The default layout is unchanged, so
  the other M0 subtasks that extend the same script are unaffected.

## Needs your input

Nothing.

## Reference

### The three directory answers, per firing

Every `SubagentStop` firing offers three, and they are not interchangeable:

| Answer | Where it comes from | What it is |
|---|---|---|
| `cwd` | the payload, given by the runtime | the session's directory |
| `pwd` | the hook process itself | the session's directory |
| `git rev-parse --show-toplevel` | computed by the hook | the worktree root |

Across seven firings from the two concurrent subagents, all three agreed,
because both sessions were started at their worktree roots. In a session started
at `<worktree>/sub`, `cwd` and the hook's `pwd` were both `<worktree>/sub` and
`--show-toplevel` was `<worktree>`. That is the case that separates them.

`git rev-parse --abbrev-ref HEAD` from the hook returned the branch checked out
in that worktree, so the branch is available from the hook without being carried
in the payload.

### Shared state between two concurrent hooks

Two hooks pointed at one state directory really do corrupt it. Twelve hook
processes run concurrently against one `SQUIZ_SPIKE_DIR` left the invocation
counter at 6 and wrote 12 records carrying only 6 distinct invocation numbers:
the read-modify-write on the counter file loses increments, and both worktrees'
records land in one log. With `SQUIZ_SPIKE_SPLIT_BY_TOPLEVEL` set, the same
twelve produced two directories, each holding only its own worktree's records.

The split removes contention *between* worktrees. It does not make the counter
atomic, so several hooks firing at once within one worktree still lose counts.
In the concurrent run each worktree had at most one hook in flight, and the two
counters ended exact.

### Resuming a subagent fires the hook again

One of the two dispatching agents sent a follow-up to its subagent with
`SendMessage`, addressed to the subagent's `agent_id`. That resumed the same
subagent, and when it stopped again `SubagentStop` fired once more with the same
`agent_id` and with `stop_hook_active` back to `false`. So a firing with
`stop_hook_active: false` is not reliably the first firing of an episode, and an
episode can outlive the block budget being spent.

## Limits

- **Two concurrent episodes in one shared worktree were not run.** The
  shared-tree branch of § 3 is reasoned from the subdirectory result above, not
  observed live.
- **The subagent could not move its own shell out of the worktree.** A bare
  `cd /private/tmp` as its own Bash call did not persist: the next `pwd` was the
  worktree again. Nothing here says what a hook's working directory would be in
  a runtime where it does persist.
- **One run of the concurrent pair**, print mode, `--model sonnet`, macOS, on
  worktrees of a throwaway repository rather than of this one. No evidence about
  stability across runs, models, interactive sessions, or more than two at once.
- **`--include-hook-events` carries no timestamps.** `hook_started` and
  `hook_response` have `hook_id`, `session_id` and the exit code, so ordering
  across two sessions has to come from the hook's own clock.
