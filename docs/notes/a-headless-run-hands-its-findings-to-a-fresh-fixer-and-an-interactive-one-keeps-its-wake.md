---
settles: "§ 3 — how a round's result reaches a coding agent whose headless run has ended, and that an interactive session keeps its wake; § 4 — that the local venue wakes its owner as the GitHub venue does, and holds no run with a blocking Stop"
issue: 787
recorded: 2026-11-07
versions: { claude: 2.1.319, copilot: 1.0.106 }
recheck-when: Claude Code or Copilot CLI change how `--resume` treats a session that is still open, or what a resumed session can reach of its subagents; or a measurement compares a resumed fixer with a fresh one
---

# A headless run hands its findings to a fresh fixer, and an interactive one keeps its wake

## Intent

- Whether a headless run (`claude -p`, `copilot -p`) should wait for its review
  by having the `Stop` hook block until the review is done.
- Whether an interactive session and a headless run need the same way of
  getting a round's result back.
- How findings reach a coding agent whose headless run has already exited: by
  resuming its session, or by starting a fresh agent with the context on disk.
- Whether resuming the parent brings back what its subagents knew.
- Whether squiz can tell a live session from one that has ended.
- What happens when a person closes an interactive session before its review
  finishes.

## Decisions

- **Hold no run with a blocking `Stop`.** Each block is a paid turn. The agent
  polls a command that is only waiting, and a model that ends its turn instead
  is blocked again, so a review that breaks leaves the run spending until
  something kills it. Durable-execution systems wait at no cost instead: they
  save the state, let the process exit, and start the next step on the event.
  Squiz's hook, round host and wake already have that shape.
- **Keep the wake for interactive sessions, unchanged, in both venues.** The
  wake needs only a live session, never a pull request. The local venue posts
  its note to the owner's socket exactly as the GitHub venue does.
- **Give headless runs a delivery of their own, the handoff, and have the
  caller declare it.** A headless run has always exited by the time its review
  finishes, so a wake there always fails. A caller that declares the mode spares
  squiz from deciding whether a session is alive, which nothing here has shown
  it can do safely.
- **Hand the findings to a fresh fixer, and give it the context squiz already
  keeps.** That is the record (each thread with every reply, the
  "won't fix, because" answers included), the diff, the description, each
  agent's final report, and the paths to the transcripts so it can read more.
  Most products that route review feedback to an agent start a new run for each
  round in just this way, and Anthropic's Agent SDK documentation calls a fresh
  session given captured state "often more robust" than a resume. Resuming the
  original session is an optimisation to measure, not the foundation.
- **Leave a closed interactive session's findings waiting, as now.** Closing a
  session may mean stop. Starting a fixer in that tree unasked spends credits
  and may edit files a person is changing. Continuing after a close is a later
  setting a person turns on, built on the headless handoff.

## Needs your input

- **Who starts the fixer: squiz's round host, or the caller acting on a signal
  squiz writes.** Recommendation: the round host, behind the declared headless
  mode. Delivery is squiz's job, and a caller that starts fixers rebuilds the
  loop squiz exists to run. It does bring a coding agent's model, permissions
  and worktree inside squiz.

## Reference

### What a closed or exited session leaves

- **The review still runs.** The round host is detached, so it outlives the
  session and posts the findings.
- **Only the wake fails.** The note goes back to `.squiz/<number>/notes/` and
  waits for `squiz review` or `squiz status`. Nothing pushes it into a new
  session.
- **No squiz process is left.** The round host exits after its round, whether
  or not the wake reached anyone.

### Claude Code

- `claude -p --resume <id> "<prompt>"` sends a turn to a past session.
  `--plugin-dir`, `--settings`, `--mcp-config` and `--add-dir` are not restored
  and must be passed again, and a `-p` resume starts in a new run's permission
  mode.
- `--fork-session` gives the resumed run a new session id, so it cannot write
  into the original.
- **Resuming a session open in another process interleaves both into one
  transcript.** Nothing refuses it.
- `claude agents --json` lists every live session with `pid` and `sessionId`
  (unverified: how soon an exited session leaves the list).
- Transcripts are at `~/.claude/projects/<cwd, non-alphanumerics as ->/<session-id>.jsonl`,
  and a subagent's at `<session-id>/subagents/agent-<agentId>.jsonl` beside an
  `agent-<agentId>.meta.json`. They are deleted after `cleanupPeriodDays`, 30
  by default, and found on the same machine only.
- **A resumed session can continue a subagent with `SendMessage` to its agent
  id, and the subagent keeps its whole history**, under `-p` too. One whose
  worktree was removed resumes in the parent's directory instead:
  `a-resumed-claude-session-keeps-its-subagents-and-a-resumed-copilot-session-loses-them.md`
  has the measurement. Explore and Plan agents return no id and cannot be
  continued.
- A parent only ever holds its subagents' final reports. `SubagentStop`'s
  payload carries `last_assistant_message` and `agent_transcript_path`.
- An async hook still running when a `-p` run ends is killed, so
  `asyncRewake` never reaches a run that has exited.
- A plain `-p` session removes its messaging socket when it exits, and a post
  to it fails with `FileNotFoundError`.

### Copilot CLI

- `copilot --resume=<id> -p` against an idle interactive session ran the turn in
  a second process. The session's pane never showed it, and both processes
  wrote the same `events.jsonl`. `copilot -p --resume` continues a session
  that has exited, with its transcript.
- A session's directory under `~/.copilot/session-state/` holds `events.jsonl`
  and, while a process has it, `inuse.<pid>.lock`. Stale locks are a reported
  fault, so a lock means a live session only if its pid is running Copilot.
- Subagents are not in files of their own. They are events inside the parent's
  `events.jsonl`. A background `general-purpose` subagent cannot be continued
  after a resume: `write_agent` answers `No agent found`. Other agent types and
  a sync-mode `task` are unverified.

### Cost of a resume

A resume sends the whole transcript again. The prompt cache lasts 5 minutes on
an API key and an hour on a subscription, so a resume after a long review pays
for the transcript uncached.

### Every automated review-and-fix loop has a bound

Cursor's Bugbot Autofix stops after 3 attempts on a pull request, Factory's
action has `max_fix_attempts`, and the OpenHands resolver `OPENHANDS_MAX_ITER`.
Devin ignores bot comments by default and warns that answering them can loop.
Squiz's round cap is that bound, and a headless fixer stays under it.

## Limits

- **Little here was run.** The Claude Code and Copilot facts come from their
  documentation and help text, except the observations from earlier probes:
  the `-p` socket removed on exit, the second Copilot process, and what a
  resume of an exited `-p` run restores.
- **No head-to-head comparison of a resumed fixer and a fresh one was found**,
  in products or in papers. The decision to start fresh rests on what others
  do and on the cost, not on measured fix quality.
- **How a session is found to have ended was not tested** for either agent:
  `claude agents --json`, a stale socket left by a crash, Copilot's lock and
  pid.
- **The rig behind the review-level measurement scores findings, not fixes.**
  Comparing fixers needs a rig that grades the change left behind.
