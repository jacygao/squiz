---
settles: "§ 5: how the round host stops a reviewer in a tmux window, and which pid it signals"
issue: 300
recorded: 2026-10-04
versions: { tmux: 3.7b, macos: 26.6.2, zsh: 5.9 }
recheck-when: tmux changes how it closes a window or signals a pane's processes
---

# tmux's kill-window signals only the window's command

## Intent

- Which processes tmux's `kill-window` signals, and with what.
- What the rest of the command's group gets when the window's command exits by
  itself.
- Whether `#{pane_pid}` is the command or a shell above it.

## Decisions

- **Signal the reviewer's group before closing its tmux window, and never count
  the close as the stop.** `kill-window` sends one `SIGHUP` to the pane's pid,
  about 5 ms after the call, and nothing follows it in 30 seconds. The rest of
  the group gets `SIGHUP` only from the kernel, once the pane's process dies. A
  command that ignores `SIGHUP` ran on after its window had gone, with
  everything under it, in six runs of six.
- **Expect the group to get `SIGHUP` when the command exits.** The pane's
  process leads its own session, so its exit hangs up the terminal and the rest
  of its group gets `SIGHUP`. A member that ignores it runs on. The window
  closes by itself when its command exits.
- **Signal the group of `#{pane_pid}`.** The pane's process leads its own
  session and group. Where the command execs, as squiz's argv after `--` does,
  `#{pane_pid}` is the command itself. Where a shell runs something after the
  command, as in `cmd; echo done`, it is the shell, and the command is its child
  in the same group, so the group holds the command either way.

## Needs your input

Nothing.

## Reference

What reached each process, by how it handles `SIGHUP`. "Child" is the command's
child and grandchild, in the command's group.

| Event | Command dies of `SIGHUP` | Command and children ignore `SIGHUP` |
|---|---|---|
| `kill-window` | Command: `SIGHUP`. Children: `SIGHUP` once the command dies | Command: `SIGHUP`, survives. Children: nothing, survive |
| The command exits | Children: `SIGHUP` | Children: `SIGHUP`, survive |

```
tmux display -p -t <window> '#{pane_pid}'
```

## Limits

- **macOS only.** It turns on how the kernel hangs up a terminal, so it does not
  carry over to Linux unmeasured.
- **One shell.** tmux ran string commands through `zsh -c`. squiz now passes an
  argv after `--`, and that `#{pane_pid}` is the command there is read from the
  code, not re-run *(unverified)*.
- **Not run:** `tmux kill-session`, `kill-pane`, and a window started with
  `remain-on-exit`.
