---
settles: "§ 4 — whether a Stop hook that blocks keeps a `copilot -p` run going, whether the hook and the shell inherit SQUIZ_*, and whether a review the hook starts outlives the run; § 8 — whether squiz review's 540-second wait fits Copilot's shell"
issue: 787
recorded: 2026-11-05
versions: { copilot: 1.0.105, model: gpt-6-astra, node: 24.15.0, macos: 26.6.2 }
recheck-when: Copilot CLI upgrades past 1.0.105, or changes how a Stop hook's decision is read under -p, or its shell tool's timeouts
---

# `copilot -p` goes on after a blocking Stop, and waits out a long command

## Intent

- Whether a plugin's `Stop` hook answering `{"decision":"block","reason":…}`
  continues a `copilot -p` run, or is ignored because nothing is interactive.
- Whether the hook and the agent's shell inherit variables such as
  `SQUIZ_LOCAL` from the run.
- Whether a process the hook starts detached outlives the run.
- How long Copilot's shell lets one foreground command run before it stops it.

## Decisions

- **Hold a local run with a blocking `Stop`, and let the agent wait in its
  shell.** Superseded on 2026-11-07: a headless run hands its findings to a
  fixer in a session of its own instead, resumed across the episode's rounds,
  and nothing holds it. The fact below stands. The reason arrived as the
  agent's next message and the run went on.
  The next `Stop` carried `"stop_hook_active":true`, and returning nothing then
  let the run exit 0.
- **Choose the local venue with `"venue": "local"` in `.squiz.json`.**
  Superseded on 2026-11-08: squiz reads the venue from the setting and no
  environment variable, because a variable reaches only the processes its run
  started. The fact below stands. The variables measured were `SQUIZ_LOCAL`
  and `SQUIZ_BASE`, which squiz no longer reads. Set on `copilot -p`, both
  reached the hook and the script the agent ran in its shell.
- **Start the round host from the hook as now.** A process the hook started
  with Node's `spawn(…, {detached: true})` and `unref()` went on after the run
  that started it had exited.
- **Keep `squiz review`'s 540-second wait.** No foreground command was stopped.
  One ran 7 minutes, start to end, in one call. The other ran about 10 minutes
  of awake time before Copilot gave the turn back with the command still
  running. The agent then waited on it with `Read shell output` calls of up to
  120 seconds each, about 6 minutes more, until it ended.

## Needs your input

Nothing.

## Reference

The hook's answer, on standard output, exit 0:

```json
{"decision":"block","reason":"SPIKE: a review is running. Run the command  sh .wait.sh  in the foreground and wait for it to finish however long it takes; do not background it. Then reply with the single word DONE."}
```

- **A script outside the working directory is refused under `-p`.** With
  `--allow-tool 'shell(sh)'` and no `--allow-all-paths`, `sh /abs/path/wait.sh`
  was denied with "Permission denied because no interactive user response was
  available". The same script inside the repository ran. `squiz` on `PATH` is a
  command name rather than a path argument (unverified under `-p`).
- **The hook's environment carries the parent Claude Code session's
  `CLAUDE_CODE_MESSAGING_SOCKET`** when `copilot` is started from inside one,
  alongside `COPILOT_CLI=1`.
- **The run's own `COPILOT_HOME` keeps the user's plugins out.** The user's
  `settings.json` enabled the installed `squiz@squiz`, so each run used an empty
  home of its own. Sign-in still came through `gh`.

## Limits

- **Claude Code under `claude -p` was not run.** Its `Stop` block and its
  600-second shell bound are the ones § 8 already relies on.
- **The model followed the instruction to wait.** Nothing here shows what a
  model does that ends its turn instead. Under the stop rule, ending the turn
  is another `Stop`, which blocks again.
- **The machine slept for about 56 minutes of the long run.** The wait script
  ran 73 minutes of wall time and about 17 awake. Copilot reported the call as
  1 hour 5 minutes 48 seconds, about 10 minutes of it awake, before it handed
  the turn back. That shows the command was not stopped across the sleep. It
  does not show what Copilot does with a command that runs longer than about
  10 awake minutes in one call.
- **The reviewer's hosts were not observed.** No network was captured in these
  runs.
