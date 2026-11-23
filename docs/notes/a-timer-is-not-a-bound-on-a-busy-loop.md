---
settles: "§ 8 The review budget: what bounds a review's time, and how the reviewer is stopped at the bound"
issue: 103
recorded: 2026-11-23
versions: { node: 24.15.0 }
recheck-when: Node's major version changes, or the reviewer's reports stop arriving through a file read at intervals
---

# A timer is not a bound on a busy loop

## Intent

- What can bound a review's time, and whether a Node timer fires under the load
  a round puts on the process.
- What a bound should do once it fires, so that a stopped reviewer spends
  nothing more and cannot hold the round open past its bound.
- How to tell that nothing the reviewer started is still running.

## Decisions

- **Decide the bound by reading the clock, and use a timer only as a prompt to
  look.** A wait is capped at 250 ms and the moment is compared against
  `Date.now()` at every look, so a wait that ran long, a clock that jumped, or a
  timer that fired early costs one more look rather than the round.
- **Read the clock in the path of any work that never yields to I/O.** A timer
  does not fire while the loop yields only to microtasks. The report file is
  followed by a read every 50 ms, so the loop reaches the timer phase between
  reads, and the timer is enough there (unverified: the follow was not
  measured under load).
- **Signal the reviewer's process group, not the reviewer.** A stopped reviewer
  otherwise leaves its tools running, such as the `git` a history tool started.
  The reviewer is started as its own group leader so that its pid names the
  group.
- **Do not end the cleanup at the reviewer's own exit.** A tool in the
  reviewer's group can outlive it, because the reviewer finished first or
  because the tool did not take the signal. Both finishing and escalating are
  decided by whether anything of the group is left.
- **`SIGTERM`, then `SIGKILL` after a grace of 2 seconds, and wait for neither
  longer than the grace.** A round that reaches its bound returns within twice
  the grace of reaching it, which is what the margin left for posting has to
  cover.
- **Ask the group whether it has members only once the reviewer has been
  reaped.** The system keeps a group's id reserved while the group has members,
  so an empty group answers no rather than answering for whoever holds the id
  next. Before it is reaped the reviewer is itself a member, and the answer is
  always yes.
- **Treat a signal the system refuses as a process that cannot be stopped from
  here.** `child.kill` and `process.kill` throw for some errors, and a throw
  there would turn a round that ran into a round the harness could not run.

## Needs your input

Nothing.

## Reference

A Node timer runs on the event loop's timer phase:

| The loop yields by | A 150 ms timer fires |
|---|---|
| `await Promise.resolve()` | never, over 800 ms of it |
| `await new Promise(setImmediate)` | at 149 ms |
| nothing at all, for 500 ms | as soon as the loop is free |

- **`stdio: ["ignore", "pipe", "pipe"]`** gives the child `/dev/null` on stdin,
  which is required unconditionally.
- **`detached: true`** makes the child a process group leader whose group id is
  its own pid. `process.kill(-pid, signal)` sends to the group, and
  `child.kill(signal)` only to the child.
- **`process.kill(-pid, 0)`** asks whether the group could be signalled and
  sends nothing. It throws `ESRCH` for a group with no members left and `EPERM`
  for one that is there and not ours, so only `ESRCH` means gone. No event says
  the last member left, so the question is asked at intervals.
- **A reviewer is reaped by the time `exitCode` or `signalCode` is set.** Both
  are `null` while it runs, so asking the group after either is set asks about
  everything except the reviewer.
- **A process that never started emits no `exit`.** `close` and `error` are the
  other two ways the same fact arrives, so a wait on `exit` alone waits out its
  whole length on a reviewer that is not installed.

## Limits

- **One machine, one Node version.** The phase ordering is Node's own, but the
  figures above were taken here.
- **A group is not a fence.** A tool that makes a process group of its own is
  not signalled with the reviewer's. `pi`'s shell tool does that, and no
  reviewer is granted it. The granted tools do not: `grep` and `find` start
  ripgrep inside the reviewer's own group, and the history tools start `git`
  there. A harness killed outright signals nothing at all.
- **`SIGKILL` was exercised only against a process built to ignore `SIGTERM`.**
  Nothing establishes that a real reviewer ever needs it.
- **Nothing here was measured against `pi` itself.** The reviewers in the tests
  are scripts that flood, go quiet, or answer.
