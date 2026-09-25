---
settles: "§ 7 — what becomes of a detached reviewer when the runtime kills the hook, what is left to stop it, and what sets the 600-second ceiling"
issue: 142
recorded: 2026-09-25
versions: { claude-code: 2.1.270, node: 24.15.0, pi: 0.85.1 }
recheck-when: Claude Code changes how it kills a hook that reaches its timeout, or changes the subagent stall watchdog
---

# The runtime kills the reviewer too, but only its `SIGTERM` is certain

## Intent

- **Nothing said whether the runtime signals the hook alone or its whole process
  group.** The reviewer is started with `detached: true`, which puts it in a
  process group of its own, so a signal sent to the hook's group no longer
  reaches the reviewer as a side effect.
- **Nothing said whether the reviewer is still running once the hook is killed,
  or what would stop it if it were.** An orphaned reviewer goes on spending
  against the model API with no episode left to record it, and at depth `deep` it
  goes on running shell commands in the work tree after everything that would
  have noticed is gone.
- **Nothing said whether 600 seconds is the runtime's default or its maximum.**
  If it is a default a project can raise, the review budget is a trade a project
  chooses rather than a wall, and a large diff can be reviewed properly. If it is
  a maximum, a review that outlives it can never complete, and the only remedy
  left is the reviewer reporting each finding as it makes it.

## Decisions

- **Nothing has to be built to stop the reviewer, or a tool it is still running,
  because the runtime reaches those.** At the ceiling the runtime sends `SIGTERM`
  to the hook's process group and, separately, to every descendant of the hook by
  process id. The reviewer is signalled in its own right, and so is each tool it
  started. `detached: true` is safe to keep on that count: it takes the reviewer
  out of the hook's group and leaves it a descendant of the hook. What the runtime
  does not reach is a process that has left the hook's chain of parents, and the
  limit below says how one arises.
- **The reviewer, and every tool it starts, has to exit on `SIGTERM`. Nothing
  else about the kill is certain.** The runtime escalates to `SIGKILL` about a
  second and a half later, but only if the runtime is itself still running by
  then. Where the session ended inside that grace, nothing was ever killed
  outright, and processes that ignored `SIGTERM` ran on until they chose to stop.
  `pi` 0.85.1 exits on `SIGTERM` in the middle of a request, so the reviewer the
  harness runs today is stopped by the first signal.
- **A reviewer that ignores `SIGTERM` is unbounded, and the harness has no way to
  reach it.** The `SIGKILL` is the runtime's to send or not, and the harness is
  not there to send one of its own: it is signalled in the same instant as the
  reviewer, and a Node process with no handler for `SIGTERM` exits on it. None of
  the round's own cleanup runs. Such a reviewer spends with no episode left to
  record it, and at depth `deep` goes on running commands in the work tree.
- **The 600-second ceiling is the runtime's subagent stall watchdog, not the
  hook's `timeout`, and raising the declared timeout on its own moves nothing.**
  A hook declaring 900 was killed at 599.9 seconds, twice. The declared value is
  neither clamped nor rejected; it is simply never reached. A subagent that makes
  no progress for 600 seconds is failed, and a hook the runtime is waiting on is
  cancelled with it — and a `SubagentStop` hook that runs long is exactly a
  subagent making no progress, because the subagent cannot finish while the hook
  holds it. With the watchdog moved out of the way the same hook, declaring the
  same 900, ran past 600 seconds and past 900 without being signalled at all.
- **A round that reaches the ceiling fails the coding agent's subagent, rather
  than only losing the review.** The subagent is recorded as failed, and the
  parent turn is told the subagent call was interrupted and that nothing ran. The
  coding agent is left believing the work it dispatched did not happen.

## Needs your input

- **Whether § 7 should go on saying that the harness declares the hook's
  ceiling.** The harness does declare 600 in its own registration, and that
  declaration is not what ends a round at 600 seconds. Recommendation: say the
  ceiling is the runtime's subagent stall watchdog, keep the declared 600 as the
  statement of what a round budgets for, and change no number. A declared value
  below the watchdog is honoured exactly, so the registration still bounds a
  round that would otherwise run away inside the window.
- **Whether § 7 should say that reaching the ceiling fails the subagent.** Its
  failure row says only that the turn ends with nothing posted. The coding agent
  is also told its subagent stalled and that nothing ran. Recommendation: add it
  to the row, because a reader sizing the time bound is choosing how likely that
  is.
- **Whether to raise the ceiling, now that it is known to be raisable.** It moves
  with an environment variable rather than with anything in `hooks/hooks.json`,
  so raising it means every developer's shell has to carry a setting, and a
  review that outlives 600 seconds still fails the coding agent's subagent rather
  than finishing quietly. Recommendation: leave the ceiling where it is and go on
  having the reviewer report each finding as it makes it. That the ceiling can be
  raised makes reporting-as-you-go a choice rather than the only remedy, which is
  worth knowing, and it does not make raising the ceiling the better one.
- **Whether the adapter contract in § 4 should require a reviewer that exits on
  `SIGTERM`.** Recommendation: yes. It is the only bound on a reviewer once the
  runtime has killed the hook, and an adapter for a reviewer that ignores the
  signal cannot be made safe from inside this harness.

## Reference

### What ends a round at 600 seconds

The runtime's subagent stall watchdog, whose threshold was 600 seconds. It is
read from `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS`, in milliseconds, when that is
set; setting it to 1800000 moved the ceiling to 1800 seconds.

What the runtime says when the watchdog fires, all of it in the stream:

- `task_updated` carries `"status": "failed"` and the error
  `Agent stalled: no progress for 600s (stream watchdog did not recover)`
- `task_notification` repeats that sentence as its `summary`
- the hook's own `hook_response` says only `"outcome": "cancelled"`

Nothing else announces it. The hook's stderr is empty, the session's stderr is
empty, and no message anywhere says that the hook's declared timeout was not
reached.

The watchdog defers while the subagent has a tool call in flight *(unverified —
read out of the 2.1.270 binary rather than run)*.

### The hook's own `timeout`, and what it is worth

`timeout`, in seconds, on the hook's entry in `hooks/hooks.json`. Below the
watchdog it is honoured exactly: a declared 5 brought `SIGTERM` between 4.92 and
4.98 seconds every time, and the subagent then finished normally. Above the
watchdog it is worth nothing, because the watchdog cancels the hook first.

The field takes any positive number *(unverified — read out of the 2.1.270
binary, where it carries no maximum)*, so a declared 900 is accepted rather than
refused.

### What the runtime does at the ceiling

In order, and none of it conditional on the hook's own behaviour:

1. `SIGTERM` to the hook's process group.
2. `SIGTERM` to every descendant of the hook, by process id, whatever group each
   one is in. Both arrive in the same instant.
3. About 1.5 seconds later, `SIGKILL` to the group and to those same
   descendants — but only if the runtime process is still alive then.

Five positions were measured, and the first two signals together reached all of
them: the hook itself; a child of the hook in the hook's group; a process in the
hook's group that had been reparented to init, which only a group signal can
reach; a detached grandchild leading a group of its own, which only a per-process
signal can reach; and a child of that grandchild, in the grandchild's group. The
detached grandchild stands for the reviewer and its child for a tool the reviewer
started.

### What the runtime reports about a hook it killed

A `hook_response` event carries `"outcome": "cancelled"`, and `exit_code` 143
where the hook exited on the `SIGTERM` or 1 where it ignored the signal and was
killed outright. `stdout` was empty in both cases.

**`outcome` does not tell a killed hook from one that ran to the end.** The hook
that was never signalled, and that exited 0 of its own accord after 1118 seconds,
was also reported `"outcome": "cancelled"` — with `exit_code` 0. Read the exit
code, not the outcome.

**Anything the hook wrote to stderr before the kill is kept.** It comes back in
that event's `stderr` and `output` fields, verbatim.

### Whether the escalation happens

It turns on the runtime still running when the grace ends. In the runs where the
session's last output came after the end of the grace, every process that
ignored `SIGTERM` was killed outright 1.46 to 1.48 seconds after being
signalled. In the runs where the session's last output came before the end of
the grace — by 65 and by 305 milliseconds — nothing was killed outright at all,
and every process that ignored `SIGTERM` ran on for a further 35 seconds and
then exited on its own.

## Limits

- **Two of six runs saw the tree survive, and both were the same shape:** one
  subagent, its stop the last thing in the turn, so the session ended moments
  after the kill. This says which condition decides it, not how often the
  condition holds in a real episode.
- **Print mode only.** Every run was `claude -p`. An interactive session does not
  exit when a turn ends, so the escalation would presumably fire — untested, and
  it is the whole of what decides whether a deaf reviewer survives.
- **macOS only, on one machine, against Claude Code 2.1.270.** On Windows the
  hook is not spawned in a group of its own *(unverified — read out of the
  2.1.270 binary rather than run)*, so none of the group half of this applies
  there.
- **A tool's own background child can leave both of the runtime's targets, and
  nothing here measured it.** The targets are the hook's process group and the
  hook's descendants by process id. A tool inherits the *reviewer's* group, which
  is not the hook's, so a child the tool leaves running and then exits from is
  reparented away from the hook: outside the descendant walk, and never inside
  the hook's group. Neither signal reaches it, whether or not it would have
  obeyed `SIGTERM`.

  The round's own bound does reach it, because that signals the reviewer's group
  rather than the hook's. So this is a gap in the runtime's cleanup at the
  ceiling rather than in the round's. Measuring that topology is what would close
  it.
- **The runtime's default hook timeout was never measured.** The run that
  declared no `timeout` was killed at 599.8 seconds by the watchdog, which fires
  at very nearly the same number. Nothing here separates the two, so whether the
  default is also 600 seconds is unestablished.
- **Whether a declared timeout above 600 is ever enforced.** Once the watchdog
  was moved, a declared 900 was not enforced within 1118 seconds — 1.24 times its
  own value — and the run ended because the hook exited rather than because
  anything stopped it. That the runtime reported the outcome as cancelled leaves
  it open that it had given up on the hook earlier and merely never killed it.
- **No timing past 600 seconds in that run is precise.** Its probe's
  200-millisecond heartbeat fired 2093 times across 1118 seconds, and its
  1000-second lifetime timer fired at 1118 seconds, so the process's timers were
  being starved by more than half. That nothing was ever signalled is read from
  the process's own log and from sampling `ps` from outside it, neither of which
  is a timing measurement; the 1118 itself is soft.
- **Only `SubagentStop` was measured.** The watchdog belongs to a subagent, so a
  `Stop` or `PreToolUse` hook that runs long has no stalling subagent behind it
  and may reach its own declared timeout instead. Untested, and the harness does
  not use those events.
- **`pi`'s answer to `SIGTERM` is one observation.** One prompt, the `read`
  grant, killed 0.9 seconds into the request: gone within 51 milliseconds, status
  143. Whether a `bash` tool subprocess in flight changes it was not measured.
- **Nothing here says what the runtime does to a hook it cancels for a reason
  other than the timeout or the watchdog.** An interrupted session and an
  abandoned turn both end a hook that is still running, and neither was run.
