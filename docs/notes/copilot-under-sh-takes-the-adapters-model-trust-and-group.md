---
settles: "§ 5 — the Copilot adapter's environment (COPILOT_MODEL, COPILOT_ALLOW_ALL), the process group a round signals, and the usage a run leaves"
issue: [462, 599]
recorded: 2026-10-06
versions: { copilot: "1.0.92, 1.0.98", model: gpt-5-mini, tmux: 3.7b, macos: 26.6.2 }
recheck-when: Copilot CLI upgrades past 1.0.98, or changes how it reads COPILOT_MODEL, --model or COPILOT_ALLOW_ALL, or how it starts
---

# Copilot under `sh` takes the adapter's model, trust and group

## Intent

- Whether `COPILOT_MODEL` sets the reviewer's model under the adapter's
  `COPILOT_HOME`.
- Whether an empty `COPILOT_ALLOW_ALL` turns trust off, and survives a tmux
  window's or a Herdr pane's command line.
- Whether Copilot stays in `sh`'s process group when `sh -c` starts it.

## Decisions

- **Carry the user's default model to the reviewer with `COPILOT_MODEL`.** With
  `COPILOT_MODEL=gpt-5-mini` and an empty `COPILOT_HOME`, every run's
  `session.start` event carried `"selectedModel":"gpt-5-mini"`, and its usage
  file `"currentModel": "gpt-5-mini"`. A model the project configures goes on
  `--model` instead, because a `COPILOT_MODEL` naming a model the user does not
  have runs the round on another one and exits 0 (§ 5 The Copilot adapter).

  2026-10-17: superseded for the default too. Put a non-empty `COPILOT_MODEL` on
  `--model`, so that Copilot refuses a model it does not offer. On Copilot
  1.0.98 with an empty `COPILOT_HOME`, `--model no-such-model-xyz` exited 1
  before any request, with `Model "no-such-model-xyz" from --model flag is not
  available.` and `"totalNanoAiu": 0`, while `gpt-5-mini` on `--model` replied
  and exited 0. Copilot 1.0.98 reads an empty `COPILOT_MODEL` as unset, so an
  empty one keeps a stale value in a pane server's environment off `--model`.
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

The same unavailable model through each route, under an empty `COPILOT_HOME`:

| Route | Copilot | Result |
|---|---|---|
| `COPILOT_MODEL=no-such-model-xyz` | 1.0.92 | Exit 0, 0.52 credits spent. `session.start` records `"selectedModel":"no-such-model-xyz"`, and the usage file `claude-sonnet-5` |
| `--model no-such-model-xyz` | 1.0.92, 1.0.98 | Exit 1 before any request |

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
- The `--model` refusal was seen for a model name that does not exist. A real
  model the user's plan does not include was not tried.
- The run that reached no model used a stand-in provider through
  `COPILOT_PROVIDER_BASE_URL`, not GitHub's own routing refusing it.
- The group was read in tmux. Herdr's gate `exec`s `sh` in the same way, and was
  not measured with Copilot.
