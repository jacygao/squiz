---
settles: "§ 3 The report: how a Copilot owner with no socket learns a review's result while idle"
issue: 556
recorded: 2026-10-06
versions: { copilot: 1.0.92, model: gpt-6-astra, effort: high, node: 24.15.0, macos: 26.6.2 }
recheck-when: Copilot CLI upgrades past 1.0.92, or changes its bash tool's `mode`, `initial_wait` or `detach`, or its `system.notification` events
---

# Copilot wakes an idle session when a background command it started ends

## Intent

- Whether Copilot starts a turn in an idle session when a background shell
  command it started finishes, for `sleep` and for a real `squiz review`, and
  what the new turn receives.
- Whether a background subagent that runs `squiz review` wakes its idle parent,
  and what the parent receives.

## Decisions

- **Count Copilot's own background-shell notification as the wake for an owner
  with no socket.** The session runs `squiz review <number>` with
  `"mode": "async"` and ends its turn. No model call was made until the command
  exited, and Copilot started the next turn within 1.5 seconds of the exit,
  after up to 7 minutes idle. The wake belongs to the session that ran the
  command, so no other process can send it, and a round queued by a `Stop` hook
  with no command waiting on it reaches the session only through the plugin's
  extension.
- **Expect the woken turn to carry the command's output and exit code, with
  nothing for the agent to fetch.** Copilot adds a `read_bash` result to the turn
  before the model runs. That is the review's result only where the command
  ended on one: a run whose deadline comes first exits 4 while the round goes
  on, and the agent runs `squiz review` in `async` mode again.
- **Run it attached, not with `detach: true`.** A detached command woke the
  session the same way, but it runs under `setsid` and outlives the CLI, and the
  bash tool's own description reserves `detach` for a process the user wants to
  survive the session. The round runs in the round host either way.
- **Do not run `squiz review` in a background subagent to get the wake.** The
  parent woke when a `task` subagent's `squiz review` ended, but it received the
  subagent's summary of the output rather than the output, and the subagent
  cost a turn of its own.

## Needs your input

Nothing.

## Reference

### The bash tool's modes

The model chooses them per call. The tool's description says:

- `"mode": "sync"` with `initial_wait` (default 30 seconds): a command still
  running when the wait ends moves to the background, and the result reads `You
  will be automatically notified when it completes`.
- `"mode": "async"`: returns at once with `<command started in background with
  shellId: 0>`. "You will be automatically notified when async commands
  complete - no need to poll."
- `"mode": "async", "detach": true`: returns `<command started in detached
  background with shellId: 0>`. Its wake reads `Detached shell "<description>"
  (shellId: 0) has completed.`, and its output ends `<detached command with
  shellId: 0 completed with exit code 0>`.

### The woken turn

For `squiz review 14`, which exited 0, the turn opened with:

```
<system_notification>
Shell command "Start squiz review 14" (shellId: 0) has completed successfully.
</system_notification>
```

then the command's stdout, ending `<shellId: 0 completed with exit code 0>`. A
command that exited 3 gave `has exited with exit code 3.` in the notification,
and the same code in the closing line. A subagent's wake reads `Agent "<name>"
(task) has finished processing and is now idle.`

While it waits, the footer reads `Waiting for background shells`, or
`Waiting for background agents` for a subagent. That is Copilot's list of
running tasks, not a running turn: the events show the turn ended before it. A
detached command leaves `1 background /tasks`.

### The events

In `<COPILOT_HOME>/session-state/<session id>/events.jsonl` a wake is
`assistant.turn_end`, then nothing, then:

- `system.notification`, whose `data.kind` is `{"type":"shell_completed",
  "shellId":"0","exitCode":0,"description":"…"}`. The `type` is
  `shell_detached_completed` for a detached command, with no `exitCode`, and
  `agent_idle` for a subagent, with `agentId`, `agentType` and `displayName`;
- a `read_bash` or `read_agent` call and its result, in the same millisecond, with
  no model call before them;
- `assistant.turn_start`.

Each wake also fires `userPromptSubmitted` with the notification as its
`prompt`, then `notification`, then `agentStop` when the woken turn ends.

## Limits

- **One run per case**, on macOS, in a session nobody typed into, with
  `--allow-all`, `COPILOT_ALLOW_ALL=true`, and squiz's plugin not loaded.
- **Only exit 0 was seen from `squiz review`.** Exit 3 was seen from a plain
  command. Each review ran about 20 seconds.
- **The longest idle stretch was 7 minutes.** A longer review, a session idle
  for hours, and a machine that sleeps meanwhile were not tried.
- **Not tried:** a command that ends while a turn is running, two background
  reviews at once, a model other than `gpt-6-astra`, `-p` mode, and whether a
  session picks `async` mode by itself.
