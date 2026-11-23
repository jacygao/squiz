---
settles: "§ 8 The review budget: whether squiz review's 540-second wait fits Copilot's shell"
issue: 787
recorded: 2026-11-05
versions: { copilot: 1.0.105, model: gpt-6-astra, node: 24.15.0, macos: 26.6.2 }
recheck-when: Copilot CLI upgrades past 1.0.105, or changes its shell tool's timeouts
---

# Copilot's shell lets `squiz review` wait its full 540 seconds

## Intent

- How long Copilot's shell lets one foreground command run before it stops it.

## Decisions

- **Keep `squiz review`'s 540-second deadline under Copilot.** Copilot's shell
  stopped no foreground command. One ran 7 minutes in one call. Another ran about
  10 awake minutes before Copilot handed the turn back with the command still
  running, and the agent then waited on it with `Read shell output` calls of up
  to 120 seconds each until it ended.

## Needs your input

Nothing.

## Reference

- **Under `-p`, a script outside the working directory is refused.** With
  `--allow-tool 'shell(sh)'` and no `--allow-all-paths`, `sh /abs/path/wait.sh`
  was denied with `Permission denied because no interactive user response was
  available`, and the same script inside the repository ran. `squiz` on `PATH`
  is a command name rather than a path argument (unverified under `-p`).

## Limits

- **The machine slept for most of the long run.** The command ran 73 minutes of
  wall time and about 17 awake, and Copilot handed the turn back after about 10
  awake minutes. That shows the command was not stopped across the sleep. It
  does not show what Copilot does with a command that runs longer than about 10
  awake minutes in one call.
- **The model followed an instruction to wait in the foreground.** What a model
  does that backgrounds the command or ends its turn was not seen here.
