---
settles: "§ 4 — what level a `pi` round runs at when the model does not offer the configured one; § 6 — how the setup check learns that level"
issue: 709
recorded: 2026-10-17
versions: { pi: 0.85.1, node: 24.15.0, macos: 26.6.2 }
recheck-when: pi upgrades, or pi's RPC commands or its thinking-level clamping change
---

# pi raises a level the model lacks, and RPC mode reports it without a request

## Intent

- What `pi` does with a `--thinking` level the model does not offer.
- How to learn the level a round runs at without spending a model request.

## Decisions

- **Ask `pi` in RPC mode for the level, rather than reading a round's session
  file.** `get_state` returns the level `pi` settled on and
  `get_available_thinking_levels` the levels the model offers. `pi` answers both
  before any prompt and exits once its stdin ends, so the answer costs no request
  and needs no earlier round.

- **Report the level, and do not refuse a level the model lacks.** Refusing
  `medium` would fail every round on the default setup with DeepSeek V4 Pro as
  the user's model, since `medium` is squiz's default.

## Needs your input

Nothing.

## Reference

`pi` moves a level the model does not offer to the first level above it that
the model offers, and to the nearest below where none is above. It prints
nothing on stderr when it does. The order is `off`, `minimal`, `low`, `medium`,
`high`, `xhigh`, `max`.

| Model | Offers | Asked | Runs at |
|---|---|---|---|
| `deepseek/deepseek-v4-pro` | off, high, max | low, medium | high |
| `deepseek/deepseek-v4-pro` | off, high, max | xhigh | max |
| `openai/gpt-5-mini` | minimal, low, medium, high | off | minimal |

The command and its input:

```
pi --mode rpc --no-session --no-approve --no-extensions --thinking medium [--model provider/id]
{"id":"levels","type":"get_available_thinking_levels"}
{"id":"state","type":"get_state"}
```

The answers, one JSON line each, matched by `id`:

```
{"id":"levels","type":"response","command":"get_available_thinking_levels","success":true,"data":{"levels":["off","high","max"]}}
{"id":"state","type":"response","command":"get_state","success":true,"data":{"model":{...},"thinkingLevel":"high",...}}
```

A model `pi` does not have exits 1 with
`Error: Model "nope/nothing" not found. Use --list-models to see available models.`
on stderr.

With no model in the user's settings and no credentials, `pi` reports a model
named `unknown` that offers only `off`, so the level says nothing about a round.

## Limits

- Measured on `deepseek/deepseek-v4-pro` and `openai/gpt-5-mini` only.
- Whether `pi` reaches the network while starting in RPC mode was not traced.
  Each run took under a second, and no prompt was sent.
- The Copilot CLI was not checked for the same behaviour with
  `--reasoning-effort`.
