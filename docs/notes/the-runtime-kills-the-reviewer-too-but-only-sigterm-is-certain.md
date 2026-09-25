---
settles: "§ 7 — what becomes of a detached reviewer when the runtime kills the hook, and whether anything is left to stop it"
issue: 142
recorded: 2026-09-25
versions: { claude-code: 2.1.270, node: 24.15.0, pi: 0.85.1 }
recheck-when: Claude Code changes how it kills a hook that reaches its timeout
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

## Decisions

- **Nothing has to be built to stop an orphaned reviewer, because the runtime
  reaches it.** At the ceiling the runtime sends `SIGTERM` to the hook's process
  group and, separately, to every descendant of the hook by process id. The
  reviewer is signalled in its own right, and so is each tool it started.
  `detached: true` is safe to keep: it takes the reviewer out of the hook's group
  and does not take it out of the runtime's reach.
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
- **§ 7's failure row for the hook timeout holds as written, and its account of
  the ceiling does not.** The runtime does kill the hook and the turn does end
  with nothing posted. But "The review budget" calls the 600-second ceiling a
  deadline the harness does not own, and the hook's own registration sets it: a
  `timeout` of 5 declared in `hooks/hooks.json` was honoured to the millisecond.
  600 seconds is the default the runtime uses when a hook declares nothing.
  Recorded rather than reconciled; the reconciliation is the owner's.

## Needs your input

- **Whether § 7 should go on calling the hook's ceiling a deadline the harness
  does not own.** It is a number the plugin's own hook registration declares.
  Recommendation: correct the wording and change nothing else. Lowering the
  ceiling would only narrow the margin the round already has, and whether a
  value above 600 is honoured was not tested.
- **Whether the adapter contract in § 4 should require a reviewer that exits on
  `SIGTERM`.** Recommendation: yes. It is the only bound on a reviewer once the
  runtime has killed the hook, and an adapter for a reviewer that ignores the
  signal cannot be made safe from inside this harness.

## Reference

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

### The ceiling, and how to set it

`timeout`, in seconds, on the hook's entry in `hooks/hooks.json`. Absent, the
runtime uses 600 seconds. A declared 5 was honoured: `SIGTERM` arrived between
4.92 and 4.98 seconds every time. The default was honoured too, at 599.8
seconds.

### What the runtime reports about a hook it killed

A `hook_response` event carries `"outcome": "cancelled"`, and `exit_code` 143
where the hook exited on the `SIGTERM` or 1 where it ignored the signal and was
killed outright. `stdout` was empty in both cases.

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
- **A process that has left both the hook's group and its chain of parents is
  reached by neither signal.** No such process was measured. It cannot arise from
  the reviewer as the harness starts it, because the reviewer leads the group its
  tools inherit.
- **Whether a `timeout` above 600 is honoured.** Only lowering it was tested.
- **`pi`'s answer to `SIGTERM` is one observation.** One prompt, the `read`
  grant, killed 0.9 seconds into the request: gone within 51 milliseconds, status
  143. Whether a `bash` tool subprocess in flight changes it was not measured.
- **Nothing here says what the runtime does to a hook it cancels for a reason
  other than the timeout.** An interrupted session and an abandoned turn both end
  a hook that is still running, and neither was run.
