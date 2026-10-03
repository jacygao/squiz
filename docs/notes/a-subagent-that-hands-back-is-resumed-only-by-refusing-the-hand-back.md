---
settles: "§ 3 — where a round can still block the coding agent; § 2 — what Claude Code was verified against"
issue: 278
recorded: 2026-10-03
versions: { claude-code: 2.1.288, coding-agent: claude-opus-5-5 and claude-sonnet-5 }
recheck-when: Claude Code changes the hand-back, auto mode, or how PreToolUse and SubagentStop decisions are delivered
---

# A subagent that hands back is resumed only by refusing the hand-back

## Intent

- Whether a `SubagentStop` block still resumes a subagent on Claude Code 2.1.288.
- Whether the JSON form, `{"decision":"block","reason":"…"}` with exit 0,
  behaves differently from exit 2.
- Whether foreground dispatch, background dispatch or `isolation: "worktree"`
  changes the answer.
- What the dispatching agent receives, and when, relative to the hook.
- Whether a message sent to a subagent while its stop hook runs is dropped.

## Decisions

- **Run the round from a `PreToolUse` hook on `SubagentHandback` as well as from
  `SubagentStop`.** In auto mode a subagent ends by calling `SubagentHandback`,
  and its run is over once the call goes through. A `SubagentStop` block after
  that is dropped: the hook fires once, its exit 2 or JSON block is ignored,
  and the subagent is marked completed. A `PreToolUse` hook that exits 2 on the
  hand-back refuses the call. The subagent gets the hook's stderr as the call's
  result, acts on it, and hands back again. That is the loop § 3 describes, one
  event earlier.

- **Keep the `SubagentStop` registration.** Outside auto mode the subagent has
  no hand-back. It ends with a message, and a `SubagentStop` exit 2 resumes it
  exactly as before, foreground or background, in a worktree or not.

- **Run no round at a `SubagentStop` whose subagent handed back.** The round
  that could reach it ran at the hand-back, and a second one would post
  findings that no agent is told about. The payload does not say how the run
  ended. The subagent's transcript does: its last assistant entry is the
  `SubagentHandback` call.

- **Neither the JSON form nor the dispatch shape is a fix.** Both forms are
  dropped after a hand-back, for foreground and background subagents, with or
  without a worktree. Both forms work where there is no hand-back.

- **The hand-back cannot be switched off from outside.** Setting
  `CLAUDE_CODE_SENDMESSAGE_HANDBACK` to `false` or to `0` in the session's
  environment left the hand-back in place.

- **Read a second completion notification before calling a message ignored.**
  A message sent while the stop hook runs is delivered once the hook ends, by
  starting the subagent again. It is not a way to resume a subagent inside its
  turn, and squiz does not rely on it.

## Needs your input

- **Whether to close #278 on this change alone.** Every row below used a probe
  hook, not squiz. No squiz round has yet refused a real hand-back on a real
  pull request. Recommended: merge, and close #278 on the first dogfooded
  subagent whose transcript shows it working a blocking reason.

## Reference

### Each case

Every run was a nested `claude -p` session dispatching one `general-purpose`
subagent to write `apple.txt`. The probe blocked once per `agent_id`, asking for
`banana.txt`, and exited 0 after that. "Resumed" means `banana.txt` exists.

| Permission mode | Dispatch | Block | Resumed | Hook fired again | `stop_hook_active` on the second firing |
|---|---|---|---|---|---|
| `bypassPermissions`, sonnet | foreground | `SubagentStop` exit 2 | yes | yes | `true` |
| `bypassPermissions`, sonnet | background | `SubagentStop` exit 2 | yes | yes | `true` |
| `bypassPermissions`, opus | foreground | `SubagentStop` exit 2 | yes | yes | `true` |
| `bypassPermissions`, opus | background | `SubagentStop` exit 2 | yes | yes | `true` |
| `bypassPermissions`, opus | background, worktree | `SubagentStop` exit 2 | yes | yes | `true` |
| `acceptEdits`, opus | background | `SubagentStop` exit 2 | yes | yes | `true` |
| `auto`, opus | foreground | `SubagentStop` exit 2 | no | no | — |
| `auto`, opus | background | `SubagentStop` exit 2 | no | no | — |
| `auto`, opus | foreground | `SubagentStop` JSON | no | no | — |
| `auto`, opus | background | `SubagentStop` JSON | no | no | — |
| `auto`, opus | background, worktree | `SubagentStop` exit 2 | no | no | — |
| `auto`, opus | background | `PreToolUse` exit 2 on `SubagentHandback` | yes | yes, then `SubagentStop` once | — |
| `auto`, opus | background | `PreToolUse` JSON deny on `SubagentHandback` | yes | yes, then `SubagentStop` once | — |
| `auto`, opus | foreground, worktree | `PreToolUse` exit 2 on `SubagentHandback` | yes | yes, then `SubagentStop` once | — |
| `auto`, opus | background, worktree | `PreToolUse` exit 2 after 100 s | yes | yes, then `SubagentStop` once | — |

Every `auto` subagent ended through `SubagentHandback`; none outside `auto` did.

### What the subagent receives

A refused hand-back comes back as the call's result, prefixed by the runtime:

```
PreToolUse:SubagentHandback hook error: [<hook command>]: <the hook's stderr>
```

The JSON form, `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}`,
arrives without the bracketed command:

```
PreToolUse:SubagentHandback hook error: <the reason>
```

### What the dispatching agent receives

- **After a hand-back**, the report arrives as a message from the subagent as
  soon as the call goes through, before `SubagentStop` fires. The completion
  notification follows the `SubagentStop` hook's end. In the probe that was
  0.06 seconds; in the session that filed #278 it was the length of a squiz
  round, about six minutes.
- **After a refused hand-back**, the dispatching agent receives only the
  hand-back that went through. The refused one never reaches it.
- **Without a hand-back**, the dispatching agent receives the subagent's last
  message, after the last `SubagentStop` firing.

### A message sent while the hook runs

A `SendMessage` to a background subagent whose `SubagentStop` hook was still
running answered:

```
{"success":true,"message":"Message queued for delivery to <agent-id> at its next tool round.", …}
```

It was not dropped, with or without a hand-back. When the hook ended, the
subagent was marked completed and, within 0.05 seconds, started again with the
message as its prompt. It acted on the message and stopped again, and
`SubagentStop` fired a second time with the same `agent_id` and
`stop_hook_active` `false`. The dispatching agent receives two completion
notifications, and one that reports on the first before the second arrives
reads the message as ignored.

### The two payloads

The `SubagentStop` payload after a hand-back carries no `last_assistant_message`
key at all. It carries `agent_transcript_path`, `stop_hook_active`, and the rest
as before.

The `PreToolUse` payload for the hand-back carries `agent_id`, `agent_type`,
`cwd`, `tool_name` (`SubagentHandback`), `tool_input.message` (the report),
`tool_use_id`, `transcript_path` (the parent's), `permission_mode`, `effort`,
`prompt_id`, `session_id` and `hook_event_name`. It carries no
`agent_transcript_path` and no `stop_hook_active`. `agent_id` is the same string
the `SubagentStop` firing for that subagent carries.

In a worktree, both the payload's `cwd` and the hook process's working directory
are the subagent's worktree, for both events.

### The timeout

A `PreToolUse` hook that reaches its declared `timeout` is cancelled and the
hand-back goes through, as if the hook had exited 0. A probe that slept 120
seconds under a 120-second timeout let the hand-back through, and the subagent
did not resume.

## Limits

- **No squiz round ran.** The probe stood in for the round. Whether a real
  blocking reason, which ends "then finish", is read as "hand back again" was
  not measured. The probe's reason said "then hand back again".
- **The runtime's own stall threshold was not reached.** The longest refusal
  waited 100 seconds. § 2 records a 600-second stall that cancels a
  `SubagentStop` hook; whether it applies to a `PreToolUse` hook in the same way
  is not established.
- **Only `general-purpose` subagents, and only `-p` sessions.** An interactive
  session was not tried.
- **One run per row.** Nothing here is a rate.
- **What turns the hand-back on was read from the binary, not observed.** It is
  used in `auto` mode and nowhere else here; whether a flag can turn it off was
  only tried through the one environment variable above.
