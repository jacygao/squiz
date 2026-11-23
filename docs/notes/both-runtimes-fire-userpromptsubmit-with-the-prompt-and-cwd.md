---
settles: "§ 3: which `UserPromptSubmit` registration reaches `squiz hook` and which fields it reads; § 4: the prompt the local venue records"
issue: 870
recorded: 2026-11-22
versions: { claude-code: 2.1.321, copilot: 1.0.110 }
recheck-when: Claude Code or Copilot CLI changes the `UserPromptSubmit` payload, or which name it fires the event under
---

# Both runtimes fire `UserPromptSubmit` with the prompt and `cwd`

## Intent

- Whether Claude Code and Copilot fire a plugin's `UserPromptSubmit`, and under
  which names.
- Which fields carry the prompt and the directory it was given in.

## Decisions

- **Register `UserPromptSubmit` in the plugin's `hooks.json`, and no Copilot
  name beside it.** Claude Code 2.1.321 fires it under that name alone. Copilot
  1.0.110 fires it from the plugin's `hooks.json`. Copilot also fires its own
  `userPromptSubmitted` (unverified on 1.0.110), so registering that name too
  would hand the hook every prompt twice.
- **Take the prompt from `prompt` and the worktree from `cwd`.** Both runtimes
  send both fields.

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

Copilot 1.0.110:

```json
{"hook_event_name":"UserPromptSubmit","session_id":"51445ba2-…","timestamp":"2026-11-13T13:14:57.072Z","cwd":"<repo>","prompt":"Reply with the single word PONG. Requirement: keys are lowercased."}
```

Copilot's payload carries no `transcript_path`, unlike its `Stop`.

## Limits

- **Print mode only.** An interactive session of either runtime was not run.
- **Copilot's own `userPromptSubmitted` was not captured in these runs.** A
  project-registered `userPromptSubmitted` was seen firing on Copilot 1.0.92.
