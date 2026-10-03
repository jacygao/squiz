---
settles: "§ 4 — what makes a recorded process group the round's own at the reading taken before `SIGKILL`, and which program holds a recorded number"
issue: 242
recorded: 2026-10-03
versions: { macos: 26.6.2, node: 24.15.0, bash: 3.2.57 }
recheck-when: the grace between the two signals grows toward a pid space turnover
---

# A group still holding what the first reading saw never emptied

## Intent

- Which program can hold a recorded number through the round's own `SIGTERM`.
- What makes a recorded group the round's own at the reading taken before
  `SIGKILL`, once the group has been signalled.
- What a test of the escalation has to do so that the escalation is the thing it
  exercises.

## Decisions

- **Accept a group at the second reading where it still holds a process the first
  reading found.** A number cannot be handed out while anything still holds it, so
  such a group never emptied and is the group that was signalled. Nothing in that
  turns on a signal arriving after a handler.

- **Hold the number with an ordinary `sleep`, and let it answer the round's
  `SIGTERM`.** The holder has only to be there when the round first reads the
  group. One process rather than two: `exec -a <name> sleep <seconds>` is the
  whole of it, and `argv[0]` carries the round's name.

- **Do not hold the number with a process that ignores `SIGTERM`.** `trap "" TERM`
  leaves a window between the `exec` and the trap taking effect, and the round's
  own signal can arrive inside it. The holder then dies with the default
  disposition, the second reading finds none, and the round refuses the group it
  had just signalled — leaving running the one tool the escalation exists for.

- **Have a test wait for its tool to say the handler is installed.** The same
  window is in the tool, and a tool that died on `SIGTERM` leaves a test passing
  having exercised none of the escalation.

## Needs your input

- Nothing.

## Reference

`exec -a <name> <program>` sets `argv[0]`, and `ps -o command=` prints it. The
round's holder and what the reading sees:

```
$ ps -o pid=,pgid=,etime=,command= -g 15531
15532 15531 00:00 squiz-7f3a9c21 900
```

So `argv[0]` is the first field of the command, and the reading takes the pid, the
group and the elapsed time off the row and the rest of it as the command.

The second reading refuses a group whose every process began after the signal. A
tool that answers `SIGTERM` by leaving a fresh process behind and exiting produces
one, and is not escalated to:

```
before the signal:  15532 15531 /bin/bash .../forks-on-term
                    15533 15531 sleep 30
after the signal:   15546 15531 sleep 30
```

The race in a holder that ignores the signal showed as a test that passed alone
and failed inside its file. Two `ps` calls' worth of delay before the signal,
about 20 ms, made it pass again.

## Limits

- **Pid reuse inside the grace was not provoked.** That a group holding one
  process the first reading saw is the same group rests on a number being
  reserved while its group has members, and on a pid not coming round inside two
  seconds. The space was measured elsewhere at about 13 seconds under load on this
  machine.

- **macOS only.** Both readings use `ps -g`, which selects a process group there
  and a session on Linux.

- **The window in the trap was not measured.** It was reached by running a file of
  tests, and closed by removing the trap rather than by timing it.
