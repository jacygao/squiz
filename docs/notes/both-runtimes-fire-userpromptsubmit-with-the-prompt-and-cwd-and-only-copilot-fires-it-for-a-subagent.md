---
settles: "§ 3 — which `UserPromptSubmit` firings reach `squiz hook`, what their payloads carry, and which prompt is a subagent's brief; § 4 — the prompt the local venue records"
issue: 870
recorded: 2026-11-22
versions: { claude-code: 2.1.321, copilot: 1.0.110 }
recheck-when: Claude Code or Copilot CLI changes the `UserPromptSubmit` payload, which name it fires the event under, or whether it fires the event for a subagent
---

# Both runtimes fire `UserPromptSubmit` with the prompt and `cwd`, and only Copilot fires it for a subagent

## Intent

- Whether Claude Code and Copilot fire a plugin's `UserPromptSubmit`, and under
  which names.
- Which fields carry the prompt and the directory it was given in.
- Whether a subagent's brief fires it, and how to tell that firing from the
  session's own.

## Decisions

- **Register `UserPromptSubmit` in the plugin's `hooks.json`, and nothing else.**
  Claude Code 2.1.321 fires it under that name alone. Copilot 1.0.110 fires it
  from the plugin's `hooks.json` as well as its own `userPromptSubmitted`, so
  registering the Copilot name too would hand the hook every prompt twice.
- **Take the prompt from `prompt` and the worktree from `cwd`.** Both runtimes
  send both fields.
- **Read a payload with a non-empty `agent_id` as a subagent's brief.** Copilot
  fires `UserPromptSubmit` for the prompt a session gives its subagent, after
  the parent's own, with the subagent's `agent_id` and in the parent's `cwd`. Its
  `cwd` therefore cannot tell it from the parent's prompt, and `agent_id` can.
  Claude Code 2.1.321 fires none for a subagent.

## Needs your input

Nothing.

## Reference

The payloads, from a print-mode run of each CLI loading a plugin that registers
the event. They are kept word for word in `src/sessions/prompt-payloads.ts`,
which the hook's tests replay. Paths are shortened here.

Claude Code 2.1.321:

```json
{"session_id":"dff38909-…","transcript_path":"~/.claude/projects/<dir>/dff38909-….jsonl","cwd":"<repo>","prompt_id":"ef212518-…","permission_mode":"default","hook_event_name":"UserPromptSubmit","prompt":"Reply with the single word PONG. Requirement: keys are lowercased."}
```

Copilot 1.0.110, the session's own prompt:

```json
{"hook_event_name":"UserPromptSubmit","session_id":"51445ba2-…","timestamp":"2026-11-13T13:14:57.072Z","cwd":"<repo>","prompt":"Reply with the single word PONG. Requirement: keys are lowercased."}
```

Copilot 1.0.110, the brief a session handed its subagent. `session_id` and
`agent_id` are both the subagent's, and `parent_agent_id` is the parent's:

```json
{"hook_event_name":"UserPromptSubmit","session_id":"345e010a-…","timestamp":"2026-11-13T13:16:31.451Z","cwd":"<repo>","agent_id":"345e010a-…","agent_type":"explore","parent_agent_id":"b5c788af-…","prompt":"Reply with the single word PONG."}
```

Copilot's payload carries no `transcript_path`, unlike its `Stop`.

Run end to end, each CLI recorded the prompt word for word in a fresh
local-venue repository:

```
claude -p '<prompt>' --plugin-dir <checkout> --settings '{"enabledPlugins":{"squiz@squiz":false}}'
copilot -p '<prompt>' --plugin-dir <checkout> --no-ask-user --experimental
```

## Limits

- **Print mode only.** An interactive session of either runtime was not run.
- **Which Claude Code subagents were dispatched is not recorded.** Whether the
  runs that showed no firing included one dispatched with
  `isolation: "worktree"` is unknown.
- **Copilot's own `userPromptSubmitted`** was not captured in these runs. That
  it fires beside the plugin's `UserPromptSubmit` is the specification's
  statement on `origin/spec-requirements-list` at `1681b1f`, and a
  project-registered `userPromptSubmitted` was seen firing for a subagent on
  Copilot 1.0.92, as `copilots-stop-hooks-fire-and-a-ui-server-session-can-be-woken.md`
  records.
