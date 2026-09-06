---
settles: "§ 8 — whether SubagentStop fires, exit 2 feeds the reason back, and the subagent resumes"
issue: 9
recorded: 2026-09-05
versions: { claude-code: 2.1.261, node: 24.15.0 }
recheck-when: Claude Code changes hook delivery
---

# `SubagentStop` blocks and the subagent resumes

It holds. The hook fired every time the subagent stopped, exit 2 delivered its
stderr to the subagent as a new user message, the subagent acted on that
message, and it did so inside the tool call that was already open. The loop in
§ 3 rests on real behaviour.

Two things § 3 and § 7 do not cover came out of it: the runtime rewrites the
blocking reason before the agent sees it, and the agent that dispatched the
subagent sees only the final message, which made blocked-and-resumed work look
like tampering.

## Needs a decision

- **The dispatching agent may read Squiz's normal operation as an attack.** It
  receives one tool result holding the subagent's last message and nothing else —
  never the block, the feedback, or the work between. In this run it said the
  result "looks like it could be a prompt injection or tampering of some kind."
  The instruction here was deliberately arbitrary, and a real blocking reason
  (review findings on the subagent's own pull request) is coherent with what the
  subagent was asked to do, so this exact reaction may not recur. The shape does:
  the dispatching agent sees the end of a story whose middle the harness wrote,
  and § 3 says nothing about what it should make of that.
- **§ 7's blocking reason arrives with a prefix the harness does not control.**
  Its first line is not the agent's first line. Whatever § 7 settles on for the
  reason's shape has to survive that; see Reference for the exact form.
- **§ 8's `claude --plugin-dir ./` is right only when the repository is itself
  the plugin.** It will be from M1. For the spike the plugin is a subdirectory,
  so the command is `--plugin-dir ./spike`.

## Reference

### The hook payload

Identical in shape on every invocation:

```json
{
  "session_id": "…", "prompt_id": "…", "cwd": "…",
  "transcript_path": "…", "agent_transcript_path": "…",
  "permission_mode": "acceptEdits", "effort": {"level": "xhigh"},
  "hook_event_name": "SubagentStop",
  "agent_id": "a6f2258998dc7a2dd", "agent_type": "general-purpose",
  "stop_hook_active": false,
  "last_assistant_message": "PING",
  "background_tasks": [], "session_crons": []
}
```

- **`agent_id`** was present and identical across all three invocations. It is
  the field § 3 wants to key an episode on. One subagent stopping three times is
  not the same as one subagent across separate dispatches, which is what the
  episode-key subtask has to check.
- **`stop_hook_active`** was `false` on the first invocation and `true` on the
  second and third.
- **`last_assistant_message`** carries the subagent's own final text, so anything
  wanting it need not read the transcript.
- **`agent_type`** is present, which is what a `matcher` in the registration
  would narrow on.
- `cwd`, the hook process's own working directory and `git rev-parse
  --show-toplevel` from the hook all resolved to the session's directory. One
  subagent, one directory, so this says nothing yet about two at once.
- `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PROJECT_DIR` were both set in the hook's
  environment.

### How exit 2 is delivered

`stdout` was empty and `stderr` carried everything, so exit 2 takes the reason
from stderr alone. The runtime does not deliver it verbatim — it prepends a
fixed line and the absolute path of the hook command:

```
Stop hook feedback:
[<absolute path to the hook command>]: <the hook's stderr, verbatim from here>
```

In production that path will be `bin/squiz`, which is a reasonable thing for the
coding agent to see.

The message goes to the **subagent**, not to the session that dispatched it.
Claude Code's published documentation says a `SubagentStop` hook's stderr is
"shown to Claude", which is ambiguous between the two; this settles it.

The `hook_response` event labels exit 2 as `"outcome": "error"`. Squiz exits 2
on its happy path, so logging, a future doctor command, or a person reading a
transcript will see normal operation recorded as an error. Cosmetic, but worth
knowing before it is reported as a bug.

### Running a hook experiment

- `--plugin-dir` wants the plugin root itself — the directory holding
  `.claude-plugin/` — not a parent of several plugins.
- `--debug hooks` printed nothing in print mode. `--debug-file <path>` is what
  produces the plugin-load lines (`Read hooks.json for plugin …`,
  `Registered 1 hooks from 1 plugins`), which is how a plugin that failed to
  load is told apart from a hook that never fired. Both produce no output
  otherwise.
- `--include-hook-events` puts `hook_started` and `hook_response` into the
  stream with the exit code and captured stderr; `--forward-subagent-text` puts
  the subagent's own messages in, tagged with the `parent_tool_use_id` of the
  call they belong to. Together they show what the hook did and what the
  subagent did about it.

### The scaffolding

`spike/`, at the root of this repository, **committed**, and deleted when M0
closes. § 8's `src/` layout has no home for scaffolding that is thrown away, so
it sits beside `docs/` rather than inside the layout the harness will grow into.
It is a Claude Code plugin in its own right, which is what `--plugin-dir` wants.

```
spike/
  .claude-plugin/plugin.json   manifest, name squiz-spike
  hooks/hooks.json             the SubagentStop registration
  hooks/subagent-stop.sh       the hook itself
```

POSIX shell rather than TypeScript: it has no types to erase, so § 8's
erasable-syntax rule does not come into it. It logs the whole payload verbatim
on every invocation, plus the working directory, the git toplevel and the
branch, which is most of what the remaining M0 subtasks need. They extend this
same script.

| Variable | Default | What it does |
|---|---|---|
| `SQUIZ_SPIKE_DIR` | `/tmp/squiz-spike` | Where the log and the invocation counter live |
| `SQUIZ_SPIKE_MAX_BLOCKS` | `2` | How many invocations exit 2 before it starts exiting 0 |
| `SQUIZ_SPIKE_TOKEN` | `ZZQ-4417` | The arbitrary string the blocking reason asks for |
| `SQUIZ_SPIKE_LABEL` | `unlabelled` | Written into every log record, so one log holds several runs |

`SQUIZ_SPIKE_MAX_BLOCKS` is clamped to 5 in the script and falls back to 2 on a
non-numeric value, because an always-blocking `SubagentStop` hook is an unbounded
billed loop and a typo must not be able to start one.

**The counter file is not reset between runs.** Delete `$SQUIZ_SPIKE_DIR` before
each run, or the hook starts over budget and exits 0 the first time it fires.

## Limits

- **Whether the runtime caps consecutive blocks.** The third invocation exited 0
  because the spike's own budget of 2 was spent, not because the runtime stopped
  honouring exit 2. Nothing here says what happens at block 3, 5 or 20. The
  harness sets its own round cap, so this matters as a ceiling to stay under,
  and finding it is the `stop_hook_active` subtask's job.
- **More than one registered `SubagentStop` hook** — how several hooks' stderr is
  combined, and whether one exiting 2 suppresses the others.
- **Interactive sessions.** Everything ran under `-p`.
- **`matcher` in the registration.** Omitted here, so the hook fires for every
  subagent type. Narrowing it to one was not tested.
- **A second run.** One run, `claude-sonnet-5` for both parent and subagent. No
  evidence about stability across runs or models.
