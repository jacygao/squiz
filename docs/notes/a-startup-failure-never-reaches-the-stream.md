---
settles: "§ 7 — where the reason lives when the reviewer never got as far as the model"
issue: 103
recorded: 2026-09-24
versions: { pi: 0.85.1, node: 24.15.0 }
recheck-when: pi upgrades, or pi starts writing its startup errors to stdout
---

# A startup failure never reaches the stream

## Intent

- **A reviewer that fails to start and one that fails to reach the model were
  treated as the same case.** They are not, and the second is the only one that
  was ever measured. An adapter built for the measured one throws the other's
  only explanation away.
- **Nothing said whether stderr could be ignored.** `pi` writes nothing there on
  the path that was measured, which reads as licence to ignore it on every path.

## Decisions

- **Read stderr, and keep the end of it.** A startup failure exits non-zero with
  an empty stdout and says why on stderr, so a harness that ignores stderr
  reports a typo in a model name as a generic bad round for as long as the typo
  lasts.
- **Drain it as it arrives, never at the end.** A pipe nobody reads fills at
  about 64KB, and the reviewer stops on the write that fills it, which turns a
  diagnostic into a hang. Keeping only the last 2,000 bytes is what stops a
  reviewer that complains for a whole round being held in memory.
- **Use it only where the stream explained nothing.** A run that completed an
  assistant message carries its own reason, and stderr would say the same thing
  a second way. A run that completed none is the case with nothing else to
  report.
- **Read the exit status with it.** Zero against no message is a reviewer that
  ran and said nothing; non-zero is one that never started. The reason names
  which.

## Needs your input

Nothing.

## Reference

### The two paths a failure takes

| | Reached the model and failed | Never started |
|---|---|---|
| Exit status | 0 | non-zero |
| stdout | a complete assistant message, `stopReason` of `error` | empty |
| stderr | empty | the whole explanation |
| Where the reason is | `message.errorMessage` | stderr |

An unknown provider is the second path, measured at `pi` 0.85.1:

```
$ pi --print --mode json --no-session --provider nosuchprovider \
     --model whatever --tools read "hi" < /dev/null
exit=1
stdout bytes: 0
stderr bytes: 95
Error: Unknown provider "nosuchprovider". Use --list-models to see available providers/models.
```

### Reading it without stopping the process

A child's stderr is drained by attaching a `data` listener, which puts the
stream in flowing mode from the moment it is attached. Keeping a tail means
holding the last N bytes of what has arrived rather than the whole of it.

`child.exitCode` and `child.signalCode` are both `null` until the process is
gone, and the `close` event is what says its output has ended as well. Reading
either before that reads nothing.

## Limits

- **One startup failure, of one kind.** An unknown provider was measured. A
  missing credential, an unreadable configuration file and an unknown model were
  not, and nothing establishes that all of them take this path *(unverified)*.
- **The 64KB pipe capacity is the usual one, not a measured one.** What was
  measured is that a reviewer writing about 1.2MB to stderr finishes and exits
  where the pipe is drained as it goes.
- **The tail is bytes, not lines.** A complaint longer than the limit is cut
  mid-line at its start.
