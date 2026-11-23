---
settles: "§ 8 The review budget: what a failed pane start may have spent, under each backend"
issue: 911
recorded: 2026-11-22
versions: { squiz: 4e8911d }
recheck-when: squiz changes how it starts a command in a tmux window or a Herdr pane
---

# Only a tmux start runs the reviewer before squiz confirms it

## Intent

- Whether a pane start that fails can have run the reviewer, under each
  backend.

## Decisions

- **Charge a failed tmux start what the reviewer's report file says.** tmux
  execs the command itself, from separate arguments after `--` in
  `new-window`, and it runs as the window opens. A start that fails after that,
  such as one whose pid could not be identified, ran the reviewer until it was
  stopped.
- **Charge a failed Herdr start nothing.** Herdr execs the pane's argv itself,
  with no shell, as the `layout.apply` that opens the pane returns. That argv
  is squiz's gate, a `/bin/sh` that writes its pid and waits for a `go` file
  before it execs the command. squiz writes `go` only once the pid is read and
  Herdr confirms the pane's process and foreground group are that pid, so a
  start that fails before then never runs the reviewer. A gate never opened
  gives up after its polls run out, so a pane that could not be closed still
  runs nothing.

## Needs your input

Nothing.

## Reference

The Herdr call, from `startBehind` in `src/sessions/herdr.ts`:

```json
{"method":"layout.apply","params":{"root":{"type":"pane","command":["/bin/sh","-c","<GATE>","<gate dir>","<polls>","<program>","<argument>","…"],"cwd":"<directory>","env":{},"label":"<name>"},"tab_label":"<name>","focus":false}}
```

The tmux call, from `openWindow` in `src/sessions/tmux.ts`:

```
tmux new-window [-e NAME=value …] -d -P -F '#{window_id}\t#{pane_pid}' -n <name> -c <directory> -- <program> <argument> …
```

A one-word command goes through `/bin/sh -c 'exec "$0"' <program>`, since tmux
hands a single word to its default shell.

## Limits

- **Read from the code, not from a run.** The Herdr tests run against a fake
  server that execs the pane's argv in the background, as Herdr would. The tmux
  tests run a real tmux where one is installed.
- **That Herdr runs nothing is squiz's doing, not Herdr's.** Herdr starts the
  pane's process as the pane opens, like tmux. What it starts is the gate.
