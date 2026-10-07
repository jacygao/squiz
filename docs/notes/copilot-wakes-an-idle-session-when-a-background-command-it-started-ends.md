---
settles: "§ 3 — how a Copilot coding agent learns a review's result without waiting in its turn, and that no route from outside the session starts a turn in it; § 6 — how a Copilot session should run `squiz review`; § 9 — what the instruction tells a Copilot session"
issue: 556
recorded: 2026-10-06
versions: { copilot: 1.0.92, model: gpt-6-astra, effort: high, node: 24.15.0, macos: 26.6.2, squiz-plugin: 6725452 }
recheck-when: Copilot CLI upgrades past 1.0.92, or changes its bash tool's `mode`, `initial_wait` or `detach`, its `system.notification` events, or its `notification`, `agentStop` or `subagentStop` hook outputs
---

# Copilot wakes an idle session when a background command it started ends

A Copilot session that runs `squiz review` with the bash tool in `async` mode
can end its turn and go idle. When the command exits, Copilot starts a turn in
the session by itself. The turn gets a `<system_notification>` prompt and the
command's whole output with its exit code. This is Claude Code's wake in shape:
the session started the work, and the work's end tells it. It needs no flag, no
port and no hook, and nothing outside the session can use it. A background
subagent wakes its parent the same way. No route from outside the session
started a turn in it.

## Intent

- Whether Copilot starts a turn in an idle session when a background shell
  command it started finishes, for `sleep` and for a real `squiz review`, and
  what the new turn receives.
- Whether a background subagent that runs `squiz review` wakes its idle parent,
  and what the parent receives.
- Whether `--acp`, `--remote` or `--connect` lets something outside the session
  start a turn in it while it is idle, and what each needs.
- What a stop hook can return besides `block`, and whether any of it reaches an
  idle session.
- What else in Copilot's help, documentation and changelog starts a turn.

## Decisions

- **Wake a Copilot coding agent with Copilot's own background-shell
  notification, and build no wake in squiz for it.** The session runs
  `squiz review <number>` with `"mode": "async"` and ends its turn. In every run
  the turn ended, and no model call was made until the command exited. Where
  hooks were registered, `agentStop` fired at the turn's end. Copilot started the
  next turn within 1.5 seconds of the command's exit. The longest idle
  stretch tried was 7 minutes. The wake belongs to the session that ran the
  command, so no other process can send it.
- **Expect the woken turn to carry the command's output and exit code, with
  nothing for the agent to fetch.** Copilot adds a `read_bash` result to the turn
  itself, before the model runs. That is the review's result only when the
  command ended on one. A run whose deadline comes first exits 4 while the round
  goes on, and the wake then carries only that. The agent runs `squiz review` in
  `async` mode again, and that run's exit is the next wake. For `squiz review 14`, which exited 0, the new turn held:

  ```
  <system_notification>
  Shell command "Start squiz review 14" (shellId: 0) has completed successfully.
  </system_notification>
  ```

  and then the command's stdout, ending `<shellId: 0 completed with exit code
  0>`. A command that exited 3 gave `has exited with exit code 3.` in the
  notification, and the same exit code in the closing line.
- **Run it attached, not with `detach: true`.** A detached command woke the
  session the same way, but it runs under `setsid` and outlives the CLI. The bash
  tool's own description reserves `detach` for a process the user wants to
  survive the session. The round itself runs in squiz's round host either way,
  outside Copilot's process tree.
- **Do not run `squiz review` in a background subagent to get the wake.** It
  works: the parent woke 25.6 seconds after its turn ended, when a `task`
  subagent's `squiz review 14` ended. But the parent receives the subagent's
  summary of the output, not the output, and the subagent costs a turn of its
  own.
- **Under Copilot, only a round the session started itself can wake it.** The
  wake comes from the command's exit. A round queued by the plugin's `Stop` hook
  has no command in the session to end, and Copilot gives the hook no socket, as
  `copilots-stop-hooks-fire-and-a-ui-server-session-can-be-woken.md` records.
- **Use no route from outside the session.** `--acp` and `--connect` ran their
  prompt in a second process or a second session, and the idle session never saw
  it. `--remote` takes prompts only from GitHub's web and mobile clients, signed
  in as the same account, with no documented API. `--ui-server` and typing into a
  pane were ruled out by the owner on 2026-10-06.
- **Expect no stop-hook output to wake a session.** `agentStop` ignored
  `additionalContext`. `subagentStop`'s `modifiedResponse` replaced the text the
  parent's wake turn read from the subagent, but did not start a turn. A
  `notification` hook's `additionalContext` did start a turn. But that hook fires
  only on Copilot's own notifications, so it never wakes a session that the
  notification itself would not.

## Needs your input

- **Whether the instruction tells a Copilot session to run `squiz review` in the
  background.** As the skill and the `AGENTS.md` section read now, the session
  runs the command in the foreground. In
  `copilot-runs-squiz-review-unprompted-by-the-skill-or-agents-md.md` it gave
  the call `initial_wait: 600`. A review that outlives that wait still wakes the session: Copilot moves
  the command to the background, tells the agent it will be notified, and wakes
  it when the command exits. The run with a 30-second wait and a 45-second
  command did just that. So the session gets a result either way. The only
  question is whether it stays in its turn for up to the wait first.
  Recommendation: add one sentence for Copilot to the `AGENTS.md` section and
  the skill, saying to run `squiz review` with the bash tool's `async` mode and
  end the turn, since Copilot announces when it exits. § 9 holds both texts. This
  supersedes the recommendation in
  `copilots-stop-hooks-fire-and-a-ui-server-session-can-be-woken.md` to state
  the missing wake as a gap in § 3.

  2026-10-07: the `squiz-review` skill and the `AGENTS.md` section `squiz init`
  wrote are removed (#600). The stop hook starts every review on Claude Code and
  Copilot, and the wake delivers the result, so nothing relies on an
  instruction to run `squiz review`. There is no instruction left to change.

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

### What the session shows while it waits

The turn has ended, but the footer is not empty. With an attached background
command it reads `Waiting for background shells`, and with a background subagent
`Waiting for background agents`. The label is not a running turn: Copilot
builds it from its list of running tasks, and the events show the turn ended
before it. A detached command leaves `1 background /tasks`.

### What the events show

In `~/.copilot/session-state/<session id>/events.jsonl` a wake is
`assistant.turn_end`, then nothing, then:

- `system.notification`, whose `data.kind` is `{"type":"shell_completed",
  "shellId":"0","exitCode":0,"description":"…"}`. The `type` is
  `shell_detached_completed` for a detached command, with no `exitCode`, and
  `agent_idle` for a subagent, with `agentId`, `agentType` and `displayName`;
- a `read_bash` or `read_agent` call and its result, in the same millisecond, with
  no model call before them;
- `assistant.turn_start`.

Each wake also fired `userPromptSubmitted` with the notification as its
`prompt`, then `notification`, then `agentStop` when the woken turn ended.

### The `notification` hook

It is registered like the other project hooks, under `"notification"`. Its
payload, as logged:

```json
{"sessionId":"81e5e846-…","timestamp":1791269519617,"cwd":"…/work",
 "message":"Shell command \"Run delayed timestamp command\" (shellId: 0) has completed successfully.",
 "title":"Run delayed timestamp command","hook_event_name":"Notification",
 "notification_type":"shell_completed"}
```

Returning `{"additionalContext":"<text>"}` added `<text>` as a `user.message`
with `source: "system"`. It arrived after the woken turn had ended and started a
turn of its own.

### Outside routes, as run

- **`copilot --acp`**, over stdio, with `initialize`, `session/load` naming the
  idle session's id, then `session/prompt`. The second process logged
  `session.resume`, ran the turn and shut down. It wrote to the idle session's
  `events.jsonl`, but the idle session's screen never showed the prompt. Anyone
  who can start `copilot` as the user can do this.
- **`copilot --remote`**, interactive. It printed `Remote control connected as
  jacygao` and a `https://github.com/copilot/tasks/<id>` link. GitHub's
  documentation says remote commands are polled from GitHub and injected into
  the session. Only the account that started the session can send them, and the
  organisation's policy must allow "View and control".
- **`copilot --connect <task id> -p "<text>"`**, against that remote session. It
  answered the prompt in a new local session, `6c6ad5d0-…`, and the remote
  session never received it.

### Candidates found and not tried

- `/every`, `/after` and `/loop`: scheduled prompts that start a turn on a
  timer, or are sent as steering when a turn is running. A person starts them
  with a slash command, and they poll rather than answer a command's end.
- The inbox: `system.notification` has a `new_inbox_message` kind whose
  `senderType` may be `sidekick-agent`, `plugin` or `hook`. No help topic or
  documentation page says how a plugin or hook posts one.
- MCP Tasks, experimental: an MCP tool marked `taskSupport: "required"` runs as
  a background agent, and its end would come as an `agent_idle` wake. squiz is
  not an MCP server.
- `--server`, `--headless` and `--ahp-host`: the same family as `--ui-server`.
- `subagentStop` returning `block`.

## Limits

- **One run per case**, on macOS, in a session nobody typed into. It ran in a
  pseudo-terminal whose output was logged and to which nothing was written.
  Every run carried `--allow-all` and `COPILOT_ALLOW_ALL=true`, and every
  `CLAUDE*` variable was unset.
- **Only exit 0 was seen from `squiz review`.** Exit 3 was seen from a plain
  command. Both reviews found nothing on a three-line script, and each command
  ran for about 20 seconds.
- **The longest idle stretch was 7 minutes**, with `sleep 420`. A review longer
  than that, a session left idle for hours, and a machine that sleeps meanwhile
  were not tried.
- **Not tried:** a command that ends while a turn is running, two background
  reviews at once, a model other than `gpt-6-astra`, `-p` mode, and whether a
  session told only by the instruction picks `async` mode by itself.
- **The plugin was not loaded**, so squiz's own `Stop` hook did not fire in these
  runs.
