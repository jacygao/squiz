---
settles: "§ 4: where a worktree subagent's local review is kept, how it wakes the parent, where its outcome is read, and whether the local venue runs `gh`"
issue: 798
recorded: 2026-11-07
versions: { claude-code: 2.1.319, coding-agent: claude-opus-5-5, reviewer: "pi 0.85.1 on openai/gpt-5.4-mini", herdr: 0.9.3, node: 24.15.0, git: 2.54.0, squiz: fa88578 }
recheck-when: Claude Code changes where it puts a worktree-isolated subagent's worktree, or whether its Bash tool keeps a `cd`; or the local venue's head build or owner note changes
---

# An interactive session works a subagent's local review to exit 0

## Intent

- Whether a subagent dispatched into a worktree of its own gets its own
  `.squiz/local/` and is reviewed there.
- Whether findings and replies land in `threads.json`, and the result wakes the
  parent.
- Whether a rerun reaches exit 0.
- Whether anything squiz runs calls `gh`.
- Whether the outcome can be read afterwards: each finding, its replies, and
  whether it was resolved.

## Decisions

- **Count a worktree subagent as reviewed in its own worktree.** Each
  subagent's rounds, `state.json`, `threads.json` and `summary.md` were under
  `.claude/worktrees/agent-<id>/.squiz/local/`. Each record a hook queued there
  named that subagent as owner. The root's `.squiz/local/` held only the root's
  own states.
- **Count the wake as working in the local venue.** Each round a hook started
  ended with `noted its owner` and `woke its owner through
  /tmp/cc-socks/<pid>.sock` in `host.log`, and the note reached the parent's
  pane. A round started by `squiz review` recorded no owner and woke no one, as
  in the GitHub venue.
- **Expect a subagent's review to reach exit 0 locally.** In each subagent's
  worktree the reviewer opened one thread on a planted off-by-one, the fix was
  answered with `squiz reply` and ruled `fixed` in round 2, and `squiz review`
  printed `closed after 2 rounds, with nothing open` and exited 0.
- **Expect the parent's own tree to review cleanly beside its subagents'
  worktrees.** The head build leaves out a worktree of the same repository
  whose path the base lacks, and the owner's note runs its command in a
  subshell, `(cd '<worktree>' && squiz review)`, so the parent's shell stays in
  its own tree (unverified: no session has run with both in place). A
  worktree left in the change reads as a gitlink the reviewer reports, and a
  shell left in a subagent's worktree fires the parent's next `Stop` there.
- **Read a worktree's outcome from `threads.json` and `summary.md`.** Each
  thread held the reviewer's finding as `C1`, the coding agent's reply as `C2`,
  the reviewer's `fixed` ruling as `C3`, and `isResolved: true`. Each summary
  read `2 rounds, 1 finding` and `Fixed 1 · Withdrawn 0 · Open 0 · Disputed 0`.
- **Count the local venue as running no `gh`.** A logging `gh` first on `PATH`
  for the session, its hooks, the round host and the reviewer logged one call,
  `gh auth token`, made by the `claude` process itself at startup. Squiz made
  none.

## Needs your input

Nothing.

## Reference

| Result | Where it shows |
|---|---|
| A subagent reviewed in its worktree | `host.log` there: `round 1: reviewing f13ec17`, `f13ec17 reviewed, 1 threads open`, then `round 2: reviewing 4381b80 with reply C2` and `episode closed (nothing-open)` |
| The wake | `host.log`'s `woke its owner` line, the note under `.squiz/local/notes/<session id>/delivered/`, and the parent's pane |
| No ref written | `git for-each-ref` lists `main` and the worktree branches only |

**The head the note names is not in `git log --all`.** Its objects are in
`.squiz/local/objects/`, as § 4 The change sets out. The parent, told the head
`6ab3d30`, said the subagent had committed another commit instead.

**Claude Code itself runs `gh auth token` at startup.** A log of `gh` calls
proves squiz made none only once each call is attributed to its parent process.

## Limits

- **One run, one coding model and one reviewer model.**
- **Only the second subagent's wake carried a finding.** The first's
  hook-started round failed on the reviewer's balance, and the parent retried it
  with its own `squiz review`, which records no owner.
- **The second fix was made by the subagent**, which the parent sent the thread
  back to with `SendMessage`.
- **Neither fix was committed.** Each round 2 reviewed an uncommitted edit.
- **Exit 0 was read from the session's pane**, not from a process of the run's
  own.
- **What the `SubagentStop` hook did for Claude Code's `prompt_suggestion`
  forked agent was not looked at.** It fired after each of the parent's turns,
  and no record named it as an owner.
