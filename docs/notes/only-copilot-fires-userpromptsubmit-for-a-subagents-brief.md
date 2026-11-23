---
settles: "§ 3: which `UserPromptSubmit` firing is a subagent's brief, and how the hook tells it from the session's own prompt; § 4: whether the local venue records a brief as the change's description"
issue: 870
recorded: 2026-11-22
versions: { claude-code: 2.1.321, copilot: 1.0.110 }
recheck-when: Claude Code or Copilot CLI changes whether it fires `UserPromptSubmit` for a subagent, or what that payload carries
---

# Only Copilot fires `UserPromptSubmit` for a subagent's brief

## Intent

- Whether the prompt a session hands its subagent fires `UserPromptSubmit`.
- How to tell that firing from the session's own.

## Decisions

- **Read a `UserPromptSubmit` payload with a non-empty `agent_id` as a
  subagent's brief, and record nothing from it.** Copilot 1.0.110 fires one for
  the prompt a session gives its subagent, after the parent's own, in the
  parent's `cwd`, so `cwd` cannot tell the two apart and `agent_id` can.
- **Expect no such firing under Claude Code.** Claude Code 2.1.321 fired none
  for a subagent.

## Needs your input

Nothing.

## Reference

Copilot 1.0.110, the brief a session handed its subagent, kept word for word in
`src/sessions/prompt-payloads.ts`. `session_id` and `agent_id` are both the
subagent's, and `parent_agent_id` is the parent's:

```json
{"hook_event_name":"UserPromptSubmit","session_id":"345e010a-…","timestamp":"2026-11-13T13:16:31.451Z","cwd":"<repo>","agent_id":"345e010a-…","agent_type":"explore","parent_agent_id":"b5c788af-…","prompt":"Reply with the single word PONG."}
```

The session's own prompt carries no `agent_id`, as
`both-runtimes-fire-userpromptsubmit-with-the-prompt-and-cwd.md` shows.

## Limits

- **Print mode only.** An interactive session of either runtime was not run.
- **Which Claude Code subagents were dispatched is not recorded**, so whether
  one dispatched with `isolation: "worktree"` fires none is unknown.
