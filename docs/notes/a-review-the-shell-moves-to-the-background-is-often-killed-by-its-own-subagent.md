---
settles: "§ 7 — the deadline `squiz review` waits within; § 2 — the Bash timeout and the stall watchdog; § 3 — what starts a round; § 8 — five of the settled prerequisites"
issue: 278
recorded: 2026-10-03
versions: { claude-code: 2.1.288, coding-agent: claude-opus-5-5 }
recheck-when: Claude Code changes the Bash tool's timeout or background move, the subagent stall watchdog, the hand-back, or how plugin skills reach a subagent
---

# A review the shell moves to the background is often killed by its own subagent

## Intent

- Whether the stall watchdog fails a subagent that is waiting on a long shell
  command.
- Whether an agent passes the longest timeout when told to, and what it does
  when the command is moved to the background anyway.
- What signal reaches a command stopped from outside, and whether a child it
  started outlives it.
- Whether a subagent given only the § 9 text loops on exit 2 and stops on 0, 1
  and 3.
- Whether a subagent loads a plugin's skill when it opens a pull request.

## Decisions

- **Size the window against the shell's timeout, not against the stall
  watchdog.** A subagent waiting on a shell command is making progress. With the
  threshold lowered to 60 seconds, a 90-second command finished under every
  subagent: foreground and background, in `auto` and in `acceptEdits`. A
  `SubagentStop` hook that held a subagent for the same 90 seconds had it failed
  at 60, so the threshold was in force.

- **End the round before the shell's timeout, with a margin, rather than at
  it.** Every agent told to pass a `timeout` of 600000 passed it, 28 calls out
  of 28. But a review that outruns the timeout is lost more often than not when
  a foreground subagent ran it. The runtime moves the command to the background
  and tells the subagent not to end its turn. Three of five foreground subagents
  ended their run anyway, and the runtime sent the review `SIGTERM` within a
  second. This contradicts § 7, which makes the window 600 seconds, the same as
  the longest timeout, and relies on the § 9 instruction to wait when the review
  outlasts it. The instruction does not hold. Background subagents did wait,
  two of two, because the finished command started them again.

  2026-10-05: M7 moved the round out of the shell call into the round host
  (§ 3). The shell call is now `squiz review` waiting within its 540-second
  deadline (§ 7), and a stopped call ends only the wait.

- **Expect no cleanup from a round stopped from outside, and expect no reviewer
  left behind.** The runtime sends `SIGTERM` to the command and to every process
  under it at the same instant, including a child started in a session of its
  own. It sends `SIGKILL` one to two seconds later to whatever ignored the first
  signal. That held for all four ways a command was stopped: the end of a
  foreground subagent's run, an interrupt of the session, an interrupt while a
  subagent waited, and `SIGINT` to `claude`. Moving a command to the background
  sends nothing.

- **Ship the § 9 text as written for the loop.** Seven subagents given only that
  text did what it says. On exit 2 each fixed the file, committed, pushed,
  replied with `squiz reply`, and ran `squiz review` again. Each stopped after 0,
  1 or 3, reported what the text asks for, and never ran it again.

- **Make the plugin's skill the Claude Code route, and keep `AGENTS.md` for other
  agents.** Four subagents out of four, briefed only to fix a file, push it and
  run `gh pr create`, loaded the skill straight after the pull request opened.
  Each then ran `squiz review 7` with a `timeout` of 600000, before reporting.
  This held in `auto` and in `acceptEdits`, and in the foreground and the
  background.

## Needs your input

- **How far below 600 seconds the window goes.** The round must be over, its
  stopping overrun and the process's own start included, before the shell's
  timeout moves it. Recommendation: a window of 540 seconds, which leaves a
  minute for both.

  2026-10-05: settled. 540 seconds is now the deadline `squiz review` waits
  within (§ 7), and no round runs inside a shell call.
- **Whether § 9 says more about waiting.** The runtime's own message already says
  "do not end your turn to wait for it", and three subagents ended it anyway, so
  a sentence in the skill may not help. Recommendation: rely on the margin, and
  measure any added sentence against a moved command before shipping it.

## Reference

### What a subagent is told when its command is moved

```
Command did not complete within its 30s timeout and was moved to the background (ID: bft38kofb). Output is being written to: <file>. If it exits while you are still working you will be notified, but it is terminated when you give your final response and no notification can follow that — so do not end your turn to wait for it; if you need its result, wait for it before giving your final response.
```

Every subagent that got this then loaded `Monitor` and started a watch on the
output file. What came next decided the review:

| Dispatch | Mode | What the subagent did | The review |
|---|---|---|---|
| Foreground | `auto` | Waited in a blocking `until grep` loop, read the output | Finished |
| Foreground | `auto` | Waited in a blocking loop, read the output | Finished |
| Foreground | `auto` | Wrote "The review is still running. I'll wait for the monitor to tell me it has finished." and ended its turn | Killed |
| Foreground | `acceptEdits` | Wrote "I'm waiting for the review to finish." and ended its turn | Killed |
| Foreground | `acceptEdits` | Wrote "Waiting for the review to finish." and ended its turn | Killed |
| Background | `auto` | Ended its turn, was started again when the command finished, read the output | Finished |
| Background | `acceptEdits` | The same | Finished |

In `auto`, a subagent that ends its turn without handing back is told:

```
[handback-send-enforce] Your report has not been delivered. Call SubagentHandback({message: <your full report>}) now; the call ends your run.
```

It then hands back with the review unfinished. In `acceptEdits` the turn's end
is the run's end. A background subagent's dispatcher receives a completion
notification at the first turn's end, carrying "Waiting for the review to
finish.", and a second one with the result.

An Agent call that omits `run_in_background` was run in the background, two
calls out of two. Only `run_in_background: false` gave a foreground subagent.

### The stall threshold

`CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS=60000`. A subagent held by its stop hook
was failed with:

```
Agent stalled: no progress for 60s (stream watchdog did not recover)
```

The foreground dispatcher's Agent call returned
`[Request interrupted by user for tool use]`. The hook got `SIGTERM`.

### The signals

The stand-in ran a child for 120 seconds, and logged every signal either
received.

- **Both got `SIGTERM`** in the same second as the stop, the child directly
  rather than from its parent. A child started with `start_new_session` got it
  too.
- **Both stopped within two seconds** where they ignored `SIGTERM`.
- **A background subagent's background command outlived its hand-back.** It ran
  until the session ended, 13 seconds later, and got `SIGTERM` then.

### The skill

Loaded as `squizprobe:squiz-review`, through the Skill tool. The skill's
description was the one § 9 gives, word for word.

## Limits

- **The full 600 seconds was never run.** The stall threshold was lowered to 60
  seconds against a 90-second command. The shell's timeout was lowered to 30
  seconds against a 75-second one, through `BASH_DEFAULT_TIMEOUT_MS` and
  `BASH_MAX_TIMEOUT_MS`, each set to 30000. That a 600000 timeout is accepted
  unclamped at the defaults is inferred from 90-second commands finishing under
  it, not measured.
- **The stand-in was a Python script, not squiz or `pi`.** A real reviewer may
  be slower to stop, or start processes outside the command's tree. Neither was
  tried.
- **One to five runs per case.** Three of five is not a rate.
- **Only `general-purpose` subagents, in `-p` sessions, on Opus 5.5.** No
  interactive session, and no other model.
- **The plugin was loaded with `--plugin-dir`**, not installed from a
  marketplace. The fake `gh` answered `pr create` with a fixed URL, and no
  subagent was offered any other skill that matched as closely.
- **Subagents wrapped the command as `squiz review 7; echo "EXIT=$?"`**, so the
  Bash call itself always exited 0. They read the status from the output.
