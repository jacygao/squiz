---
settles: "§ 3 — whether the hook payload carries a subagent id stable enough to key an episode on"
issue: 13
recorded: 2026-09-06
versions: { claude-code: 2.1.261, node: 24.15.0 }
recheck-when: Claude Code changes the SubagentStop payload
---

# An episode keys on `agent_id`

`agent_id` holds. It was the same on all six stops of one subagent that was
blocked, resumed, worked and stopped again five times over, and it differed
between every subagent seen. Five subagents across four sessions — two of them
concurrent in one session, two more in two sessions running at the same time,
and one on its own — produced five distinct ids, none of which repeated the id
recorded by the earlier run in
`subagent-stop-blocks-and-the-subagent-resumes.md`. § 3 is right as written, and
nothing in `docs/specs/` needs amending.

The obvious-looking second choice is wrong. `prompt_id` is shared by every
subagent in a session and it changed while one subagent's episode was still
running, so it would have both merged two episodes and split one.

## Decisions

- **The episode key is `agent_id`, exactly as § 3 says.** No fallback is needed,
  so the worktree toplevel, the branch and the pull request number stay
  unused for this purpose.
- **Never key on `prompt_id`.** It is per user turn in the parent session, not
  per subagent. In the two-subagent run it was the same string for both agents,
  and it changed between one agent's second and third stop.
- **M1 sanitises the id before it becomes a path component.** § 3 puts episode
  state in `.squiz/<episode>/`, which makes a payload field into a directory
  name. Every id observed matched `^a[0-9a-f]{16}$`, but the harness reads the
  id from a payload rather than generating it, so it strips the string down to
  that character set rather than trusting it.
- **Cross-session uniqueness is not required by the design, whatever the
  runtime guarantees.** § 3 gives each episode its own worktree and puts the
  state file inside it, so two ids only collide destructively if two episodes
  share a worktree. § 3 already treats a shared tree as its own case.

## Needs your input

Nothing.

## Reference

### The payload, in full

Every field, in the order the runtime emits it, identical in shape across all
sixteen invocations recorded.

| Field | Type | |
|---|---|---|
| `session_id` | string | UUID of the session that dispatched the subagent. Shared by every subagent in that session |
| `transcript_path` | string | `…/<session_id>.jsonl` — the parent session's transcript |
| `cwd` | string | The session's working directory, not the subagent's |
| `prompt_id` | string | UUID of the user turn in the parent session. Not per subagent, and not stable across an episode |
| `permission_mode` | string | `acceptEdits` in every run here |
| `agent_id` | string | The subagent's id. The episode key |
| `agent_type` | string | `general-purpose` in every run here. What a `matcher` in the registration would narrow on |
| `effort` | object | `{"level": "xhigh"}`. One key, `level`, a string |
| `hook_event_name` | string | `SubagentStop` |
| `stop_hook_active` | boolean | `false` on a subagent's first stop, `true` on every stop after |
| `agent_transcript_path` | string | `…/<session_id>/subagents/agent-<agent_id>.jsonl` — the subagent's own transcript |
| `last_assistant_message` | string | The subagent's final text, so nothing needs to read the transcript to get it |
| `background_tasks` | array of objects | Every live subagent in the session. Keys `id`, `type`, `status`, `description`, `agent_type`, all strings |
| `session_crons` | array | Empty in every invocation, so its element type is *(unverified)* |

One record verbatim, from the first stop of two concurrent subagents:

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

### What the id looks like, and what it is scoped to

Seventeen characters, matching `^a[0-9a-f]{16}$` in all sixteen invocations:
`a1e3196c5ad0f2410`, `ad5b06227fb235983`, `a1c126da8a6a782f2`,
`a52d5fd4b5ef193bc`, `a342aeb88c6a6a49c`, and `a6f2258998dc7a2dd` from the
earlier run recorded in `subagent-stop-blocks-and-the-subagent-resumes.md`.

**What generates the id could not be determined**, and neither could whether the
runtime guarantees it is unique beyond one session. Two things bear on it and
neither settles it. Against a session-scoped id: two sessions launched at the
same second, with byte-identical prompts, produced different ids, so it is
neither derived from the prompt nor drawn from a counter that restarts per
session. For a session-scoped id: `agent_transcript_path` nests the id inside a
directory named for the session, so the on-disk layout only needs the id to be
unique within one session.

### Two subagents in one session share everything except the id

In the concurrent run both subagents reported the same `session_id`, the same
`prompt_id`, and the same `cwd`. Only `agent_id` and `agent_transcript_path`
told them apart. Anything separating two live episodes has to come from one of
those two fields.

`background_tasks` carries the ids of the other live subagents in the session,
which is a second route to noticing that more than one episode is in flight. It
listed both ids while both were running and dropped the finished one once it
had stopped for the last time.

### Proving an id is stable rather than assuming it

An id that collides and an id that is stable look identical if a run has only
one subagent in it, and grouping a log by `agent_id` cannot detect a collision
because the collision is what the grouping assumes away. The two subagents were
each told to end every message, including every message after being told to keep
working, with a fixed line of its own — `AGENT-ALPHA` or `AGENT-BRAVO`.
`last_assistant_message` then carries an identity the hook did not supply, and
the mapping from that line to `agent_id` was one-to-one across all six stops.

## Limits

- **Six rounds, and § 3 lets the round cap go to 8.** One subagent was blocked
  five times and stopped six, all with one id. Rounds 7 and 8 were not run.
- **Only `-p`, only `general-purpose`, only `claude-sonnet-5`.** No interactive
  session, no other subagent type, and no other model.
- **A subagent that is resumed rather than dispatched afresh.** Every subagent
  here was dispatched once and ran to the end. Whether a follow-up message to an
  existing subagent keeps its id was not tested; § 3 starts a new episode for
  work that arrives later, so nothing currently depends on the answer.
- **Context compaction mid-episode.** No subagent here ran long enough to
  compact, so whether the id survives one is unknown.
- **`session_crons`** was `[]` in every invocation, and `background_tasks` only
  ever showed `status` as `running`. The other statuses a background task can
  hold were not seen.
