---
settles: "§ 3 — whether the socket wake reaches a subagent's parent; § 8 — the open prerequisite on the socket wake"
issue: 301
recorded: 2026-10-04
versions: { claude-code: 2.1.289, tmux: 3.7b, macos: 26.6.2 }
recheck-when: Claude Code changes which environment it gives a SubagentStop hook, gives a subagent a messaging socket of its own, or starts checking the token on macOS
---

# A subagent's hook carries its parent's socket, and a post to it wakes the idle parent

Yes on both counts. In every run, the `SubagentStop` hook's
`CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` were the ones the
parent's own `Stop` hook saw in the same session. A double-forked process that
the hook started posted to that socket 40 seconds later, after the parent's turn
had ended, and the parent started a turn every time, with the token and without
it.

## Intent

- Whether a `SubagentStop` hook's environment carries
  `CLAUDE_CODE_MESSAGING_SOCKET`, and whether it is the parent session's.
- Whether a post to it, from a process outside the hook's tree, starts a turn in
  the idle parent.
- Whether `CLAUDE_CODE_MESSAGING_TOKEN` must be carried for that.
- Whether print mode differs from an interactive session.

## Decisions

- **Record the socket from the `SubagentStop` hook's environment as the owner's
  socket, as the `Stop` hook does.** There is one socket per Claude Code
  process, at `/tmp/cc-socks/<pid of claude>.sock`. The subagent runs inside the
  parent's process and has none of its own, so the value the hook sees is the
  parent's. The § 3 table records only `session_id` and `agent_id` for
  `SubagentStop`; the socket can be recorded there too.
- **Carry the token with the socket, though macOS did not need it.** Posts with
  and without the token both woke the parent. The token is in the same
  environment, costs nothing to record, and is what a platform that checks it
  would want.
- **Use the socket as the wake for a subagent's result, with the `Stop` waiter
  kept for the case where no socket was recorded.** The socket wake needs no
  process kept alive for the parent, and reached it in every run.
- **Expect a plain `claude -p` parent to be unreachable, and a `-p` parent with
  stream-json input held open to be reachable.** A plain `-p` session removes its
  socket when it exits, which is before any review can finish, and the post
  fails with `FileNotFoundError`. A `-p` session reading
  `--input-format stream-json` from an open stdin stays alive, and a post started
  a turn in it as it did interactively.

## Needs your input

Nothing.

## Reference

### Results

Each row is one session. "Same as `Stop`" compares the socket path and a hash of
the token between the `SubagentStop` firing for the dispatched subagent and the
parent's `Stop` firings in that session. "Idle for" is the time from the parent's
last `Stop` firing to the post.

| Run | Mode | Poster started by | Token carried | Same as `Stop` | Idle for | Parent started a turn |
|---|---|---|---|---|---|---|
| i1 | interactive | the calling shell | no | yes | 70 s | yes, replied `woken-a` |
| i2 | interactive | the `SubagentStop` hook | yes | yes | 40 s | yes |
| i3 | interactive | the `SubagentStop` hook | no | yes | 40 s | yes |
| i4 | interactive | the `SubagentStop` hook | yes | yes | 40 s | yes |
| i5 | interactive | the `SubagentStop` hook | no | yes | 39 s | yes |
| p1 | `-p` | the `SubagentStop` hook | no | yes | exited | no, socket gone |
| p2 | `-p` | the `SubagentStop` hook | yes | yes | exited | no, socket gone |
| ps1 | `-p`, stream-json stdin held open | the `SubagentStop` hook | no | yes | 38 s | yes |
| ps2 | `-p`, stream-json stdin held open | the `SubagentStop` hook | yes | yes | 39 s | yes |

In every run that woke, the wake turn ended with a `Stop` firing within three
seconds of the post, and the transcript recorded the post as
`"origin":{"kind":"peer","from":"unknown","verifiedPeerPid":<poster pid>}`. The
poster's parent was pid 1 and its session id was its own, so it was outside the
hook's tree. The interactive session showed the post as
`Another Claude session sent a message:` followed by the text, as for a session's
own socket.

### How it was measured

- Nested `claude --model haiku` sessions, started under `env -i` so that no
  messaging variable of the calling session leaked in, in a scratch project whose
  `.claude/settings.json` registered `Stop` and `SubagentStop` command hooks.
  Interactive sessions ran in tmux on a private socket.
- One hook dumped its environment, pid, parent command and payload per firing.
  The other, on `SubagentStop` for `general-purpose` only, started
  `poster.py` from its own environment's socket and token. `poster.py` forks,
  calls `setsid`, forks again, puts stdio on `/dev/null`, sleeps 40 seconds, and
  writes the auth line (when carrying the token) and the user line to the socket.
- The prompt asked the parent to dispatch one `general-purpose` subagent that
  replies `PONG`, and to reply `DONE` when it returned. The post asked for
  `woken-<run>`.

### What the hook's environment held

`CLAUDE_PID` equalled the pid in the socket path, and was the `claude` process
the hook's parent command named. `CLAUDE_CODE_SESSION_ID` equalled the payload's
`session_id`, the parent's. `lsof` showed the socket held open by that `claude`
process alone.

### Firings with an empty `agent_type`

Interactive sessions fired `SubagentStop` two or three more times per turn, three
to eight seconds after the parent's `Stop`, with `"agent_type": ""`, a fresh
`agent_id`, the parent's `session_id`, the same socket, and no
`last_assistant_message`. No file existed at their `agent_transcript_path`, and
`background_tasks` was empty. They did not occur in print mode. What the runtime
runs as these agents was not determined.

## Limits

- **macOS only.** Linux was not run, so whether the token is needed there is not
  established.
- **Background subagents only.** The runtime backgrounded the subagent in every
  run, including the one whose prompt asked for the foreground. A foreground
  subagent's hook, and a subagent resumed with `SendMessage`, were not run.
- **One subagent per session, with no isolation.** Concurrent subagents and
  `isolation: "worktree"` were not run.
- **Manual mode only, and Haiku only.** Auto mode and a session that bypasses
  permissions were not run.
- **Idle for under two minutes.** The S3 measurement of a session's own socket
  after ten minutes was not repeated here.
- **The subagent's own tool environment was not captured.** Only the hook's was.
- **The scratch project sat inside a trusted directory**, so no trust dialog was
  answered.
