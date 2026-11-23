---
settles: "§ 3: what Claude Code's and Copilot's SessionStart and SubagentStart hand `squiz hook`; § 4: where the local venue's base.json is written at a start, and what a resume does to it"
issue: 821
recorded: 2026-11-07
versions: { claude-code: 2.1.319, copilot: 1.0.107, squiz: fa88578, node: 24.15.0, macos: 26.6.2 }
recheck-when: Claude Code or Copilot CLI changes a start hook's payload, when it fires a start hook, or where it puts an isolated subagent
---

# Both runtimes' start hooks write the base where the work starts

## Intent

- Whether Claude Code's `SessionStart`, on startup and on resume, and its
  `SubagentStart` for a subagent dispatched with `isolation: "worktree"` reach
  `squiz hook` with an event and an absolute `cwd`, the subagent's in its own
  worktree before it does any work.
- Whether Copilot's plugin `SessionStart` and `SubagentStart` reach it the same
  way.
- Whether, under the local venue, each writes `.squiz/local/base.json`, and a
  resumed session leaves it as it was.

## Decisions

- **Read a start from `hook_event_name`, and a Copilot subagent's start from
  `agentName`, `sessionId` and an absolute `cwd`.** Every start payload but one
  named its event. Copilot's `SubagentStart` names none, and squiz read it as a
  start from those three fields.
- **Take the start's worktree from the payload's `cwd`.** Under Claude Code the
  isolated subagent's `cwd` was its own `.claude/worktrees/agent-<id>`, and
  squiz wrote a `base.json` there, separate from the main tree's, before the
  subagent's first tool call. Under Copilot the hook ran in the plugin root, and
  `cwd` was the session's directory.
- **Keep an existing `base.json` on every later start.** A resume after a
  commit, under each runtime, and a Copilot subagent in its parent's directory
  each left the record byte for byte as it was.

## Needs your input

Nothing.

## Reference

### The payloads

Claude Code `SessionStart`, on startup and on resume:

```json
{"session_id":"<id>","transcript_path":"~/.claude/projects/<dir>/<id>.jsonl","cwd":"<repo>","hook_event_name":"SessionStart","source":"startup"}
{"session_id":"<id>","transcript_path":"…","cwd":"<repo>","hook_event_name":"SessionStart","source":"resume","seconds_since_last_response":27,"context_tokens":24363,"prompt_cache_likely_expired":false,"estimated_cache_write_usd":0.1949}
```

Claude Code `SubagentStart`, isolated:

```json
{"session_id":"<parent id>","transcript_path":"<the parent's transcript>","cwd":"<repo>/.claude/worktrees/agent-a62934569ce9d2e36","prompt_id":"<id>","agent_id":"a62934569ce9d2e36","agent_type":"general-purpose","hook_event_name":"SubagentStart"}
```

Copilot `SessionStart`, new and resumed:

```json
{"hook_event_name":"SessionStart","session_id":"<id>","timestamp":"2026-11-07T12:47:34.373Z","cwd":"<repo>","source":"new","initial_prompt":"<the prompt>"}
{"hook_event_name":"SessionStart","session_id":"<id>","timestamp":"…","cwd":"<repo>","source":"resume","initial_prompt":"<the resuming prompt>"}
```

Copilot `SubagentStart`. It has no `hook_event_name` and no `session_id`, and
its `timestamp` is epoch milliseconds where `SessionStart`'s is an ISO string:

```json
{"sessionId":"<parent id>","timestamp":1794055659423,"cwd":"<repo>","transcriptPath":"~/.copilot/session-state/<parent id>/events.jsonl","agentName":"general-purpose","agent_id":"<uuid>","agent_type":"general-purpose","parent_agent_id":"<parent id>"}
```

The hook's environment had `CLAUDE_PLUGIN_ROOT` under both runtimes, and
`COPILOT_CLI=1` under Copilot.

Replayed into `squiz hook` with `agentName` removed, Copilot's `SubagentStart`
wrote no base and printed:

```
squiz: nothing was queued: the payload's "hook_event_name" is not Stop, SubagentStop, SessionStart or SubagentStart
```

### What was written

With `main`, `extra`, `origin/main` and `origin/HEAD` all at `HEAD`:

```json
{ "commit": "5353330716ee0e78657c7dddbc2eadb0ef82eddd",
  "branches": ["refs/heads/extra", "refs/heads/main", "refs/remotes/origin/main"] }
```

- **`origin/HEAD` is left out.** It is a symbolic ref, not a branch.
- **An isolated Claude Code subagent's record also lists its own branch,
  `refs/heads/worktree-agent-<id>`**, which Claude Code creates at the start
  commit. § 4 The base drops the checked-out branch when the base is read.

**Claude Code removes an isolated worktree its subagent left unchanged**, and
`.squiz/local/base.json` does not count as a change. A subagent that changes
nothing leaves no worktree, and no record, to inspect afterwards.

## Limits

- **Headless runs only.** An interactive session of either runtime was not run.
- **That the hook wrote nothing on stderr** is known only from a stand-in plugin.
  Claude Code's debug log records a hook's exit status and not its stderr, and
  Copilot's `events.jsonl` records only `success`.
- **A Claude Code subagent without isolation was not dispatched.**
- **Claude Code's other `SessionStart` sources**, `clear`, `compact` and
  `fork`, were not fired.
- **Copilot started with `--worktree`, or resumed in another directory**, was not
  tried.
- **What a round queued by an isolated subagent's `SubagentStop` does once
  Claude Code removes the unchanged worktree** was not established. The
  `SubagentStop` fired 160 ms before the removal, and the worktree's
  `.squiz/local/` went with it.
