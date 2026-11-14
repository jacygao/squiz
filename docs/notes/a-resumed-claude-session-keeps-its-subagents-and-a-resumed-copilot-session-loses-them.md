---
settles: "§ 3 — what a fixer gets by resuming a headless run's session after the run has exited, against starting fresh, and what that resume costs once the prompt cache has expired"
issue: 800
recorded: 2026-11-13
versions: { claude: 2.1.321, copilot: 1.0.109, claude-model: claude-opus-5-5, copilot-model: gpt-6.1-sol }
recheck-when: Claude Code or Copilot CLI change what `--resume` restores, Copilot marks a subagent `resumable`, either changes its prompt-cache lifetime, or squiz considers resuming the coding agent's own session instead of starting a fixer in a session of its own
---

# A resumed Claude session keeps its subagents, and a resumed Copilot session loses them

## Intent

- Whether `claude -p --resume` and `copilot -p --resume` restore the transcript
  of a session whose `-p` run has exited, and take a new turn.
- Whether a resumed Claude parent can `SendMessage` a subagent from before the
  exit, including one whose worktree was removed.
- Whether a resumed Copilot parent can continue a subagent.
- What a resume of a long transcript costs after the prompt cache has expired.

## Decisions

- **Hand the headless run's findings to a fixer in a session of its own, for
  both agents, and never resume the coding agent's session.** A resume restores
  only the parent in Copilot, so it cannot be the common route, and a cold
  resume costs about what the original run did. Each later round of the
  episode then resumes the fixer's own session.
- **Never continue a Claude subagent whose worktree is gone.** It resumes in
  the parent's directory instead, so a fix it makes lands in the wrong tree,
  and nothing reports the move.

## Needs your input

Nothing.

## Reference

### Both agents restore the parent

- Each resume kept the original session id and answered from the original
  transcript: a token set in the first prompt and never repeated came back
  exactly, and so did one buried at line 3,500 of a 6,000-line prompt.
- Copilot's resume writes a `session.resume` event with
  `"sessionWasActive": false` and `"alreadyInUse": false`. That is the field
  that tells a resume of an exited session from one of a live session.

### Claude: `SendMessage` reaches a subagent from before the exit

- The resumed parent's `SendMessage` returned
  `{"success":true,"message":"Resuming agent ac7182e","resumedAgentId":"ac7182ec208624d91",...}`.
  The subagent replied with a token that only its own transcript held, from an
  `openssl rand -hex 4` it ran before the exit.
- The same held for a subagent started with `isolation: "worktree"`, whose
  worktree had been removed when the first run ended (its `meta.json` has
  `"worktreeCleanlyRemoved": true`).
- **That subagent resumed in the parent's directory.** Its transcript's `cwd`
  is `<repo>/.claude/worktrees/agent-<id>` for every entry before the exit and
  `<repo>` for every entry after. Whether it goes back to its worktree when the
  worktree still exists is unverified.
- `SendMessage` is deferred: the resumed parent loaded it with `ToolSearch`
  before calling it.
- In `-p`, `Agent` starts subagents in the background
  (`"requestShape":"background"`) and the run waits for them before it exits.

### Copilot: a subagent does not survive the run

- `task` reports the subagent with `"resumable": false` on `subagent.started`,
  though its result says the agent "supports multi-turn conversations" through
  `write_agent` and `read_agent`.
- After the resume, `write_agent` and `read_agent` with the subagent's id both
  failed: `No agent found with agent_id: <id>. The agent may have been cleared
  or never existed.`
- A subagent's events, its shell output included, are in the parent's
  `events.jsonl`, so its work can be read but not continued.

### Cost of a resume

Measured on a 6,000-line prompt resumed with one short question. The first run
wrote the transcript to the cache. The warm resume came at once, the cold one
after more than the cache lifetime each CLI uses. Each row is that run's own
share, in cached tokens and in the CLI's own cost figure. A cold resume costs
about what the first run did: 18 times a warm one on Claude, 25 times on
Copilot.

| | Claude (`claude-opus-5-5`) | Copilot (`gpt-6.1-sol`) |
|---|---|---|
| Cache lifetime | 1 hour: every write is `ephemeral_1h_input_tokens` | 30 minutes: `"cacheTtlSeconds": 1800` |
| First run | 13,372 read, 210,098 written, $1.68 | 10,918 read, 129,675 written, 32.53 billion nano-AIU, 1 premium request |
| Warm resume | 216,979 read, 6,519 written, $0.096 | 140,593 read, 54 written, 1.43 billion nano-AIU, 1 premium request |
| Cold resume | 11,382 read, 214,811 written, $1.72 | 0 read, 140,705 written, 35.19 billion nano-AIU, 1 premium request |
| Wait before the cold resume | 67 min 21 s after the last call | 41 min 44 s after the last call |

- **Both CLIs report a session's running total, not the turn's.** Claude's
  `total_cost_usd` and `modelUsage`, and Copilot's `--usage-output-file` and
  `premiumRequests`, include every earlier run of the session. A resume's own
  cost is the difference from the previous run's figure. Claude's top-level
  `usage` is the last turn's alone.
- Copilot's usage file and its `session.usage_checkpoint` event carry
  `cacheExpiresAt`, so a caller can tell in advance whether a resume will be
  cold.

## Limits

- One run of each experiment, on one machine, with each CLI's default model.
- The Claude runs inherited the dispatching session's `CLAUDE_CODE_*`
  environment, which this sandbox would not let them drop. Each still got a
  session of its own.
- Only `general-purpose` subagents were tried. Copilot's `"resumable": false`
  may differ for other agent types or for a `task` run in sync mode.
- Nothing here compares the quality of a resumed fixer with a fresh one.
