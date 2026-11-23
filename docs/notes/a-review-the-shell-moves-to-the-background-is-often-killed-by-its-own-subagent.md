---
settles: "§ 8: the deadline `squiz review` waits within"
issue: 278
recorded: 2026-10-03
versions: { claude-code: 2.1.288, coding-agent: claude-opus-5-5 }
recheck-when: Claude Code changes the Bash tool's timeout or background move, the subagent stall watchdog, or the hand-back
---

# A review the shell moves to the background is often killed by its own subagent

## Intent

- Whether the subagent stall watchdog fails a subagent that is waiting on a
  long shell command.
- Whether an agent passes the longest timeout when told to, and what it does
  when the command is moved to the background anyway.
- How far below the shell's timeout `squiz review`'s wait must end.

## Decisions

- **Size the wait against the shell's timeout, not against the stall
  watchdog.** A subagent waiting on a shell command is making progress. With the
  watchdog's threshold lowered to 60 seconds, a 90-second command finished under
  every subagent, foreground and background, in `auto` and in `acceptEdits`. A
  `SubagentStop` hook that held a subagent for the same 90 seconds had it failed
  at 60, so the threshold was in force.
- **End `squiz review`'s wait at 540 seconds, with exit 4, a minute below the
  longest shell timeout of 600 seconds.** Every agent told to pass a `timeout`
  of 600000 passed it, 28 calls of 28. A command that outruns it is moved to the
  background, and a foreground subagent then often ends its run anyway: three of
  five did, and the runtime sent the command `SIGTERM` within a second. The
  runtime's own message telling it not to end its turn did not hold. The round
  runs in the round host, so a stopped call ends only the wait, but a wait that
  ends first returns its exit status to the agent. The minute covers the
  process's own start and the stop's overrun.

## Needs your input

Nothing.

## Reference

What a subagent is told when its command is moved:

```
Command did not complete within its 30s timeout and was moved to the background (ID: bft38kofb). Output is being written to: <file>. If it exits while you are still working you will be notified, but it is terminated when you give your final response and no notification can follow that […] do not end your turn to wait for it; if you need its result, wait for it before giving your final response.
```

- **Foreground subagents that waited** did so in a blocking loop and read the
  output. Those that ended their turn said they were waiting, and the command
  was killed at their run's end.
- **Background subagents waited**, two of two: each ended its turn, was started
  again when the command finished, and read the output.
- **An `Agent` call that omits `run_in_background` runs in the background**, two
  calls of two. Only `run_in_background: false` gives a foreground subagent.
- **The stall threshold is `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS`.** A subagent it
  fails ends with
  `Agent stalled: no progress for 60s (stream watchdog did not recover)`.
- **The shell's timeouts are `BASH_DEFAULT_TIMEOUT_MS` and
  `BASH_MAX_TIMEOUT_MS`.**

## Limits

- **The full 600 seconds was never run.** The shell's timeout was lowered to 30
  seconds against a 75-second command. That a 600000 timeout is accepted
  unclamped at the defaults is inferred from 90-second commands finishing under
  it.
- **The stand-in was a Python script, not squiz.**
- **One to five runs per case.** Three of five is not a rate.
- **Only `general-purpose` subagents, in `-p` sessions, on Opus 5.5.** No
  interactive session, and no other model.
