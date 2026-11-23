---
settles: "§ 7: how the setup check learns the thinking level a `pi` round runs at"
issue: 709
recorded: 2026-10-17
versions: { pi: 0.85.1, node: 24.15.0, macos: 26.6.2 }
recheck-when: pi upgrades, or pi's RPC commands change
---

# `pi` in RPC mode reports the thinking level without a request

## Intent

- How to learn the level a round runs at without spending a model request.

## Decisions

- **Ask `pi` in RPC mode for the level, rather than reading a round's session
  file.** `get_state` returns the level `pi` settled on, and
  `get_available_thinking_levels` the levels the model offers. `pi` answers both
  before any prompt and exits once its stdin ends, so the answer costs no
  request and needs no earlier round.

## Needs your input

Nothing.

## Reference

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

A model `pi` does not have exits 1 with this on stderr:

```
Error: Model "nope/nothing" not found. Use --list-models to see available models.
```

With no model in the user's settings and no credentials, `pi` reports a model
named `unknown` that offers only `off`, so the level says nothing about a round.

## Limits

- **Measured on `deepseek/deepseek-v4-pro` and `openai/gpt-5-mini` only.**
- **Whether `pi` reaches the network while starting in RPC mode was not
  traced.** Each run took under a second, and no prompt was sent.
