---
settles: "§ 5 The reviewer session: how a reviewer started through Herdr's layout.apply is identified, when its tab closes, what closing its pane does to it, and which PATH it runs on"
issue: 911
recorded: 2026-11-22
versions: { herdr: 0.9.3, macos: 26.6.2, node: 24.15.0 }
recheck-when: Herdr changes how layout.apply spawns an argv pane, when it removes a pane whose process exited, or how pane close stops a pane's process
---

# A layout.apply pane is its command, with no shell above it

## Intent

- Whether a tab built by `layout.apply` closes when its argv process exits, or
  only its pane.
- Whether `pane.process_info` on an argv pane reports the command as
  `shell_pid` and as the foreground process group.
- Whether `pane close` on a live argv pane signals its process.
- Which `PATH` an argv pane's process has, and where the server got it.

## Decisions

- **Expect the tab to be gone once the reviewer exits, and keep closing the pane
  as a no-op that confirms it.** Three seconds after the argv process exited,
  `tab list` no longer had its tab and `pane get` answered `pane_not_found`. The
  workspace and its other tabs stayed, a plain shell tab included.
- **Read the reviewer's pid from `shell_pid`, and require the foreground group
  to be the same pid.** For `["/bin/sh", "-c", …]` both were the `sh`'s pid,
  the one it wrote with `echo $$`, and `ps` showed it leading its own session,
  group and terminal foreground group (`pid = pgid = tpgid`). A command that
  `exec`s keeps all three.
- **Count `pane close` as a stop of the reviewer, but go on signalling the
  reviewer's group first.** A process with a `SIGHUP` handler got `SIGHUP`, and
  its handler ran. One that ignored `SIGHUP` was gone when `pane close`
  returned, 289 ms after the call, and so was a member of its group that also
  ignored it. The close is no help for a process in a session of its own.
- **Give the pane squiz's own `PATH` in `env`, and find the reviewer's program
  on it before Herdr opens anything.** The pane's process has the server's
  `PATH`, or the one `env` gives, and no shell's startup files run. The server's
  environment is whatever started it: `herdr` spawns its server with
  `Command::new(current_exe()).arg("server")` and no login shell, so a server
  first started from somewhere without a profile's directories cannot find a
  `pi` that only the profile puts on the path. Behind squiz's gate, a program
  missing from the path fails the gate's `command -v` after the pane has
  opened, where `layout.apply` itself would have refused it.

## Needs your input

Nothing.

## Reference

The request, as one line of JSON on the socket `HERDR_SOCKET_PATH` names. There
is no CLI for it.

```json
{"id":"x1","method":"layout.apply","params":{"root":{"type":"pane","command":["/bin/sh","-c","…"],"cwd":"/tmp/…","env":{"MARK":"m1"},"label":"pane-label"},"tab_label":"q1-tab"}}
```

The answer, one line:

```json
{"id":"x1","result":{"type":"layout_apply","layout":{"workspace_id":"w1","tab_id":"w1:t3","zoomed":false,"focused_pane_id":"w1:p3","root":{"type":"pane","pane_id":"w1:p3","label":"pane-label","cwd":"/tmp/…","command":["/bin/sh","-c","…"]}}}}
```

What `pane process-info` says while it runs:

```json
{"foreground_process_group_id":37455,"foreground_processes":[{"argv":["sleep","3"],"pid":37457},{"argv":["/bin/sh","-c","…"],"pid":37455}],"pane_id":"w1:p3","shell_pid":37455}
```

Refusals, each with no tab opened:

| Request | `error.code` | `error.message` |
|---|---|---|
| `workspace_id: "w999"` | `workspace_not_found` | `workspace w999 not found` |
| No `workspace_id`, and no workspace at all | `workspace_not_found` | `no active workspace` |
| `command: []` | `invalid_layout` | `pane command must not be empty` |
| A program not on the path | `layout_apply_failed` | `Unable to spawn no-such-program-xyz because:\nNo viable candidates found in PATH "/usr/bin:/bin"` |

- **Without `workspace_id` the tab opens in the active workspace.**
- **`env` reaches the command as given.** A value holding a quote and `$HOME`
  arrived literally, and an empty value arrived set and empty. The command also
  had `TERM=xterm-256color`, `HERDR_PANE_ID`, and the server's `SHELL` and
  `PATH`.

## Limits

- **macOS only**, one run of each case.
- **The server was headless**, started with `herdr --session <name> server`
  under a home of its own. A server with a client attached was not tried.
- **Which signals `pane close` sent after `SIGHUP` was not logged.** The process
  that ignored `SIGHUP` was gone, which fits the `SIGKILL` Herdr's vendored
  `portable-pty` sends after about 200 ms (unverified: read from the source,
  not traced).
- **A tab that is its workspace's only tab was not tried.** Squiz opens its tab
  in a workspace the coding agent's pane is in, so it always has another.
- **Not tried:** a process in a session of its own under the argv command, and
  a command that exits while `layout.apply` is still answering.
