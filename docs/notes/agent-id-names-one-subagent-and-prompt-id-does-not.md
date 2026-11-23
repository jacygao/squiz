---
settles: "§ 3: which `SubagentStop` payload field names the subagent that did the work, in the owner the hook records"
issue: 13
recorded: 2026-09-06
versions: { claude-code: 2.1.261, node: 24.15.0 }
recheck-when: Claude Code changes the SubagentStop payload
---

# `agent_id` names one subagent, and `prompt_id` does not

## Intent

- Which field of Claude Code's `SubagentStop` payload names the subagent that
  did the work, stably across its stops and distinctly from every other
  subagent.

## Decisions

- **Name the subagent that did the work by `agent_id`.** It was the same on all
  six stops of one subagent, and different for each of five subagents across
  four sessions, two of them concurrent in one session. The `SubagentStop` hook
  records it in the owner, beside the parent's `session_id`. The episode is
  keyed on the pull request, so the id decides nothing about where state lives.
- **Never use `prompt_id` for a subagent.** It belongs to the user turn in the
  parent session: two concurrent subagents shared one, and it changed between
  one subagent's second and third stop. It would both merge two subagents and
  split one.
- **Read the id as an opaque string, never as a path component.** Claude Code's
  ids matched `^a[0-9a-f]{16}$`, and Copilot's `agent_id` is a UUID.
- **Require the id to be unique only within its parent's session.** The owner
  already names the session.

## Needs your input

Nothing.

## Reference

### The payload

Every field, in the order Claude Code emits it, the same in all sixteen firings
recorded:

| Field | Type | |
|---|---|---|
| `session_id` | string | UUID of the session that dispatched the subagent, shared by every subagent in it |
| `transcript_path` | string | `…/<session_id>.jsonl`, the parent session's transcript |
| `cwd` | string | The subagent's working directory, where the dispatcher's shell stood when it dispatched the subagent, as `a-subagents-hook-runs-where-it-was-dispatched.md` records |
| `prompt_id` | string | UUID of the user turn in the parent session |
| `permission_mode` | string | `acceptEdits` in every firing here |
| `agent_id` | string | The subagent's id |
| `agent_type` | string | `general-purpose` in every firing here. What a `matcher` in the registration would narrow on |
| `effort` | object | `{"level": "xhigh"}` |
| `hook_event_name` | string | `SubagentStop` |
| `stop_hook_active` | boolean | `false` on a subagent's first stop, `true` on every stop after |
| `agent_transcript_path` | string | `…/<session_id>/subagents/agent-<agent_id>.jsonl`, the subagent's own transcript |
| `last_assistant_message` | string | The subagent's final text |
| `background_tasks` | array of objects | Every live subagent in the session, with keys `id`, `type`, `status`, `description`, `agent_type`, all strings |
| `session_crons` | array | Empty in every firing, so its element type is (unverified) |

One record, from the first stop of two concurrent subagents:

```json
{
  "session_id": "60517e1f-e1dc-49b1-8e39-6fcbe686f3fb",
  "transcript_path": "/Users/…/60517e1f-e1dc-49b1-8e39-6fcbe686f3fb.jsonl",
  "cwd": "/private/tmp/…/wd-a",
  "prompt_id": "59893e32-bf05-4243-8b68-062d0f8767ef",
  "permission_mode": "acceptEdits",
  "agent_id": "a1e3196c5ad0f2410",
  "agent_type": "general-purpose",
  "effort": { "level": "xhigh" },
  "hook_event_name": "SubagentStop",
  "stop_hook_active": false,
  "agent_transcript_path": "/Users/…/60517e1f-e1dc-49b1-8e39-6fcbe686f3fb/subagents/agent-a1e3196c5ad0f2410.jsonl",
  "last_assistant_message": "File alpha.txt created successfully …",
  "background_tasks": [
    { "id": "a1e3196c5ad0f2410", "type": "subagent", "status": "running",
      "description": "Alpha worker creates alpha.txt", "agent_type": "general-purpose" },
    { "id": "ad5b06227fb235983", "type": "subagent", "status": "running",
      "description": "Bravo worker creates bravo.txt", "agent_type": "general-purpose" }
  ],
  "session_crons": []
}
```

Two subagents dispatched from one directory share `session_id`, `prompt_id` and
`cwd`. Only `agent_id` and `agent_transcript_path` tell them apart.
`background_tasks` lists the other live subagents, and drops one once it has
stopped for the last time.

## Limits

- **What generates the id, and whether it is unique beyond one session, is
  unknown.** Two sessions started in the same second with identical prompts got
  different ids, so it is neither derived from the prompt nor a per-session
  counter.
- **The six stops of one subagent came from a `SubagentStop` hook that blocked
  it**, which squiz's hook never does. A subagent resumed with a follow-up
  message, and one whose context was compacted, were not run.
- **Only `-p`, only `general-purpose`, only `claude-sonnet-5`.**
- **`background_tasks` only ever showed `status` as `running`.**
