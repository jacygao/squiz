---
settles: "§ 7 — what can bound a round's time, given that `sleep` cannot and `timeout` is not installed"
issue: 103
recorded: 2026-09-24
versions: { node: 24.15.0 }
recheck-when: Node's major version changes, or the reviewer's output stops arriving through a pipe
---

# A timer is not a bound on a busy loop

## Intent

- **Nothing said what could bound a round's time here.** A watchdog of
  `sleep 480` sent no signal after 2,269 seconds and `timeout` is not installed,
  so the remaining candidate was a Node timer, and nothing said whether it fires
  under the load a round puts on the process.
- **Nothing said what a bound should do once it fires.** A killed reviewer that
  goes on running spends API budget the episode is no longer watching, and one
  that ignores the signal would hold the round open past the hook's ceiling.

## Decisions

- **Bound the round with two readings of the clock, not one.** A timer catches a
  reviewer that has gone quiet, and a read of the clock as each chunk of output
  arrives catches one that floods. Either alone leaves a way for a round to run
  past its bound.
- **Read the clock rather than trust the timer that woke you.** A wait is capped
  well below the bound and the moment is compared against `Date.now()` at every
  look, so a wait that ran long, a clock that jumped, or a timer that fired early
  costs one more look rather than the round.
- **Signal the reviewer's process group, not the reviewer.** A reviewer that is
  stopped leaves its tools running otherwise, and a tool still running can write
  to the tree the coding agent is about to commit. The reviewer is started as
  its own group leader so that its identifier names the group.
- **`SIGTERM`, then `SIGKILL` after a grace, and wait for neither longer than the
  grace.** A round that reaches its bound returns within twice the grace of
  reaching it, which is what the margin left for posting has to cover.
- **Send both while the reviewer is still alive.** A group is named by its
  leader's process identifier, and naming it after the leader is gone can name a
  group the system has since given to somebody else.
- **Treat a signal the system refuses as a process that cannot be stopped from
  here.** `child.kill` throws for some errors, and a throw there would turn a
  round that ran into a round the harness could not run.

## Needs your input

Nothing.

## Reference

### The load a timer does not survive

A Node timer runs on the event loop's timer phase. A loop that yields only to
microtasks never reaches it, and the timer does not fire late — it does not fire.

| The loop yields by | A 150 ms timer fires |
|---|---|
| `await Promise.resolve()` | never, over 800 ms of it |
| `await new Promise(setImmediate)` | at 149 ms |
| nothing at all, for 500 ms | as soon as the loop is free |

So a bound resting on a timer alone holds for a reviewer whose output arrives
through a pipe, because each chunk is I/O and the loop reaches the timer phase
between them. It does not hold for work that stays inside the microtask queue,
and the clock read in that work's own path is what bounds it.

### Stopping the process

`stdio` of `["ignore", "pipe", "pipe"]` is what gives the child `/dev/null` on
stdin, which is required unconditionally.

`detached: true` makes the child a process group leader, and the group's
identifier is then the child's own. `process.kill(-pid, signal)` sends to the
group; `child.kill(signal)` sends only to the child. Both throw rather than
emitting an error event when the system refuses them.

`child.exitCode` and `child.signalCode` are both `null` while the process is
alive, and one of them is set once it is gone. They are what tells a signal that
is still needed from one that would be sent to a process already stopped.

A process that never started emits no `exit`, so a wait that listens only for
that one waits out its whole length on a reviewer that is not installed. `close`
and `error` are the other two ways the same fact arrives.

## Limits

- **One machine, one Node version.** The phase ordering is Node's own and not
  this machine's, but the figures above were taken here.
- **A group is not a fence.** A process that leaves the group by making one of
  its own is not signalled with it, and a harness killed outright by the runtime
  signals nothing at all.
- **`SIGKILL` was exercised only against a process built to ignore `SIGTERM`.**
  Nothing establishes that a real reviewer ever needs it.
- **Nothing here was measured against `pi` itself.** The reviewers in the tests
  are scripts that flood, go quiet, or answer, chosen to be the shapes a real one
  fails in.
