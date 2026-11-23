---
settles: "§ 3 The report: whether the socket wake reaches a subagent's parent"
issue: 301
recorded: 2026-11-24
versions: { claude-code: 2.1.289, tmux: 3.7b, macos: 26.6.2 }
recheck-when: Claude Code changes which environment it gives a SubagentStop hook, gives a subagent a messaging socket of its own, or starts checking the token on macOS
---

# The socket a subagent's hook sees wakes its parent

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
  process, and a subagent runs inside its parent's process with none of its
  own, so the value the hook sees is the parent's. It matched the parent's own
  `Stop` firing in every session.
- **Record the token from the same environment, and open the post with it.**
  Posts with and without it both woke the parent in manual mode on macOS. A
  parent that bypasses permission prompts holds a post without it for a
  person's approval (unverified for a subagent's parent).
- **Wake a subagent's parent through the socket.** A post from a double-forked
  process the hook started, 40 seconds after the parent's turn ended, started a
  turn in the parent every time. It needs no process kept alive for the parent.
- **Expect a plain `claude -p` parent to be unreachable, and a `-p` parent with
  stream-json input held open to be reachable.** A plain `-p` session removes
  its socket when it exits, which is before any review can finish, and the post
  fails with `FileNotFoundError`. A `-p` session reading
  `--input-format stream-json` from an open stdin stays alive, and a post
  starts a turn in it as it does interactively.

## Needs your input

Nothing.

## Reference

- **The socket** is `/tmp/cc-socks/<pid of claude>.sock`. The hook's
  `CLAUDE_PID` is that pid, and `CLAUDE_CODE_SESSION_ID` is the parent's
  `session_id`.
- **The post** is one line:

  ```json
  {"type":"user","message":{"role":"user","content":"<the note>"}}
  ```

  The parent's transcript records it with
  `"origin":{"kind":"peer","from":"unknown","verifiedPeerPid":<poster pid>}`,
  and an interactive session shows it as `Another Claude session sent a
  message:` followed by the text.
- **Interactive sessions fire `SubagentStop` with `"agent_type": ""`** two or
  three more times a turn, three to eight seconds after the parent's `Stop`,
  each with a fresh `agent_id`, the parent's `session_id`, the same socket and no
  `last_assistant_message`. No file exists at their `agent_transcript_path`.
  They do not occur in print mode, and are not the coding agent's work.

## Limits

- **macOS only.** Whether the token is needed on Linux is not established.
- **Background subagents only.** The runtime backgrounded the subagent in every
  run, including the one whose prompt asked for the foreground. A foreground
  subagent's hook, and a subagent resumed with `SendMessage`, were not run.
- **One subagent per session, with no isolation.** Concurrent subagents and
  `isolation: "worktree"` were not run.
- **Manual mode and Haiku only.** Auto mode and a session that bypasses
  permissions were not run.
- **Idle for under two minutes.**
- **The subagent's own tool environment was not captured**, only the hook's.
