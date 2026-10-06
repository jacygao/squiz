---
settles: "§ 3 — whether GitHub Copilot CLI's stop hooks can queue a state as Claude Code's do, which payload field names the owner of the work, and what can start a turn in an idle Copilot session"
issue: 499
recorded: 2026-10-06
versions: { copilot: 1.0.92, models: "gpt-5-mini (session), gpt-5.6-luna (subagents)", herdr: 0.9.3, node: 24.15.0, macos: 26.6.2 }
recheck-when: Copilot CLI upgrades past 1.0.92, or changes its hook payloads, which session an `agentStop` firing reports, or its `--ui-server` mode
---

# Copilot's stop hooks fire, and an idle session can be woken when it runs a UI server

Both hooks fire. `agentStop` fires when any turn ends, a subagent's included.
`subagentStop` fires when a subagent ends, and its `sessionId` is the parent
session's. Three things outside a session each started a turn in it while it
was idle:

- a prompt sent through the Copilot SDK to a session started with `--ui-server`;
- text typed into its Herdr pane;
- the session's own `agentStop` hook returning a block, though the session is
  not idle while that hook runs.

## Intent

- Whether `agentStop` and `subagentStop`, registered in a project, fire.
- What `subagentStop`'s payload carries, and whether it names the parent session.
- Whether anything outside a Copilot session can start a turn in it while it is
  idle.

## Decisions

- **Register `squiz hook` on `agentStop` and `subagentStop`, and have both queue
  and exit 0, as the Claude Code hooks do.** Both fired in every run, from
  `.github/hooks/*.json` in a trusted folder. Copilot waits for a hook before it
  goes idle, so the hook must return as soon as it has queued.
- **Take the owner from `sessionId` on both events, and the subagent from
  `subagentStop`'s `agentId`.** On `subagentStop`, `sessionId` was the parent
  session's id and `agentId` was the subagent's own session id. That matches
  what § 3's table records from Claude Code's `session_id` and `agent_id`.
- **Ignore an `agentStop` firing whose `sessionId` is not the session named in
  its `transcriptPath`.** Copilot fires `agentStop` for a subagent's turn too,
  just before that subagent's `subagentStop`. That firing carries the subagent's
  id as `sessionId` and the parent's `events.jsonl` as `transcriptPath`. Queued
  as it stands, it would record a subagent as the owner, and nothing is left
  alive to wake when it ends. Claude Code's `Stop` never fires for a subagent,
  so § 3 has no rule for this case.
- **Expect no messaging socket.** No hook's environment named a socket, a port,
  or a token. The wake has to come from one of the routes under Needs your
  input, or the coding agent runs `squiz review` itself and waits for it.

## Needs your input

- **Which wake squiz uses for a Copilot coding agent, if any.** Three started a
  turn in an idle interactive session:
  - **The SDK, against a session started with `--ui-server --port <n>`.** A
    process outside the session connected to `127.0.0.1:<n>`, resumed the
    foreground session, and sent a prompt. The turn started 42 seconds after the
    session went idle, and the pane showed it as an ordinary prompt. It is the
    nearest thing to Claude Code's socket, but the session has to be started
    with the flag, which `copilot --help` does not list. The port reached no
    hook's environment. The server asked for no token, so any local process can
    drive the session.
  - **Text sent to the session's Herdr pane, then Enter.** The turn started at
    once and read as the user's own prompt. It works only in Herdr, and the hook
    finds the pane by `HERDR_PANE_ID` in its environment.
  - **`agentStop` returning `{"decision":"block","reason":"<text>"}`.** The
    reason arrived as the next user message, verbatim, and the turn went on. For
    the 30 seconds the hook waited, the footer read `Working`, so this keeps the
    session busy rather than waking it. It is the blocking design § 3 dropped
    for Claude Code in M7.

  Recommendation: build no wake for Copilot in M13. Have the hooks queue, have
  the coding agent run `squiz review` and wait for it, and state the missing wake
  as a gap in § 3. Revisit `--ui-server` if starting the session with that flag
  turns out to be acceptable. An unauthenticated local port that drives the
  session is a cost to weigh first.

## Reference

### Registration

`.github/hooks/<any>.json`, loaded only where Copilot trusts the folder, as
`a-project-copilot-trusts-runs-its-hooks-and-mcp-servers.md` records:

```json
{
  "version": 1,
  "hooks": {
    "agentStop":    [{ "type": "command", "bash": "<command>", "timeoutSec": 10 }],
    "subagentStop": [{ "type": "command", "bash": "<command>", "timeoutSec": 10 }]
  }
}
```

The hook ran as a child of the `copilot` process, with the payload on stdin and
the working directory at the project root.

### Payloads, as logged

`agentStop`, for the session's own turn:

```json
{"sessionId":"948ba947-…","timestamp":1791264007683,"cwd":"…/repo",
 "transcriptPath":"<COPILOT_HOME>/session-state/948ba947-…/events.jsonl",
 "stopReason":"end_turn","stop_hook_active":false}
```

`agentStop`, for a subagent's turn. The `sessionId` is the subagent's, and the
`transcriptPath` is the parent's:

```json
{"sessionId":"186239e4-…","timestamp":1791264004848,"cwd":"…/repo",
 "transcriptPath":"<COPILOT_HOME>/session-state/948ba947-…/events.jsonl",
 "stopReason":"end_turn","stop_hook_active":false}
```

`subagentStop`:

```json
{"sessionId":"948ba947-…","timestamp":1791264004910,"cwd":"…/repo",
 "transcriptPath":"<COPILOT_HOME>/session-state/948ba947-…/events.jsonl",
 "agentId":"186239e4-…","agentType":"explore","agentName":"explore",
 "response":"PONG","stopReason":"end_turn"}
```

The keys are camelCase except `stop_hook_active`. `subagentStop` carries no
`stop_hook_active`. `response` is the subagent's last message. `stop_hook_active`
was `true` on the `agentStop` firing that followed a block.

### The hook's environment

`COPILOT_CLI=1`, `COPILOT_CLI_BINARY_VERSION`, `COPILOT_HOME`,
`COPILOT_PROJECT_DIR`, and in interactive sessions `COPILOT_LOADER_PID`, the pid
of the `copilot` process. A session in a Herdr pane passed on Herdr's
`HERDR_PANE_ID`, `HERDR_SOCKET_PATH` and the rest.

### Starting a subagent

The `task` tool, with `agent_type` (`explore` and `task` were used) and `mode`.
The model calls it when the prompt asks for it by name. Under `"mode":"sync"`
the parent's turn waits for the subagent. Under `"mode":"background"` the
parent's turn ended first. When the subagent ended, Copilot itself started a
turn in the idle parent, with this prompt:

```
<system_notification>
Agent "sleep-pong" (task) has finished processing and is now idle.
</system_notification>
```

### Order of firings

A sync subagent, in `-p`: `preToolUse` (`task`), `subagentStart`,
`userPromptSubmitted` (the subagent's id), `agentStop` (the subagent's id),
`subagentStop`, `agentStop` (the parent's id), `sessionEnd`.

### The SDK wake

The SDK ships in Copilot's package cache, at
`~/Library/Caches/copilot/pkg/darwin-arm64/<version>/copilot-sdk/index.js`:

```js
const client = new CopilotClient({ connection: RuntimeConnection.forUri("47499") });
await client.start();
const id = await client.getForegroundSessionId();
const session = await client.resumeSession(id, { onPermissionRequest: approveAll });
await session.sendAndWait({ prompt: "<text>" }, 120000);
```

`cliUrl`, which the SDK's own error messages name, is not an option in this
version. Passing it makes the SDK try to spawn a runtime of its own, and that
fails with `Could not resolve @github/copilot-sdk-darwin-arm64`.

### Not a wake: `copilot --resume=<id> -p`

Run from another shell against the idle session, it ran a turn in a second
process, with `sessionStart` `source: "resume"` and a `sessionEnd` of its own.
The idle session's pane never showed it. Both processes wrote the same
`events.jsonl`.

## Limits

- **One run per case**, on macOS, with `gpt-5-mini` as the session's model.
- **The scratch folder was not a git repository.** Hooks loaded from
  `.github/hooks/` under the working directory, which a trusted folder in an
  adapter-owned `COPILOT_HOME` named.
- **Idle for under a minute before each wake.** The SDK wake came 42 seconds
  after the session went idle, and the pane wake 13 seconds after.
- **Not tested:**
  - whether a hook can find the `--ui-server` port, for example from
    `COPILOT_LOADER_PID`;
  - the longest `timeoutSec` Copilot honours, and what a blocking `agentStop`
    does when its timeout falls;
  - `subagentStop` returning a block or a `modifiedResponse`;
  - `--remote`, `--acp` and `--connect`;
  - a wake that arrives while a turn is running;
  - a session that prompts for tool permissions. Every run carried
    `--allow-all-tools`.
- **Only short probes were typed into a pane.** macOS cuts a line typed into a
  terminal at 1024 bytes, so a long note sent this way would arrive cut.
