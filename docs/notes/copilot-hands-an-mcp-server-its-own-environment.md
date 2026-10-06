---
settles: "§ 4 — how the round's values and the reviewer's environment reach the deep tools Copilot's reporting server runs, and whether Copilot grants a shell at deep"
issue: 551
recorded: 2026-10-06
versions: { copilot: 1.0.92, model: gpt-6-astra, node: 24.15.0, macos: 26.6.2 }
recheck-when: Copilot CLI upgrades past 1.0.92, or starts filtering the environment of a local MCP server
---

# Copilot hands an MCP server its own environment

## Intent

- Whether a local MCP server Copilot starts inherits Copilot's environment, or
  only the `env` its configuration names.
- Whether that server runs in the reviewer's process group.
- Whether a `deep` round through the server grants the model no shell, and
  whether a long `run_tests` call survives Copilot's wait for it.

## Decisions

- **Read the round's values from the server's own environment, and pass nothing
  for them in the MCP configuration.** The server received Copilot's whole
  environment with the configuration's `env` laid over it: a variable set only
  on Copilot arrived, and so did one set empty. `SQUIZ_ROUND`, the record and
  keeper, and the emptied GitHub tokens reach the server as they reach Copilot,
  so the configuration is the same at both depths.
- **Treat the server as a member of the reviewer's group.** Its process group
  was the group of the shell that started Copilot, so the round's signal to that
  group reaches it, and only the test command `run_tests` starts needs the
  record.
- **Grant the `deep` tools through `--available-tools` alone, with no
  `--deny-tool`.** The tools Copilot listed to the model at `deep` were `view`,
  `rg`, `glob` and the seven `squiz-` calls. Asked to run `echo hello` with
  whatever shell it had, the model said it had none.

## Needs your input

Nothing.

## Reference

The probe server wrote `process.env` to a file, started with
`"env":{"PROBE_OUT":"…"}`, under a Copilot started with `SQUIZ_MARKER=hello` and
`GH_TOKEN=` set. It received 65 variables, `SQUIZ_MARKER` as `hello`, `GH_TOKEN`
as the empty string, and Copilot's own `COPILOT_*` variables besides.

A live round through the real adapter and `runRound` at `deep` called each tool
once. `run_tests` printed the round's `TMPDIR`, `GH_TOKEN=[]` and the round's
`GH_CONFIG_DIR`. A `git_blame` sent `"line": "2"` reached the model as:

```
MCP server 'squiz': git_blame was not run: line must be an integer.
```

The tool list is in `<COPILOT_HOME>/session-state/<id>/events.jsonl`, on the
`session.start` event's `tools`.

A `run_tests` whose command slept 100 seconds was answered, and the model went
on. In a round bounded at 40 seconds, a command that would sleep 600 was stopped
by `run_tests` after 29, and nothing of it was left running.

## Limits

- One model, one Copilot version, macOS only.
- The longest call waited for was 100 seconds. Whether Copilot gives up on an
  MCP call at some longer wait was not measured.
- Whether Copilot sends `notifications/cancelled` for a call it abandons was not
  seen. The server stops `run_tests` on one, and the round's record covers the
  case where none comes.
