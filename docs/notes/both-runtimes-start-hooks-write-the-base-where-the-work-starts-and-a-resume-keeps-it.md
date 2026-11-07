---
settles: "§ 3 — what Claude Code's and Copilot's SessionStart and SubagentStart hand `squiz hook`; § 4 — where the local venue's base.json is written at a start, and that a resume keeps it"
issue: 821
recorded: 2026-11-07
versions: { claude-code: 2.1.319, copilot: 1.0.107, squiz: fa88578, node: 24.15.0, macos: 26.6.2 }
recheck-when: Claude Code or Copilot CLI changes a start hook's payload, when it fires a start hook, or where it puts an isolated subagent
---

# Both runtimes' start hooks write the base where the work starts, and a resume keeps it

## Intent

- Whether Claude Code's `SessionStart`, on startup and on resume, and its
  `SubagentStart` for a subagent dispatched with `isolation: "worktree"` reach
  `squiz hook` with an event and an absolute `cwd`, the subagent's in its own
  worktree before it does any work.
- Whether Copilot's plugin `SessionStart` and `SubagentStart` reach it the same
  way.
- Whether, with `SQUIZ_VENUE=local`, each writes `.squiz/local/base.json`, and a
  resumed session leaves it as it was.

## Decisions

- **Keep reading a start from `hook_event_name`, and a Copilot subagent's start
  from `agentName`, `sessionId` and `cwd`.** Every start payload but one named
  its event. Copilot's `SubagentStart` named none, and squiz read it as a start
  from those three fields, writing nothing on stderr.
- **Keep taking the start's worktree from the payload's `cwd`.** Under Claude
  Code the isolated subagent's `cwd` was its own
  `.claude/worktrees/agent-<id>`, and squiz wrote a `base.json` there, separate
  from the main tree's. Under Copilot the hook ran in the plugin root, and the
  `cwd` was the session's directory.
- **Nothing in § 3 or § 4 needs changing for starts.** Each case wrote the
  record § 4 The base describes. A start hook in a directory that already had
  one left it unchanged: a Copilot subagent in its parent's directory, and a
  resume after a commit, under each runtime.

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
`COPILOT_CLI=1` under Copilot. Its working directory was the `cwd` under Claude
Code and the plugin root under Copilot.

### What was written

In each repository, `HEAD` at the start had `main`, `extra`, `origin/main` and
`origin/HEAD` pointing at it. The main tree's record:

```json
{ "commit": "5353330716ee0e78657c7dddbc2eadb0ef82eddd",
  "branches": ["refs/heads/extra", "refs/heads/main", "refs/remotes/origin/main"] }
```

- **`origin/HEAD` is left out.** It is a symbolic ref, not a branch.
- **The isolated subagent's record also lists its own branch,
  `refs/heads/worktree-agent-<id>`.** Claude Code creates the branch at the
  start commit. § 4 The base drops the checked-out branch when the base is read,
  so the list's extra entry changes nothing.
- **A resume after a commit kept the file byte for byte**, under both runtimes.
  The commit had moved `HEAD` and `main` on, so only `extra` and `origin/main`
  still pointed at the recorded commit.

### When the starts fire

- **Claude Code:** the subagent's `base.json` was written at 12:45:39Z. Its
  first tool call came at 12:45:41.6Z.
- **Copilot:** `events.jsonl` records `hook.start` and `hook.end` for each hook.
  `subagentStart` ended at 12:47:39.569Z, and the subagent's first `bash` started
  at 12:47:43.161Z.

### Reproducing it

From a clone of a bare origin, with `SQUIZ_VENUE=local`, and the released squiz
off: `.claude/settings.local.json` holding
`{ "enabledPlugins": { "squiz@squiz": false } }`, and
`copilot plugin disable squiz@squiz`.

```
claude -p --plugin-dir <plugin> --output-format json \
  --allowedTools "Agent" "Bash(pwd)" "Bash(git rev-parse:*)" "Write" -- "<dispatch one isolated subagent>"
claude -p --resume <session id> --plugin-dir <plugin> -- "<one word>"

copilot --plugin-dir <plugin> --experimental --allow-tool='task' --allow-tool='shell(pwd)' \
  --allow-tool='shell(git rev-parse:*)' --no-ask-user -p "<launch one subagent with the task tool>"
copilot --resume=<session id> --plugin-dir <plugin> --experimental --no-ask-user -p "<one word>"
```

The stderr evidence came from a stand-in plugin. Its `hooks.json` registered
`SessionStart` and `SubagentStart` only, and its script saved the payload, the
`HEAD` and refs at the payload's `cwd`, and `base.json` before and after. It then
piped the payload into main's `bin/squiz hook` and saved that hook's stderr. A
second pair of runs loaded the squiz checkout itself, and wrote the main tree's
record under both runtimes. Claude Code removed that run's subagent worktree
before it could be read, as under Traps.

Replaying the Copilot `SubagentStart` into `squiz hook` in a repository with no
base wrote one, silently. With `agentName` removed it wrote none and printed:

```
squiz: nothing was queued: the payload's "hook_event_name" is not Stop, SubagentStop, SessionStart or SubagentStart
```

### Traps

- **`--permission-mode bypassPermissions` and Copilot's `--allow-all-tools` were
  both refused** by Claude Code's auto-mode classifier, for runs started from a
  Claude Code agent. Name the tools.
- **Claude Code removes an isolated worktree its subagent left unchanged**, and
  `.squiz/local/base.json` does not count as a change. A subagent told to change
  nothing leaves no worktree, and no record, to inspect afterwards.

## Limits

- **Headless runs only.** An interactive session of either runtime was not run.
- **Claude Code's own debug log records a hook's exit status and not its
  stderr**, and Copilot's `events.jsonl` records only `success`. That stderr was
  empty is known from the stand-in plugin. The runs with squiz's own
  `hooks.json` show the records written and a 0 exit, and nothing about stderr.
- **A Claude Code subagent without isolation was not dispatched.** That its
  `SubagentStart` leaves the parent's record alone follows from `recordStart`
  keeping an existing file, which the Copilot subagent and both resumes showed.
- **Claude Code's other `SessionStart` sources**, `clear`, `compact` and
  `fork`, were not fired.
- **Copilot started with `--worktree`, or resumed in another directory**, was not
  tried.
- **What a round queued by an isolated subagent's `SubagentStop` does once
  Claude Code removes the unchanged worktree** was not established. The
  `SubagentStop` fired 160 ms before the removal, and the worktree's
  `.squiz/local/` went with it.
