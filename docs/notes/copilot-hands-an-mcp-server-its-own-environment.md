---
settles: "§ 5: how the round's values and the reviewer's environment reach the history tools Copilot's reporting server runs, and whether the grant leaves Copilot a shell"
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
  GitHub tokens and `GH_CONFIG_DIR` reach the server, and the `git` it starts,
  as they reach Copilot.
- **Pass the snapshot as `SQUIZ_SNAPSHOT` in the configuration's `env`.** That
  reaches the server whatever the round's own environment holds.
- **Treat the server as a member of the reviewer's group.** Its process group
  was the group of the shell that started Copilot, so the round's signal to that
  group reaches it, and the `git` it starts for a history tool with it.
- **Grant the tools through `--available-tools` alone, with no `--deny-tool`.**
  Copilot listed to the model only the reading tools and the `squiz-` calls.
  Asked to run `echo hello` with whatever shell it had, the model said it had
  none.
- **Let a history tool take as long as it needs.** A server call that took 100
  seconds was answered, and the model went on.

## Needs your input

Nothing.

## Reference

The tools Copilot lists to the model are on the `session.start` event's `tools`
in `<COPILOT_HOME>/session-state/<id>/events.jsonl`. Under the 1.0.92 grant they
were `view`, `rg`, `glob` and the `squiz-` calls.

A probe server started with `"env":{"PROBE_OUT":"…"}`, under a Copilot started
with `SQUIZ_MARKER=hello` and `GH_TOKEN=` set, received 65 variables:
`SQUIZ_MARKER` as `hello`, `GH_TOKEN` as the empty string, and Copilot's own
`COPILOT_*` variables besides.

## Limits

- **One model, one Copilot version, macOS only.**
- **The longest call waited for was 100 seconds.** Whether Copilot gives up on
  an MCP call at some longer wait was not measured.
- **Whether Copilot sends `notifications/cancelled` for a call it abandons** was
  not seen. The server stops a history tool's `git` on one, and the round's
  signal to the group covers the case where none comes.
