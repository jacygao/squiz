---
settles: "§ 5: what level a `pi` round runs at when the model does not offer the configured one; § 7: why the setup check warns rather than fails on it"
issue: 709
recorded: 2026-10-17
versions: { pi: 0.85.1, node: 24.15.0, macos: 26.6.2 }
recheck-when: pi upgrades, or pi's thinking-level clamping changes
---

# `pi` runs a level the model lacks at the next one it offers

## Intent

- What `pi` does with a `--thinking` level the model does not offer.

## Decisions

- **Report the level a round runs at, and do not refuse a level the model
  lacks.** `pi` runs the round at another level and says nothing. Refusing
  `medium`, squiz's default, would fail every round on the default setup for a
  user whose model is DeepSeek V4 Pro, so `squiz doctor` warns instead, naming
  the configured level, the level it runs at and the levels the model offers.

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

## Limits

- **Measured on `deepseek/deepseek-v4-pro` and `openai/gpt-5-mini` only.**
- **The Copilot CLI was not checked** for the same behaviour with
  `--reasoning-effort`.
