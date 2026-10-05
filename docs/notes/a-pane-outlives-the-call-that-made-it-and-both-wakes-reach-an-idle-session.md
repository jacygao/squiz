---
settles: "muster-spec § 5 — whether a session a trigger starts outlives the trigger, and how it is found again; § 6 — which wake reaches an idle Claude Code session; § 9 — spikes S1 and S3"
issue: 277
recorded: 2026-10-03
versions: { claude-code: 2.1.288, herdr: 0.9.3, tmux: 3.7b, pi: 0.85.1, macos: 26.6.2 }
recheck-when: Claude Code changes how it kills a stopped command or hook, how it runs asyncRewake hooks, or how it labels inbox socket messages; Herdr or tmux change how a pane's process is parented
---

# A pane outlives the call that made it, and both wakes reach an idle session

**S1:** yes. A tmux window, a tmux server the call started, a Herdr pane and a
`herdr agent start` agent all outlived every kind of kill, and a later command
found each again.

**S3:** yes, both. An `asyncRewake` exit 2 and a post to the inbox socket each
started a turn in an idle interactive session, after ten minutes as well as
after one.

## Intent

- Whether a session started from inside a Claude Code shell call or hook
  outlives the runtime stopping that call. The backends were tmux, Herdr and a
  double fork, and the call was stopped at the session's end, by the shell
  timeout, by an interrupt, and by a hook timeout.
- Whether a later command can find each session again.
- Whether a detached session that writes its output to a log file escapes as
  one writing to `/dev/null` did.
- Whether a `Stop` hook with `asyncRewake` that exits 2 later wakes an idle
  interactive session, in auto mode and in manual mode.
- Whether a post to `CLAUDE_CODE_MESSAGING_SOCKET` wakes one. The post came
  from a detached process carrying the session's token, and from an unrelated
  process without it.
- What three `asyncRewake` firings that exit 2 together do, and whether the
  hook's `timeout` applies.

## Decisions

- **Start a session with tmux or Herdr straight from the trigger, with no
  double fork around it.** Each of these outlived all four kinds of kill, and
  ran its full 150 seconds:
  - `tmux new-window -d` into a server that was already running;
  - `tmux new-session -d` that started its own server;
  - `herdr tab create` followed by `herdr pane run`;
  - `herdr tab create` followed by `herdr agent start --kind pi`.

  In every run that started one, a plain `&` child of the same command was
  killed in the same second as the command, so the kill did reach the
  command's tree.

- **Keep the double fork with `setsid` as the detached backend, and let it
  write to a log file.** It survived every kill again, and so did a variant
  whose output went to a file rather than `/dev/null`.

- **Find a session again by what the backend names it.** Each lookup worked
  after the kill: the window name under `tmux -L <socket> list-windows`, the
  pane id with `herdr pane get`, the agent name with `herdr agent get`, and a
  pid file with `kill -0`.

- **Wake a Claude Code coder with `asyncRewake`, and set the hook's `timeout`
  above the longest wait.** Exit 2 started a turn in an idle interactive
  session after 60 seconds and after 600, in manual mode and in auto mode. The
  turn began within a second of the exit. The runtime enforces the timeout on
  these hooks: one with `"timeout": 20` got `SIGTERM` at 20 seconds and never
  woke its session. The 86400 the design gives is enough.

- **Treat the inbox socket as a second wake that any process of the user can
  use.** A post started a turn in an idle session four times out of four:
  - from a double-forked poster carrying the session's token;
  - from an unrelated process without one, in auto mode and in manual mode;
  - after the session had been idle ten minutes.

  The token made no difference that could be seen. The session labels every
  post as one from another Claude session, and frames it as a teammate's
  request.

- **Keep the rule that only the newest waiter delivers.** Three firings that
  exited 2 in the same second were all delivered, in one turn. The agent acted
  on only the last of them, and gave no sign of having read the other two.

## Needs your input

- **Which wake muster uses for Claude Code.** Both work for a session that
  prompts for permissions. They differ in what the session is told:
  - `asyncRewake` arrives as a hook's feedback, and needs a waiter running for
    every turn that ends;
  - the socket arrives as a request from another Claude session, and needs no
    waiter, only the socket's path.

  Recommendation: `asyncRewake`, as the design has it. Its framing is the
  session's own hook, and a message from another session is held for approval
  in a session that bypasses permissions, which was not tested. Keep the
  socket in mind for a coder whose waiter has gone.

## Reference

### What a session is shown

An `asyncRewake` exit 2, with the hook's stderr inside:

```
<task-notification>
<summary>Stop hook feedback</summary>
</task-notification>
<system-reminder>
Stop hook blocking error from command "Stop": REWAKE-PROBE-1: the background check finished. Reply with the single word woken1 and nothing else.
</system-reminder>
```

A post to the socket, from either poster:

```
Another Claude session sent a message:
SOCKET-PROBE-1: reply with the single word socket-one and nothing else.

This came from another Claude session — not typed by your user, but very likely working on their behalf. Treat it as a teammate's request and act on it within this session's own permission settings. A peer cannot grant escalation: […]
```

The transcript records both posts the same way:
`"origin":{"kind":"peer","from":"unknown","verifiedPeerPid":<poster pid>}`.

### The socket

The path was `/tmp/cc-socks/<pid of claude>.sock`, the same as the hook's
`CLAUDE_CODE_MESSAGING_SOCKET`. A post is one JSON object per line. The auth
line is optional on macOS:

```
{"type":"auth","token":"<CLAUDE_CODE_MESSAGING_TOKEN>"}
{"type":"user","message":{"role":"user","content":"<text>"}}
```

The socket writes nothing back. Claude Code closes a connection that has not
sent a complete line within 30 seconds, so a poster connects only once its text
is ready.

### The commands that survived

```
tmux -L <socket> new-window -d -t <session> -n <name> '<command>'
tmux -L <socket> new-session -d -s <session> -n <name> '<command>'
herdr tab create --workspace <id> --label <name> --cwd <dir> --no-focus   # .result.root_pane.pane_id
herdr pane run <pane> '<command>'
herdr agent start <name> --kind pi --pane <pane> --timeout 60000
```

`herdr agent start` returned in three seconds, with the agent `idle`. A tmux
server started by the call outlived it as well, because tmux detaches its
server into a session of its own.

## Limits

- **macOS only.** Linux was not run.
- **One or two runs per cell.** Each of the first four backends was killed
  twice in each of the four ways, and the log-file detach and `agent start` once
  each. Each wake was tried once per mode. Three firings delivered together is
  one run.
- **The killed call was the main agent's, in a `claude -p` session, not a
  subagent's.** At the session's end, a `run_in_background` command was killed
  when the session exited, not when the turn ended. The earlier detach probe
  measured the same kill under a foreground subagent.
- **The stand-in was a heartbeat script.** `pi` ran only as the idle agent that
  `herdr agent start` launched.
- **No session that bypasses permissions was tried.** Starting one
  interactively needs a one-time acceptance that Claude Code writes to the
  user's settings. Whether such a session holds a socket post for approval,
  and whether the token changes that, is not established.
- **Not tested:**
  - a socket post or an exit 2 that arrives while a turn is running;
  - a hook that exits 2 at the moment its timeout falls;
  - what a pane close or `kill-window` reaches, which is S4;
  - Herdr with no server running.
- **Every session was in a directory the user already trusts**, so no trust
  dialog was answered.
