---
settles: "§ 3 — which prompt the hook records as the run's; § 4 — where the local venue's description comes from in a subagent's worktree"
issue: 870
recorded: 2026-11-22
versions: { claude-code: 2.1.321, copilot: 1.0.110 }
recheck-when: Claude Code starts firing UserPromptSubmit for a subagent, or Copilot stops firing it for one
---

# A Claude Code subagent fires no `UserPromptSubmit`, and a Copilot one fires it in its parent's directory

## Intent

- Whether a subagent's brief reaches `squiz hook` as a `UserPromptSubmit`, under
  each runtime.
- Where it fires, if it does.

## Decisions

- **Expect no recorded prompt in a Claude Code subagent's own worktree.** Claude
  Code 2.1.321 fires `UserPromptSubmit` for the session's prompt and none for a
  subagent, so a subagent dispatched into a worktree of its own leaves that
  worktree's change with no description. Its dispatcher writes
  `.squiz/local/description.md` where the change needs one.
- **Record nothing for a Copilot `UserPromptSubmit` that carries `agent_id`.**
  Copilot 1.0.110 fires one for the brief a session hands its subagent, in the
  parent's `cwd`, after the parent's own. Recording it would replace the run's
  prompt with the brief.

## Needs your input

Nothing.

## Reference

The payloads are pinned in `src/sessions/prompt-payloads.ts`. The Copilot
subagent's, shortened:

```json
{"hook_event_name":"UserPromptSubmit","session_id":"<subagent id>","cwd":"<the parent's directory>","agent_id":"<subagent id>","agent_type":"explore","parent_agent_id":"<parent id>","prompt":"<the brief>"}
```

A Claude Code session's own carries `session_id`, `transcript_path`, `cwd`,
`prompt_id`, `permission_mode`, `hook_event_name` and `prompt`, and no
`agent_id`.

## Limits

- **Whether the Claude Code subagent was isolated is not recorded.** The fixture
  comment says 2.1.321 fires none for a subagent. The specification at
  `1681b1f` says one dispatched into a worktree of its own fires none there.
  Both agree on the isolated case; the unisolated one rests on the fixture
  alone.
- **How many runs stand behind each fixture is not recorded.** A resumed
  subagent, and one continued with `SendMessage`, are not among them.
