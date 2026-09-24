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
- **`SIGTERM`, then `SIGKILL` after a grace, and wait for neither longer than the
  grace.** A round that reaches its bound returns within twice the grace of
  reaching it, which is what the margin left for posting has to cover.
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

`stdio` of `["ignore", "pipe", "ignore"]` is what gives the child `/dev/null` on
stdin, which is required unconditionally. stderr goes nowhere for the same
reason a pipe would be wrong: nobody drains it, and a full pipe stops the
process it was meant to be reading.

`child.exitCode` and `child.signalCode` are both `null` while the process is
alive, and one of them is set once it is gone. They are what tells a signal that
is still needed from one that would be sent to a process already stopped.

## Limits

- **One machine, one Node version.** The phase ordering is Node's own and not
  this machine's, but the figures above were taken here.
- **`SIGKILL` was never needed.** Every process measured stopped on `SIGTERM`,
  so the escalation is built and unexercised against a reviewer that ignores one.
- **Nothing here was measured against `pi` itself.** The reviewers in the tests
  are scripts that flood, go quiet, or answer, chosen to be the shapes a real one
  fails in.
