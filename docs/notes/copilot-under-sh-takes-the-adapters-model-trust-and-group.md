---
settles: "§ 4 — the Copilot adapter's environment (COPILOT_MODEL, COPILOT_ALLOW_ALL), the process group a round signals, and the usage a run leaves"
issue: 462
recorded: 2026-10-06
versions: { copilot: 1.0.92, model: gpt-5-mini, tmux: 3.7b, macos: 26.6.2 }
recheck-when: Copilot CLI upgrades past 1.0.92, or changes how it reads COPILOT_MODEL or COPILOT_ALLOW_ALL, or how it starts
---

# Copilot under `sh` takes the adapter's model, trust and group

## Intent

- Whether `COPILOT_MODEL` sets the reviewer's model under the adapter's
  `COPILOT_HOME`.
- Whether an empty `COPILOT_ALLOW_ALL` turns trust off, and survives a tmux
  window's or a Herdr pane's command line.
- Whether Copilot stays in `sh`'s process group when `sh -c` starts it.

## Decisions

- **Set the model with `COPILOT_MODEL`, and pass no `--model`.** With
  `COPILOT_MODEL=gpt-5-mini` and an empty `COPILOT_HOME`, every run's
  `session.start` event carried `"selectedModel":"gpt-5-mini"`, and its usage
  file `"currentModel": "gpt-5-mini"`.
- **Set `COPILOT_ALLOW_ALL` to the empty string.** Empty, it trusted nothing: a
  tree's `.mcp.json` server was not listed and not started. Set to `true` under
  the same empty `COPILOT_HOME`, the same server was listed. The empty value
  reached the command through tmux's `-e COPILOT_ALLOW_ALL=` and Herdr's
  `--env COPILOT_ALLOW_ALL=` as set and empty, and won over a tmux server whose
  own environment carried `COPILOT_ALLOW_ALL=true`.
- **Signal `sh`'s group, as for any reviewer.** Started by `sh -c` as a tmux
  window's command, Copilot and the reporting server it started were both in the
  group `sh` led, in each of three runs.
- **Append the usage only through a variable that must be set.** The usage file
  is several lines of indented JSON, so it is joined into one line before it is
  appended. A run that reached no model exits 1 and still writes a usage file,
  one with an empty `modelMetrics`.

## Needs your input

Nothing.

## Reference

The processes of a run, from `ps -o pid,ppid,pgid`:

```
24664 24660 24664  sh -c copilot -p "$(cat …/prompt.md)" …
24675 24664 24664  copilot -p # Review…
24753 24675 24664  node …/src/reviewers/copilot/server.ts
```

`copilot mcp list` lists a folder's `Workspace servers` only where Copilot
trusts the folder, and makes no model call, so it checks trust for nothing.

What a run that reached no model left, its provider answering 400:

| | |
|---|---|
| Exit status | 1 |
| stderr | the provider's message, `400 capture only` |
| Usage file | written, `"modelMetrics": {}`, `"totalNanoAiu": 0` |

## Limits

- Which model Copilot falls back to where `COPILOT_MODEL` is unset and the user
  has no `model` setting was not run. An idle interactive Copilot does not show
  it.
- The run that reached no model used a stand-in provider through
  `COPILOT_PROVIDER_BASE_URL`, not GitHub's own routing refusing it.
- The group was read in tmux. Herdr's gate `exec`s `sh` in the same way, and was
  not measured with Copilot.
