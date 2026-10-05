---
settles: "§ 4 — what a tmux window close and a Herdr pane close reach, and which pid the round host signals for a reviewer in a pane; § 8 — the prerequisite on what closing a pane reaches"
issue: 300
recorded: 2026-10-04
versions: { tmux: 3.7b, herdr: 0.9.3, pi: 0.85.1, macos: 26.6.2, zsh: 5.9 }
recheck-when: tmux or Herdr change how they close a pane or signal its processes; pi changes its SIGHUP or SIGTERM handler or how it spawns a shell
---

# A pane close never reaches a session of its own, and tmux's reaches only the command

tmux's `kill-window` sends one `SIGHUP` to the pane's own process and nothing
after it. Herdr's `pane close` sends `SIGHUP`, then `SIGTERM`, then `SIGKILL`, to
every process in the pane's shell session. Neither reaches a process in a
session of its own. When `pi` is the pane's command, it answers the close by
killing the group of each shell it started, so a pane close does stop the
reviewer and its shells. A process that one of those shells moved into a further
session is reached by nothing here.

## Intent

- Which processes tmux's `kill-window` signals, and with what: the pane's
  command, its children, a grandchild in the same group, and a process in a
  session of its own, as a `pi` shell is. The same where the window's command
  exits by itself.
- The same for Herdr's `pane close`, and where the pane's command exits.
- Whether Herdr returns a pane to its shell when the `pi` that
  `herdr agent start` started exits.
- How the pid of a pane's command is read from each backend, and whether it is
  the command or a shell above it.

## Decisions

- **Signal the reviewer's group before closing a tmux window. Never count the
  close as the stop.** `kill-window` sends `SIGHUP` to the pane's pid alone,
  about 5 ms after the call, and nothing follows it in 30 seconds. The rest of
  the group gets `SIGHUP` only from the kernel, and only when the pane's process
  dies. So a command that ignores `SIGHUP` keeps running after its window has
  gone, with everything under it. In six runs out of six it did.

- **Count a Herdr pane close as a stop of the pane's session, and nothing
  more.** Every process in the shell's session got `SIGHUP` about 20 ms after
  the call, `SIGTERM` about 260 ms after that, and was gone within 6 seconds
  with nothing logged, which is `SIGKILL`. That included the members of a job
  whose leader had exited and which was no longer in the foreground. The order
  the spec gives in § 4 — the reviewer's group, the recorded groups, then the
  pane — stays right for both backends.

- **Keep signalling the groups the shells recorded. A pane close reaches none
  of them.** A process in a session of its own got no signal from either
  backend, in any run. With `pi` as the command, its own handler does the work:
  on `SIGHUP`, on `SIGTERM` and on a normal exit, it sends `SIGKILL` to the group
  of each shell it started. Those groups were gone, with nothing logged, after
  every close and every quit.

- **Expect a process a tool moved into a further session to outlive the round
  whenever it does not write to `pi`'s output.** Below a `pi` shell, such a
  process died of `SIGPIPE` on its next write once `pi` had gone. One that never
  wrote ran on, after both backends' close and after `pi` quitting. Nothing in
  § 4 reaches it: it is in neither the reviewer's group nor a recorded one.

- **Read a tmux pane's pid with `#{pane_pid}`, and signal its group.** It is
  the command itself wherever the command line is one command, because tmux runs
  it with `$SHELL -c` and the shell execs it. That held for `cmd`,
  `VAR=1 cmd`, `cd dir && cmd` and `exec cmd`. Where something follows the
  command, as in `cmd; echo done`, it is the shell, with the command as its
  child in the same group. The pane's process leads its own session and group,
  so the group of `#{pane_pid}` holds the command either way.

- **Read a Herdr pane's pid from `foreground_process_group_id`, never from
  `shell_pid`, and read it while `pi` is running.** A Herdr pane runs an
  interactive shell, which puts `pi` in a job group of its own. `shell_pid` is
  the shell, and its group does not hold `pi`. While `pi` runs,
  `foreground_process_group_id` is `pi`'s pid and its group. Once `pi` exits it
  is the shell's again, so the round host records it as soon as
  `herdr agent start` returns.

  2026-10-05: squiz now starts the reviewer with `herdr pane run` behind a
  gate, and reads the group before `pi` runs. § 4 The reviewer session says
  how.

- **Have the round host close a Herdr pane itself once `pi` exits.** Herdr
  returns the pane to its shell, as its documentation says: in four runs out of
  four the shell's prompt came back, the foreground process was `zsh`, and
  `herdr agent get <name>` answered `agent_not_found`. A tmux window closes by
  itself when its command exits, in every run.

- **Expect what a command leaves in its group to be treated differently when
  the command exits.** In tmux the pane's process leads the session, so its exit
  hangs up the terminal, and the rest of its group gets `SIGHUP`. In Herdr the
  shell leads the session and stays, so the rest of the job's group gets nothing
  until the pane closes.

## Needs your input

- **Whether § 4 should state the gap below a `pi` shell.** A tool that moves a
  process into a session of its own, a daemon for instance, and sends it no
  output through `pi`, outlives the round on both backends and detached. The
  recorded groups are each shell's own, and this process is outside them.
  Recommendation: state it in Confinement as a hole for a later milestone, and
  build nothing for it now. Reaching it means finding processes by something
  other than group, such as an environment marker or the scratch directory as a
  working directory, and that is a design of its own.

  2026-10-05: settled as recommended. § 4 The reviewer session states the gap,
  and says nothing in this version detects it.

## Reference

### What reached what

`plain` dies of any signal it gets. `nohup` logs `SIGHUP` and carries on. `deaf`
logs `SIGHUP` and `SIGTERM` and carries on. "Same session" is the pane's command,
its child and its grandchild, all in the command's group. "Own session" is a
process started with `setsid` under the command.

| Backend, event | Same session, `plain` | Same session, `nohup` or `deaf` | Own session |
|---|---|---|---|
| tmux `kill-window` | Command: `SIGHUP`. Child, grandchild: `SIGHUP` when the command dies of it | Command: `SIGHUP`, survives. Child, grandchild: nothing, survive | Nothing |
| tmux, command exits | Child, grandchild: `SIGHUP` | Child, grandchild: `SIGHUP`, survive | Nothing |
| Herdr `pane close` | All three: `SIGHUP` | `nohup`: `SIGHUP`, then `SIGTERM`, dies. `deaf`: both, then gone unlogged | Nothing |
| Herdr, command exits | Child, grandchild: nothing until the pane closes | The same | Nothing |

An own-session process whose output was a pipe to the command died of `SIGPIPE`
once the command was gone, in every cell where the command died. One whose
output was the terminal got `EIO` on each write and ran on.

With `pi` as the command and the stand-in started from `pi`'s `!` prompt:

| Event | The shell `pi` started, and its group | Own session below it, writing to `pi` | Own session below it, writing nothing |
|---|---|---|---|
| tmux `kill-window` | Gone unlogged | `SIGPIPE` | Runs on |
| `pi` quits, in tmux | Gone unlogged | `SIGPIPE` | Runs on |
| Herdr `pane close` | Gone unlogged | `SIGPIPE` | Runs on |
| `pi` quits, in Herdr | Gone unlogged | `SIGPIPE` | Runs on |

`pi`'s handler, read from its bundle: on `SIGTERM` and `SIGHUP` it calls
`killTrackedDetachedChildren()`, which runs `process.kill(-pid, "SIGKILL")` for
each shell it spawned with `detached: true`, then exits 129 on `SIGHUP` and 143
on `SIGTERM`.

### Reading the pid

```
tmux display -p -t <session>:<window> '#{pane_pid}'
herdr pane process-info --pane <pane_id>
```

What `herdr pane process-info` returned with `pi` running:

```json
{"process_info":{"foreground_process_group_id":99505,
 "foreground_processes":[{"name":"node","pid":99505}],
 "pane_id":"w1:pK","shell_pid":99490}}
```

A shell `pi` started is in a session of its own, so it never shows among
`foreground_processes`.

### A private Herdr server

`herdr --session <name> server` starts a headless server on
`~/.config/herdr/sessions/<name>/herdr.sock`. Pointing `HERDR_SOCKET_PATH` at
that socket keeps every command off the user's own server.
`herdr session stop <name>` and `herdr session delete <name>` remove it.

### Re-running it

The stand-in is a Python script that traps every catchable signal and logs its
name with a timestamp, its pid, parent, group and session. It logs when its
parent changes, and when a write to its output fails. It starts the tree in the
tables above. Each cell ran it as the pane's command:

```
tmux -L <socket> new-window -d -n <name> 'python3 standin.py <log> <mode> cmd tree <lifetime>'
tmux -L <socket> kill-window -t <session>:<name>

herdr tab create --workspace <id> --cwd <dir> --label <name> --no-focus
herdr pane run <pane> 'python3 standin.py <log> <mode> cmd tree <lifetime>'
herdr pane close <pane>

herdr agent start <name> --kind pi --pane <pane> -- --no-session
herdr pane send-text <pane> '!python3 standin.py <log> <mode> bang-shell tree 40'
herdr pane send-keys <pane> enter
herdr agent send-keys <name> ctrl+d
```

A check with `ps` 6 seconds after the event says what survived. The log says
what reached it.

## Limits

- **macOS only.** Linux was not run. Every result here turns on how the kernel
  hangs up a terminal and delivers signals to a session, so none of it carries
  over to Linux unmeasured.
- **Runs per cell.** tmux with the stand-in: six per cell, and two more watching
  a `nohup` command for 30 seconds after `kill-window`. Herdr with the stand-in:
  three per cell, and two with `deaf`. With `pi`: two per cell, four for `pi`
  quitting in tmux with a quiet process below it.
- **That Herdr's last signal is `SIGKILL` is inferred.** The `deaf` processes
  vanished with nothing logged, about 0.6 seconds after the close, in both runs.
  How long Herdr waits between signals was read off two runs, not measured
  against a timer.
- **Herdr's target was inferred from who got the signal.** Every process in the
  shell's session got it, including ones no longer in the foreground group, and
  nothing outside the session did. Whether Herdr signals the session, the
  terminal's processes, or each process it finds by walking the tree was not
  told apart.
- **`pi`'s shell was reached through the `!` prompt, not the model's `bash`
  tool.** Both spawn through the same function in the bundle *(unverified — read
  from the bundle, not run)*. No model call was made.
- **One shell in each backend.** tmux ran commands through `zsh -c`, and Herdr's
  pane shell was an interactive `zsh`. A shell with job control off, or one that
  does not forward `SIGHUP` to its jobs, was not tried.
- **Not run:** `tmux kill-session` and `kill-pane`, `herdr tab close`, a tmux
  window started with `remain-on-exit`, and `herdr agent get` as a source of
  the pid.
- **Starting `pi` interactively writes to its config directory**, as the note
  on an interactive `pi` in a pane found. Nothing here measured that again.
