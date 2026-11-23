---
settles: "§ 2: what the runtime sends the processes under a hook it kills, and what fails a subagent at 600 seconds; § 3: why a hook only queues and the round runs outside it; § 5: that a reviewer CLI must exit on SIGTERM"
issue: 142
recorded: 2026-09-25
versions: { claude-code: 2.1.270, node: 24.15.0, pi: 0.85.1 }
recheck-when: Claude Code changes how it kills a hook that reaches its timeout, or changes the subagent stall watchdog
---

# The runtime signals a hook's whole tree, but only its `SIGTERM` is certain

## Intent

- Whether the runtime signals a hook alone, its process group, or every process
  under it, including one that leads a group of its own.
- Whether a process under the hook is still running once the hook is killed, and
  what would stop it.
- Whether 600 seconds is the hook's timeout or something else.

## Decisions

- **Run nothing that must survive under a hook or a shell call.** At the ceiling
  the runtime sends `SIGTERM` to the hook's process group and, separately, to
  every descendant of the hook by process id, whatever group each is in. A
  process started with `detached: true` under the hook is still signalled. Only
  a process that has left the hook's chain of parents escapes, which is how the
  round host is started.
- **Require a reviewer CLI, and every process it starts, to exit on `SIGTERM`.**
  The runtime escalates to `SIGKILL` about 1.5 seconds later only if the runtime
  is itself still running then. Where the session ended inside that grace,
  processes that ignored `SIGTERM` ran on until they chose to stop. The round's
  own stop of the reviewer is a group signal and a grace too. `pi` 0.85.1 exits
  on `SIGTERM` in the middle of a request.
- **Have the hook queue and return, because a `SubagentStop` hook that holds the
  subagent is cut off at 600 seconds.** The ceiling is the runtime's subagent
  stall watchdog, not the hook's `timeout`: a hook declaring 900 was killed at
  599.9 seconds, twice. The subagent cannot finish while its hook runs, so a
  long hook is a subagent making no progress.
- **Expect a subagent cancelled this way to read as work that never happened.**
  The subagent is recorded as failed, and the parent turn is told the subagent
  call was interrupted and that nothing ran.

## Needs your input

Nothing.

## Reference

### The watchdog

- Its threshold is 600 seconds, read from `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS`
  in milliseconds where that is set. Setting it to 1800000 moved the ceiling to
  1800 seconds.
- When it fires, `task_updated` carries `"status": "failed"` and
  `Agent stalled: no progress for 600s (stream watchdog did not recover)`,
  `task_notification` repeats that as its `summary`, and the hook's
  `hook_response` says only `"outcome": "cancelled"`. Nothing else announces it.
- It defers while the subagent has a tool call in flight *(unverified: read out
  of the 2.1.270 binary, not run)*.

### The hook's own `timeout`

`timeout`, in seconds, on the hook's entry in `hooks/hooks.json`. Below the
watchdog it is honoured exactly: a declared 5 brought `SIGTERM` between 4.92 and
4.98 seconds, and the subagent then finished normally. Above the watchdog it is
worth nothing. It takes any positive number *(unverified: read out of the
2.1.270 binary)*.

### What the runtime does at the ceiling

1. `SIGTERM` to the hook's process group.
2. In the same instant, `SIGTERM` to every descendant of the hook by process id.
3. About 1.5 seconds later, `SIGKILL` to the group and those descendants, only
   if the runtime process is still alive.

Between them the two signals reached the hook, a child in its group, a process in
its group reparented to init, a detached grandchild leading its own group, and
that grandchild's child.

### Reading a killed hook's `hook_response`

- `exit_code` is 143 where the hook exited on `SIGTERM`, and 1 where it ignored
  the signal and was killed.
- **`outcome` does not tell a killed hook from one that ran to the end.** A hook
  never signalled, which exited 0 on its own, was also `"outcome": "cancelled"`.
  Read `exit_code`.
- Anything the hook wrote to stderr before the kill comes back in `stderr` and
  `output`.

## Limits

- **Print mode only, macOS only, Claude Code 2.1.270.** An interactive session
  does not exit when a turn ends, so the escalation would presumably fire
  *(unverified)*. On Windows the hook is not spawned in a group of its own
  *(unverified: read out of the binary)*.
- **A process that leaves the hook's chain of parents was not measured**, such as
  a child a detached grandchild started and left behind.
- **The default hook timeout was not separated from the watchdog.** A hook with
  no `timeout` was killed at 599.8 seconds.
- **Whether a declared timeout above 600 is ever enforced is open.** With the
  watchdog moved, a declared 900 was not enforced within 1118 seconds, and the
  process's timers were starved enough that the figure is soft.
- **Only `SubagentStop` was measured.** A `Stop` hook has no stalling subagent
  behind it and may reach its own declared timeout instead.
- **`pi`'s answer to `SIGTERM` is one observation**: killed 0.9 seconds into a
  request, gone within 51 ms, status 143.
- **An interrupted session and an abandoned turn were not run.**
