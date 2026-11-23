---
settles: "§ 5 The pi adapter: where a pi round's cost is read and how it is summed; § 8 The review budget: the cost a killed pi round records"
issue: [12, 21]
recorded: 2026-09-12
versions: { pi: "0.84.2, 0.85.1", node: 24.15.0 }
recheck-when: pi upgrades, or an unmeasured API path is configured
---

# Cost arrives during a run

## Intent

- Whether cost arrives at the end of a run or during it.
- Which field carries the cost, and how many carry it.
- How a free round, a model the price catalogue cannot price, and a run that
  never reached the provider are told apart.
- Whether any of this belongs to `pi` or to the API path underneath it.

## Decisions

- **Sum a round's cost over its assistant messages.** Cost arrives with each
  assistant `message_end`, and no event carries a run total, so the adapter does
  the addition. The extension writes each assistant message's usage to the
  report file as the message ends.
- **Record a killed round's cost as a floor.** The tokens of the request in
  flight are spent, billed and never reported.
- **Read cost only at `message_end`.** What `message_update` holds depends on
  the API path, and on one of the two measured it holds zero for the whole of
  the message. `turn_end` and `agent_end` repeat messages already counted.
- **Record tokens and dollars both, and read zero dollars against non-zero
  tokens as unpriced, not free.** `pi` prices from its own catalogue, and a
  model the catalogue lacks reports zero dollars against real spend. Both
  providers measured, on two API paths, reported cost, so this is `pi`'s
  behaviour rather than a provider's, and an unpriced model is a configuration a
  user can meet.
- **Read `stopReason` as well as the usage.** A provider that never ran reports
  zero for every usage field, so cost and tokens alone cannot tell a failed
  round from a free one.

## Needs your input

Nothing.

## Reference

### The field

| | |
|---|---|
| **Event** | `message_end`, where `message.role` is `"assistant"` |
| **Field** | `message.usage.cost.total` |
| **Type** | number |
| **Units** | US dollars, already priced, not tokens |
| **A round's cost** | the sum of that field over every assistant `message_end` |

`message.usage` also carries `input`, `output`, `cacheRead`, `cacheWrite`,
`reasoning` and `totalTokens` as integer token counts, and dollars under
`message.usage.cost` as `input`, `output`, `cacheRead`, `cacheWrite` and
`total`. There is no `reasoning` key under `cost`.

- **Only assistant messages carry `usage`.** `message_end` also fires for the
  `user` message and every `toolResult` message, with no `usage` key.
- **`turn_end` repeats the turn's last assistant message, cost included.**
  Summing both double-counts.
- **`agent_end` carries the whole transcript** in `agent_end.messages[]`, each
  with its own cost. It is the largest line in the stream.
- **On `message_update` the usage is at the event's top level**, as `usage`,
  and the event has no `message` key.

### API paths

`pi` names the path on every assistant message, as `message.api`.

| `message.api` | Where a non-zero cost first appears |
|---|---|
| `openai-completions` | the last `message_update`, 0.2 to 1.5 ms before `message_end` |
| `openai-responses` | `message_end` itself, in 14 messages of 15 |
| `azure-openai-responses` | the same as `openai-responses` (unverified: it shares `processResponsesStream`) |
| `anthropic-messages` | seconds before `message_end` (unverified: read from `pi-ai`'s source, which prices at the SSE `message_start`) |

### A provider that cannot run

A provider `pi` reached and could not use fails inside the stream: `pi` exits
0, writes nothing to stderr, and emits a complete assistant message whose
`stopReason` is `"error"` and whose `errorMessage` holds the reason. A provider
`pi` never got as far as using makes it exit non-zero with the explanation on
stderr alone. Every usage field is zero either way, `totalTokens` included.

`pi auth check --provider <name> --json` reports `{"status":"ready"}` on a
stored key alone, so it does not show that the provider can be reached.

### Prices

`pi` prices each message in `pi-ai`'s `models.js`, as
`(rate / 1_000_000) * tokens` for each of input, output, cache read and cache
write, with rates from its catalogue at `~/.pi/agent/models-store.json`. The
catalogue refreshes itself, so a dollar figure is whatever it holds when the
round runs. Several models carry a `tiers` array that raises every rate above a
threshold, such as 272,000 input tokens.

`usage.reasoning` is a subset of `usage.output`, and `totalTokens` is
`input + output`. `calculateCost` has no reasoning rate, so reasoning is billed
at the output rate.

### A killed run

`SIGTERM` makes `pi` kill its tracked children and exit 143, with nothing
printed after the signal. A kill before the first assistant message finishes
recovers nothing. After that it recovers only the messages already complete. No
file on disk holds the rest: with `--no-session`, `pi` wrote nothing under
`--session-dir` or `~/.pi`.

## Limits

- **`anthropic-messages` and `azure-openai-responses` were never run.** No
  credential for either exists here.
- **Whether a provider bills reasoning apart from output.** Both measured paths
  fold it into output. One that billed it apart would be under-priced, with
  nothing in the stream to show it.
- **No tiered round was observed.** The threshold was read from the catalogue
  and from `calculateCost`.
- **Only `SIGTERM` was tested, and only at 0.84.2.** `SIGKILL` denies `pi` its
  handler, so it can only recover less.
- **That an aborted request is billed** is ordinary streaming-API behaviour,
  not confirmed against an invoice.
