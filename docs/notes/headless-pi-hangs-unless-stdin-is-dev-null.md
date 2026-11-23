---
settles: "§ 5: why a `pi` reviewer with no terminal is given `/dev/null` on stdin"
issue: [11, 165]
recorded: 2026-09-25
versions: { pi: 0.84.2, model: deepseek-v4-pro, node: 24.15.0 }
recheck-when: pi upgrades, or pi's print mode stops reading stdin
---

# Headless `pi` hangs unless stdin is `/dev/null`

## Intent

- What `pi --print` needs on stdin to run and exit.

## Decisions

- **Give a `pi` with no terminal `/dev/null` on stdin, whatever it is
  granted.** With an open pipe on stdin, `pi --print` emitted nothing and never
  exited, with one tool granted and with none, until it was killed at 25
  seconds. With `< /dev/null` it returned in about a second.
- **Keep the round's time bound on every run as well.** A hang and a refusal
  look alike from outside: no output, no error, no exit.

## Needs your input

Nothing.

## Limits

- **Measured at `pi` 0.84.2** and not run again since.
- **Print mode only.** In a pane `pi` runs interactively, with the pane as its
  terminal, and was not measured here.
