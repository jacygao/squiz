---
settles: "§ 2 — what the runtime sends the processes under a hook it kills, and what fails a subagent at 600 seconds; § 3 — why a hook only queues and the round runs outside it; § 4 — that a reviewer CLI must exit on SIGTERM"
issue: 142
recorded: 2026-09-25
versions: { claude-code: 2.1.270, node: 24.15.0, pi: 0.85.1 }
recheck-when: Claude Code changes how it kills a hook that reaches its timeout, or changes the subagent stall watchdog
---

# The runtime signals a hook's whole tree, but only its `SIGTERM` is certain

When this was measured the reviewer ran under a `SubagentStop` hook. It now runs
in the round host, outside every trigger's process, and the hook only queues.
What was measured is why.

## Intent

- **Whether the runtime signals a hook alone, its process group, or every
  process under it**, including one that leads a group of its own.
- **Whether a process under the hook is still running once the hook is killed,
  and what would stop it.**
- **Whether 600 seconds is the hook's timeout or something else.**

## Decisions

- **Run nothing that must survive under a hook or a shell call.** At the ceiling
  the runtime sends `SIGTERM` to the hook's process group and, separately, to
  every descendant of the hook by process id, whatever group each is in. A
  process started with `detached: true` under the hook is still signalled. What
  the runtime does not reach is a process that has left the hook's chain of
  parents, which is how the round host is started.
- **Require a reviewer CLI, and every process it starts, to exit on `SIGTERM`.
  Nothing else about a stop from outside is certain.** The runtime escalates to
  `SIGKILL` about a second and a half later, but only if the runtime is itself
  still running by then. Where the session ended inside that grace, nothing was
  killed outright, and processes that ignored `SIGTERM` ran on until they chose
  to stop. The round's own stop of the reviewer is a group signal and a grace
  too, and a CLI that ignores the first signal runs on against the model API
  with no episode left to record it. `pi` 0.85.1 exits on `SIGTERM` in the
  middle of a request.
- **Count the 600-second ceiling as the runtime's subagent stall watchdog, not
  the hook's `timeout`.** A hook declaring 900 was killed at 599.9 seconds,
  twice. A subagent that makes no progress for 600 seconds is failed, and a hook
  the runtime is waiting on is cancelled with it. A `SubagentStop` hook that runs
  long is exactly a subagent making no progress, because the subagent cannot
  finish while the hook holds it. With the watchdog moved out of the way the same
  hook ran past 600 seconds and past 900 without being signalled. So a hook that
  held the subagent for a review would bound every review at 600 seconds, and
  that is why the hook returns as soon as it has queued.
- **Expect a subagent cancelled this way to read as work that never happened.**
  The subagent is recorded as failed, and the parent turn is told the subagent
  call was interrupted and that nothing ran.

## Needs your input

Nothing.

## Reference

### What ends a hook at 600 seconds

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
  it is the whole of what decides whether a process deaf to `SIGTERM` survives.
- **macOS only, on one machine, against Claude Code 2.1.270.** On Windows the
  hook is not spawned in a group of its own *(unverified — read out of the
  2.1.270 binary rather than run)*, so none of the group half of this applies
  there.
- **A process that leaves the hook's chain of parents is reached by neither
  signal.** A child a detached grandchild started and left behind is reparented
  away from the hook, outside the descendant walk and outside the hook's group.
  That topology was not measured.
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
  143.
- **Nothing here says what the runtime does to a hook it cancels for a reason
  other than the timeout or the watchdog.** An interrupted session and an
  abandoned turn both end a hook that is still running, and neither was run.
