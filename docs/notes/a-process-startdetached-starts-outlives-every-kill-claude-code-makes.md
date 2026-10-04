---
settles: "§ 3 — that `squiz host` can be started with `startDetached` and outlive the call that started it; § 8 — the prerequisite on a double-forked process outliving that call, for Node's `spawn` with `detached` rather than Python's `os.setsid()`"
issue: 368
recorded: 2026-10-05
versions: { claude-code: 2.1.289, node: 24.15.0, macos: 26.6.2 }
recheck-when: Claude Code changes how it stops a shell command, a background task or a subagent; Node changes what `spawn` does with `detached: true`; `startDetached` changes how it starts the target
---

# A process `startDetached` starts outlives every kill Claude Code makes

A heartbeat started through `startDetached` from `src/sessions/detach.ts` ran
its full 120 seconds after Claude Code killed the command that started it. It
did so in all six runs: two each for a turn ending on a background command, a
command moved to the background by the timeout, and an interrupt. Each time the
command itself got `SIGTERM` and died, and the heartbeat was already reparented
to pid 1 and leading a process group of its own.

## Intent

- Whether a process `startDetached` starts outlives each of the three kills: the
  turn ending, the timeout moving the command to the background, and an
  interrupt.
- What parent and process group it has once the command is gone.

## Decisions

- **Start the round host with `startDetached`. No Python and no `setsid` binary
  is needed.** The second Node process and `detached: true` escape the kill as
  Python's double fork with `os.setsid()` did. The heartbeat finished all 120
  beats in six runs out of six, after the stand-in that started it got
  `SIGTERM` and was gone.

- **Expect the host to be reparented to pid 1 and to lead its own group before
  `startDetached` returns.** Its parent was pid 1 from its first log line, and its
  group id was its own pid. Its parent never changed after the kill. Nothing of
  the trigger's group or tree holds it, so a signal to the host's group reaches
  the host and nothing else the trigger started.

## Needs your input

- **Whether Linux has to be measured before #326 relies on this.** The
  measurement ran on macOS only. The mechanism, leaving both the command's
  group and its process tree, is the same on Linux, and `startDetached`'s own
  tests, which kill the caller's group, run there in CI. Recommendation: do not block #326 on it. Record Linux as not
  measured in § 8, and run the same stand-in on Linux the first time a Linux
  machine with Claude Code is to hand.

## Reference

### Per run

The stand-in's `SIGTERM` is the kill. "After the kill" is `ps` on the heartbeat
3 seconds after the nested `claude` exited.

| Run | Stand-in killed | Heartbeat after the kill: parent, group | Last beat |
|---|---|---|---|
| end 1 | 21:15:58 | 1, its own (71482) | 120 at 21:17:55 |
| end 2 | 21:16:30 | 1, its own (31969) | 120 at 21:18:28 |
| timeout 1 | 21:16:44 | 1, its own (29849) | 120 at 21:18:28 |
| timeout 2 | 21:16:43 | 1, its own (26636) | 120 at 21:18:27 |
| interrupt 1 | 21:16:34 | 1, its own (33031) | 120 at 21:18:29 |
| interrupt 2 | 21:16:33 | 1, its own (32046) | 120 at 21:18:29 |

The transcripts confirm each kill. In the end runs, the subagent's Bash call
answered `running in background with ID` and the subagent ended its turn. In
the timeout runs, the call answered
`moved to the background (ID: …)` 15 seconds in. In the interrupt runs, the
session logged `[Request interrupted by user for tool use]` and ended with
`error_during_execution`. In five runs of six the stand-in logged `SIGTERM`
twice in the same second.

### Re-running it

Three files in a scratch directory outside the repository:

- `heartbeat.mjs <file> <seconds>` appends a line every second with its parent
  pid, logs its pid, group and session at start, and logs any `SIGTERM`, `SIGHUP`
  or `SIGINT`.
- `standin.mjs <rundir>` imports `startDetached` by absolute path from the
  worktree's `src/sessions/detach.ts`. It starts the heartbeat with
  `command: process.execPath`, writes its pid, and then checks it with
  `kill -0` every second, logging each check and any signal it gets.
- `driver.mjs <mode> <run>` runs one nested session, bounded at 300 seconds,
  from the scratch directory:

```
claude -p --permission-mode auto --model sonnet \
  --input-format stream-json --output-format stream-json --verbose
```

The prompt tells the session to dispatch one foreground `general-purpose`
subagent, which runs `node standin.mjs <rundir>`:

- **end:** with `run_in_background`, then ends its turn at once.
- **timeout:** in the foreground with no timeout, under
  `BASH_DEFAULT_TIMEOUT_MS=15000`, and ends its turn once the call moves to the
  background.
- **interrupt:** in the foreground with a timeout of 600000. Once the stand-in
  has logged five checks, the driver writes
  `{"type":"control_request","request_id":"int1","request":{"subtype":"interrupt"}}`
  to the session's stdin.

The driver then reads the heartbeat with `ps -o pid=,ppid=,pgid=,stat=` and
waits for its last beat.

## Limits

- **macOS only.** Linux was not run.
- **Two runs per kill.** All six ran concurrently, each in its own session and
  directory.
- **Print sessions only.** An interactive session's exit, a closed terminal and
  a `Stop` or `SubagentStop` hook's process being killed were not tried.
- **A Node stand-in, not `squiz host`.** The heartbeat holds no stream of the
  caller's: its stdin is `/dev/null` and its output is a log, as
  `startDetached` always sets them. A target that reopened the terminal was not
  tried.
- **Why the stand-in got `SIGTERM` twice was not found.** A signal to the group
  and one to each descendant would explain it *(unverified)*. Whether `SIGKILL`
  followed was not observed, because the stand-in exited on the first `SIGTERM`.
