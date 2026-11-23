---
settles: "§ 3: how a trigger starts the round host so that it outlives the trigger's shell call or hook"
issue: 368
recorded: 2026-10-05
versions: { claude-code: 2.1.289, node: 24.15.0, macos: 26.6.2 }
recheck-when: Claude Code changes how it stops a shell command, a background task or a subagent; Node changes what `spawn` does with `detached: true`; `startDetached` changes how it starts the target
---

# A process `startDetached` starts outlives every kill Claude Code makes

## Intent

- Whether a process `startDetached` starts outlives each of three kills: the
  turn ending on a background command, the timeout moving a command to the
  background, and an interrupt.
- What parent and process group it has once the command that started it is
  gone.

## Decisions

- **Start the round host with `startDetached` from `src/sessions/detach.ts`. No
  Python and no `setsid` binary is needed.** A second Node process spawning the
  target with `detached: true` escapes the kill as a double fork with
  `os.setsid()` does. The target ran to its end in six runs of six, two for each
  kill, after the command that started it got `SIGTERM` and died.
- **Expect the host to be reparented to pid 1 and to lead its own group before
  `startDetached` returns.** Nothing of the trigger's group or tree holds it,
  so a signal to the host's group reaches the host and nothing else the trigger
  started.

## Needs your input

Nothing.

## Limits

- **macOS only.** Linux was not run, though `startDetached`'s own tests, which
  kill the caller's group, run there in CI.
- **Print sessions, under a foreground subagent, only.** An interactive
  session's exit, a closed terminal, and a `Stop` or `SubagentStop` hook's
  process being killed were not tried.
- **A Node stand-in, not `squiz host`.** Its stdin was `/dev/null` and its output
  a log, as `startDetached` always sets them. A target that reopens the terminal
  was not tried.
- **The killed command got `SIGTERM` twice in the same second** in five runs of
  six, and why was not found. Whether `SIGKILL` followed was not observed.
