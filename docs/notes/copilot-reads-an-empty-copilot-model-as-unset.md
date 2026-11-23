---
settles: "§ 5 The Copilot adapter: how the user's default model reaches the reviewer, and what COPILOT_MODEL is set to in its environment"
issue: [462, 599]
recorded: 2026-10-17
versions: { copilot: "1.0.92, 1.0.98", model: gpt-5-mini, tmux: 3.7b, macos: 26.6.2 }
recheck-when: Copilot CLI upgrades past 1.0.98, or changes how it reads COPILOT_MODEL or --model, or a pane backend changes how it passes a variable to its command
---

# Copilot reads an empty `COPILOT_MODEL` as unset

## Intent

- How the user's default model reaches the reviewer, where `.squiz.json` sets no
  `model`.
- Whether an empty variable the adapter sets reaches Copilot through a tmux
  window's or a Herdr pane's command line, over the pane server's own value.

## Decisions

- **Set `COPILOT_MODEL` in the reviewer's environment to the user's default, or
  to the empty string where there is none, and have the line put a non-empty one
  on `--model`.** `--model` refuses a model Copilot does not offer before any
  request, and `COPILOT_MODEL` alone runs the round on another model and exits 0.
  Copilot 1.0.98 reads an empty `COPILOT_MODEL` as unset, so the empty value
  keeps a stale one in a pane server's environment off the line.
- **Set the variable even where the round host already carries it.** A pane runs
  its command with its server's environment, not the host's. An empty value set
  through tmux's `-e` or Herdr's `--env` reached the command as set and empty,
  and won over a tmux server whose own environment carried a value.

## Needs your input

Nothing.

## Reference

The line's model argument, where no `model` is configured:

```sh
${COPILOT_MODEL:+--model "$COPILOT_MODEL"}
```

The same unavailable model through each route, under an empty `COPILOT_HOME`:

| Route | Copilot | Result |
|---|---|---|
| `COPILOT_MODEL=no-such-model-xyz` | 1.0.92 | Exit 0, 0.52 credits spent. `session.start` records `"selectedModel":"no-such-model-xyz"`, and the usage file `claude-sonnet-5` |
| `--model no-such-model-xyz` | 1.0.92, 1.0.98 | Exit 1 before any request, with `Model "no-such-model-xyz" from --model flag is not available.` and `"totalNanoAiu": 0` |

A model Copilot offers, set in `COPILOT_MODEL` under an empty `COPILOT_HOME`,
showed as `"selectedModel":"gpt-5-mini"` in `session.start` and
`"currentModel": "gpt-5-mini"` in the usage file.

## Limits

- Which model Copilot falls back to where `COPILOT_MODEL` is unset and the user
  has no `model` setting was not run. An idle interactive Copilot does not show
  it.
- The `--model` refusal was seen for a model name that does not exist. A real
  model the user's plan does not include was not tried.
- The variable seen crossing a pane's command line was `COPILOT_ALLOW_ALL`, not
  `COPILOT_MODEL` (unverified for `COPILOT_MODEL`).
