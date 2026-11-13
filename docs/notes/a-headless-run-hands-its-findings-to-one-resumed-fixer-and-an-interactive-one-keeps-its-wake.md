---
settles: "§ 3 — how a round's result reaches a coding agent whose headless run has ended, that the round host starts its fixer, and that an interactive session keeps its wake; § 4 — that the local venue wakes its owner as the GitHub venue does, and holds no run with a blocking Stop"
issue: [787, 801, 876]
recorded: 2026-11-07
versions: { claude: "2.1.319, 2.1.325", copilot: "1.0.106, 1.0.110" }
recheck-when: Claude Code or Copilot CLI change how `--resume` or `--session-id` treats a session, what a resume of an unknown id exits with, or what a resumed session can reach of its subagents; or a measurement compares a resumed fixer with a fresh one
---

# A headless run hands its findings to one resumed fixer, and an interactive one keeps its wake

## Intent

- Whether a headless run (`claude -p`, `copilot -p`) should wait for its review
  by having the `Stop` hook block until the review is done.
- Whether an interactive session and a headless run need the same way of
  getting a round's result back.
- How findings reach a coding agent whose headless run has already exited: by
  resuming its session, or by starting a fresh agent with the context on disk.
- Whether resuming the parent brings back what its subagents knew.
- Who starts the fixer: squiz's round host, or the caller acting on a signal
  squiz writes.
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
- **Hand the first round's findings to a fresh fixer, with the context squiz
  already keeps, and resume that one fixer for every later round of the
  episode.** The first handoff is the record (each thread with every reply, the
  "won't fix, because" answers included), the diff, the description, each
  agent's final report, and the paths to the transcripts. A resume is handed
  only what changed since: the new threads, the new replies and the reviewer's
  rulings. no-mistakes runs its fixer this way, one session across every fix
  turn of a run. The coding agent's own session is never resumed, and neither
  is the reviewer, so no reviewer judges fixes to its own findings.
- **Name the fixer's session up front, and resume it by that id.** Both CLIs
  take `--session-id <uuid>` on a new run and hand the hook that id on every
  stop, the resume's included, so squiz needs nothing from the run's output.
- **Run a failed resume again as a fresh fixer on the whole handoff.** Both CLIs
  exit 1 on a session they cannot find, before any stop fires, so the resumed
  CLI's exit status is the only sign. A stop that carries another session's id
  also gets a fresh fixer, since that is how a resume that started a new session
  would read.
- **Leave a closed interactive session's findings waiting, as now.** Closing a
  session may mean stop. Starting a fixer in that tree unasked spends credits
  and may edit files a person is changing. Continuing after a close is a later
  setting a person turns on, built on the headless handoff.
- **Have squiz's round host start the fixer, and only in the headless mode the
  caller declares.** Delivering the findings is squiz's job, and a caller that
  started fixers would rebuild the loop squiz exists to run. The cost is that
  the fixer's model, permissions, plugin directories and worktree are squiz's
  to set.

## Needs your input

Nothing.

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

### Naming and resuming the fixer's session

Run on Claude Code 2.1.325 and Copilot CLI 1.0.110 in a scratch repository
with squiz's hooks off, and a plugin whose `Stop` hook saved its payload:

| | Claude Code | Copilot CLI |
|---|---|---|
| Start | `claude -p <prompt> --session-id <uuid>`: `session_id` in `--output-format json` is the uuid | `copilot -p <prompt> --session-id=<uuid>`: `~/.copilot/session-state/<uuid>/` is made |
| Resume | `claude -p <prompt> --resume <uuid>`: same `session_id`, and it answered with a token only the first turn was given | `copilot -p <prompt> --resume=<uuid>`: same `sessionId`, the token came back, and `events.jsonl` gained a `session.resume` event |
| Unknown id | exit 1, `No conversation found with session ID: <uuid>` | exit 1, `Error: No session, task, or name matched '<uuid>'.`, and no directory made |
| `Stop` payload, start and resume, with `--plugin-dir` on each | `"session_id": "<uuid>"` | `"session_id": "<uuid>"` |

Copilot's `--session-id` resumes a session it finds and starts one where it
finds none (its help text), so only `--resume` fails on an unknown id.

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
- **Resuming one fixer rests on no-mistakes' design, not on measured fix
  quality.** The one measurement of a resumed fixer against a fresh one found
  no difference in fixing when the fresh one was handed the task.
- **No resumed fixer ran under squiz end to end.** The session routes above
  were run against each CLI directly, and squiz's resume path only against a
  stand-in.
- **How a session is found to have ended was not tested** for either agent:
  `claude agents --json`, a stale socket left by a crash, Copilot's lock and
  pid.
- **The rig behind the review-level measurement scores findings, not fixes.**
  Comparing fixers needs a rig that grades the change left behind.
