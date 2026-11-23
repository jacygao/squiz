---
settles: "§ 3 The hooks: whether the plugin's Stop and SubagentStop queue a state under Copilot as under Claude Code, which payload fields name the owner, and which Copilot Stop is dropped"
issue: 499
recorded: 2026-10-06
versions: { copilot: 1.0.92, models: "gpt-5-mini (session), gpt-5.6-luna (subagents)", node: 24.15.0, macos: 26.6.2 }
recheck-when: Copilot CLI upgrades past 1.0.92, or changes its hook payloads, how it maps a plugin's Claude-format hooks, or which session an `agentStop` firing reports
---

# Copilot fires the plugin's stop hooks with Claude Code's payload

## Intent

- Whether a plugin's `Stop` and `SubagentStop` fire under Copilot.
- What `SubagentStop`'s payload carries, and whether it names the parent session.

## Decisions

- **Let the plugin's own `Stop` and `SubagentStop` registrations serve Copilot,
  and have both queue and exit 0, as under Claude Code.** Copilot loads a
  plugin's `hooks/hooks.json` as it is. Its `Stop` fired on every `agentStop` and
  its `SubagentStop` on every `subagentStop`, with Claude Code's payload shape.
  Copilot waits for a hook before it goes idle, so the hook returns as soon as it
  has queued.
- **Take the owner and the subagent from the same fields as under Claude Code.**
  On `SubagentStop`, `session_id` was the parent session's id and `agent_id` the
  subagent's own session id.
- **Resolve the pull request from the payload's `cwd`, not the hook's working
  directory.** The plugin's hook runs in the plugin root, while `cwd` is the
  session's directory.
- **Drop a Copilot `Stop` whose `session_id` is not the session its
  `transcript_path` names.** Copilot fires `Stop` for a subagent's turn too, just
  before that subagent's `SubagentStop`, with the subagent's id as `session_id`
  and the parent's `events.jsonl` as `transcript_path`. Queued, it would record
  the subagent as the owner, and nothing would be left alive to wake. Claude
  Code's `Stop` never fires for a subagent, so the rule reads only a Copilot
  transcript path.
- **Under Copilot, never record the `CLAUDE_CODE_MESSAGING_SOCKET` the
  environment holds.** Copilot puts no socket, port or token of its own in a
  hook's environment. A Copilot started from inside a Claude Code session
  passes that session's `CLAUDE_CODE_MESSAGING_SOCKET` down to its hooks, and a
  hook that recorded it would wake the Claude Code session with the Copilot
  session's result. The hook tells it runs under Copilot by `COPILOT_CLI=1`.

## Needs your input

Nothing.

## Reference

### Payloads, as logged

`Stop`, for a subagent's turn. The `session_id` is the subagent's, and the
`transcript_path` is the parent's:

```json
{"hook_event_name":"Stop","session_id":"829422d1-…",
 "timestamp":"2026-10-06T05:34:54.854Z","cwd":"…/repo",
 "transcript_path":"<COPILOT_HOME>/session-state/57444f75-…/events.jsonl",
 "stop_reason":"end_turn","stop_hook_active":false}
```

`SubagentStop`:

```json
{"hook_event_name":"SubagentStop","session_id":"57444f75-…",
 "timestamp":"2026-10-06T05:34:55.034Z","cwd":"…/repo",
 "transcript_path":"<COPILOT_HOME>/session-state/57444f75-…/events.jsonl",
 "agent_id":"829422d1-…","agent_type":"explore","agent_name":"explore",
 "last_assistant_message":"PONG","stop_reason":"end_turn"}
```

`Stop` for the session's own turn has the first shape, with the parent's id as
`session_id`.

A sync subagent in `-p` fires, in order: `Stop` with the subagent's id,
`SubagentStop`, then `Stop` with the parent's id.

### The hook's environment

`COPILOT_CLI=1`, `COPILOT_CLI_BINARY_VERSION`, `COPILOT_HOME`,
`COPILOT_PROJECT_DIR`, `CLAUDE_PROJECT_DIR`, and `CLAUDE_PLUGIN_ROOT`,
`COPILOT_PLUGIN_ROOT` and `PLUGIN_ROOT`, all the plugin root. Interactive
sessions add `COPILOT_LOADER_PID`, the pid of the `copilot` process. A session
in a Herdr pane passes on `HERDR_PANE_ID`, `HERDR_SOCKET_PATH` and the rest. A
run started with every `CLAUDE*` variable removed held no `CLAUDE_CODE_*`
variable in its hooks.

## Limits

- **The plugin registration ran once, in `-p`, with a sync subagent, on
  macOS.** A background subagent and an interactive session were run only with
  hooks registered in the project's `.github/hooks/`.
- **The scratch folder was not a git repository.**
- **Not tested:** the longest `timeoutSec` Copilot honours; a session that
  prompts for tool permissions, since every run carried `--allow-all-tools`.
