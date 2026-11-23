---
settles: "§ 5: which tools a reviewer in a pane may be granted, given what a pane close reaches"
issue: 300
recorded: 2026-10-04
versions: { tmux: 3.7b, herdr: 0.9.3, pi: 0.85.1, macos: 26.6.2, zsh: 5.9 }
recheck-when: tmux or Herdr change how they close a pane or signal its processes; pi changes its SIGHUP or SIGTERM handler or how it spawns a shell
---

# A pane close never reaches a session of its own

## Intent

- Whether tmux's `kill-window` or Herdr's `pane close` reaches a process under
  the pane's command that runs in a session of its own.
- Whether `pi` stops the shells it starts when it is signalled or quits.

## Decisions

- **Never grant a reviewer a tool that leaves the reviewer's group.** Neither
  backend's close signalled a process in a session of its own, in any run, so
  nothing but the reviewer itself can stop one. No reviewer is granted a shell
  (§ 5 Tools), so nothing the reviewer starts leaves its group.
- **Do not rely on `pi` to stop what its shells start.** `pi` starts each shell
  command in a session of its own, and kills those groups itself on `SIGHUP`,
  `SIGTERM` and a normal exit. A process one of those shells moved into a
  further session ran on after either backend's close and after `pi` quit,
  unless it wrote to `pi`'s output and died of `SIGPIPE`.

## Needs your input

Nothing.

## Reference

- **`pi`'s handler, read from its bundle:** on `SIGTERM` and `SIGHUP` it calls
  `killTrackedDetachedChildren()`, which runs `process.kill(-pid, "SIGKILL")`
  for each shell it spawned with `detached: true`. It then exits 129 on `SIGHUP`
  and 143 on `SIGTERM`.
- **A process in a session of its own whose output was a pipe to the command**
  died of `SIGPIPE` once the command was gone. One whose output was the
  terminal got `EIO` on each write and ran on.
- **A private Herdr server keeps a measurement off the user's own.**
  `herdr --session <name> server` listens on
  `~/.config/herdr/sessions/<name>/herdr.sock`, `HERDR_SOCKET_PATH` points a
  command at it, and `herdr session stop <name>` and
  `herdr session delete <name>` remove it.

## Limits

- **macOS only.** Every result turns on how the kernel hangs up a terminal and
  delivers signals to a session, so none of it carries over to Linux unmeasured.
- **Herdr was measured with a shell in the pane.** squiz now starts the reviewer
  as the pane's own argv through `layout.apply`. A process in a session of its
  own under such a pane was not tried *(unverified)*.
- **`pi`'s shell was reached through the `!` prompt, not the model's `bash`
  tool.** Both spawn through the same function in the bundle *(unverified: read
  from the bundle, not run)*.
- **Not run:** `tmux kill-session` and `kill-pane`, `herdr tab close`, and a
  tmux window started with `remain-on-exit`.
