---
settles: "§ 4 — how the round's values and the reviewer's environment reach the history tools Copilot's reporting server runs, and whether the grant leaves Copilot a shell"
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
- Whether a grant through `--available-tools` alone leaves the model no shell,
  and whether a long call to the server survives Copilot's wait for it.

## Decisions

- **Rely on the server inheriting Copilot's environment.** The server received
  Copilot's whole environment with the configuration's `env` laid over it: a
  variable set only on Copilot arrived, and so did one set empty. So the emptied
  GitHub tokens reach the server as they reach Copilot. The snapshot is the one
  round value the server needs, and it travels as `SQUIZ_SNAPSHOT` in the
  configuration's `env`, which reaches the server whatever the round's own
  environment holds.
- **Treat the server as a member of the reviewer's group.** Its process group
  was the group of the shell that started Copilot, so the round's signal to that
  group reaches it, and the `git` it starts for a history tool with it.
- **Grant the tools through `--available-tools` alone, with no
  `--deny-tool`.** The tools Copilot listed to the model were `view`, `rg`,
  `glob` and the `squiz-` calls. Asked to run `echo hello` with whatever shell it
  had, the model said it had none.

## Needs your input

Nothing.

## Reference

The probe server wrote `process.env` to a file, started with
`"env":{"PROBE_OUT":"…"}`, under a Copilot started with `SQUIZ_MARKER=hello` and
`GH_TOKEN=` set. It received 65 variables, `SQUIZ_MARKER` as `hello`, `GH_TOKEN`
as the empty string, and Copilot's own `COPILOT_*` variables besides.

A live round through the real adapter and `runRound` called each tool once. The
grant then carried a seventh call, `run_tests`, since removed, whose command
printed `GH_TOKEN=[]` and the round's `GH_CONFIG_DIR`, so the server's children
had the emptied credentials. A `git_blame` sent `"line": "2"` reached the model
as:

```
MCP server 'squiz': git_blame was not run: line must be an integer.
```

The tool list is in `<COPILOT_HOME>/session-state/<id>/events.jsonl`, on the
`session.start` event's `tools`.

A server call that took 100 seconds was answered, and the model went on.

## Limits

- One model, one Copilot version, macOS only.
- The longest call waited for was 100 seconds. Whether Copilot gives up on an
  MCP call at some longer wait was not measured.
- Whether Copilot sends `notifications/cancelled` for a call it abandons was not
  seen. The server stops a history tool's `git` on one, and the round's signal
  to the group covers the case where none comes.
