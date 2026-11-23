---
settles: "§ 8: where the reason lives when the reviewer never got as far as the model"
issue: 103
recorded: 2026-11-23
versions: { pi: 0.85.1, node: 24.15.0 }
recheck-when: pi upgrades, or pi starts writing its startup errors anywhere but stderr
---

# A startup failure never reaches the stream

## Intent

- Whether a reviewer that fails to start says why in the same place as one that
  fails to reach the model.
- Whether stderr can be ignored.

## Decisions

- **Read stderr, and keep the end of it.** A startup failure exits non-zero,
  writes nothing to the report file or stdout, and says why on stderr. A harness
  that ignores stderr reports a typo in a model name as a generic bad round for
  as long as the typo lasts.
- **Drain it as it arrives, never at the end.** A pipe nobody reads fills, and
  the reviewer stops on the write that fills it, which turns a diagnostic into a
  hang. Keeping only the last 2,000 bytes stops a reviewer that complains for a
  whole round from being held in memory.
- **Use it only where the run completed no message.** A run that completed one
  carries its own reason, as the message's `errorMessage` in the report file,
  and stderr would say the same thing a second way.
- **In a pane, read stderr only where the reviewer's command line keeps it in a
  file.** A pane's stderr is the screen, so there is no stream to drain. The
  Copilot adapter's line keeps it in `stderr.txt` in the round's session
  directory, emptied before the reviewer starts, and its last 2,000 bytes are
  read the same way. A `pi` in a pane leaves none (unverified: read from the
  code, not run).
- **Read the exit status with it.** Zero against no message is a reviewer that
  ran and said nothing; non-zero is one that never started. The reason names
  which.

## Needs your input

Nothing.

## Reference

| | Reached the model and failed | Never started |
|---|---|---|
| Exit status | 0 | non-zero |
| The report file | a complete assistant message, `stopReason` of `error` | empty |
| stderr | empty | the whole explanation |
| Where the reason is | `message.errorMessage` | stderr |

An unknown provider, at `pi` 0.85.1, exits 1 with nothing on stdout and this on
stderr:

```
Error: Unknown provider "nosuchprovider". Use --list-models to see available providers/models.
```

A `data` listener on the child's stderr puts the stream in flowing mode from
the moment it is attached. `child.exitCode` and `child.signalCode` are both
`null` until the process is gone, and the `close` event is what says its
output has ended too. Reading either before that reads nothing.

## Limits

- **One startup failure, of one kind.** An unknown provider was measured. A
  missing credential, an unreadable configuration file and an unknown model were
  not, and nothing establishes that all of them take this path (unverified).
- **The 64KB pipe capacity is the usual one, not a measured one.** What was
  measured is that a reviewer writing about 1.2MB to stderr finishes and exits
  where the pipe is drained as it goes.
- **The tail is bytes, not lines.** A complaint longer than the limit is cut
  mid-line at its start.
