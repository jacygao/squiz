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
  shell.** The reason arrived as the agent's next message and the run went on.
  The next `Stop` carried `"stop_hook_active":true`, and returning nothing then
  let the run exit 0.
- **Pass the local venue's settings as environment variables.** `SQUIZ_LOCAL`
  and `SQUIZ_BASE`, set on `copilot -p`, reached the hook and the script the
  agent ran in its shell.
- **Start the round host from the hook as now.** A process the hook started
  with Node's `spawn(…, {detached: true})` and `unref()` went on after the run
  that started it had exited.
- **Keep `squiz review`'s 540-second wait.** No foreground command was stopped:
  one ran 7 minutes, and one ran 1 hour 5 minutes. On the long one, Copilot gave
  the turn back while the command still ran. The agent then waited on it with
  `Read shell output` calls of up to 120 seconds each until it ended.

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
- **The long run's 1 hour 5 minutes includes about 57 minutes the machine
  slept.** It shows that the command was not stopped across that span, not that
  Copilot sets no bound shorter than an hour of awake time. Awake, the command
  ran about 17 minutes.
- **The reviewer's hosts were not observed.** No network was captured, so
  whether a Copilot reviewer with `--no-auto-update` and
  `--disable-client-telemetry` reaches only `api.github.com` and the model host
  is still open.
