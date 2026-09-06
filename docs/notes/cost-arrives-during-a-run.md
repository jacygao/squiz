---
settles: "§ 8 — whether pi reports cost during a run"
issue: 12
recorded: 2026-09-06
versions: { pi: 0.84.2, node: 24.15.0 }
recheck-when: pi upgrades, or a provider other than deepseek is configured
---

# Cost arrives during a run

`pi` reports cost during a run, not at the end of it. A final, non-zero cost
lands on every assistant message, and a run produces several; the run's cost is
their sum, which is only complete when the process exits. § 8 asks this question
and answers it the other way, saying the cost bound "holds only if cost arrives
at the end", so the premise is wrong even though the design it defends still
works. A killed round therefore yields a cost floor rather than nothing.

## Needs a decision

- **§ 8's premise is wrong; the design it defends is still sound.** A bound
  checked when a round records its cost, stopping the next round, remains
  implementable — it is now a choice rather than a consequence. A **mid-round
  bound is newly available**: an adapter summing assistant `message_end` costs as
  they stream could kill the reviewer the moment the total crosses $0.10.
- **§ 7 needs a third state for a killed round.** "Killing the reviewer yields
  nothing rather than a partial review" holds for *findings*, which are in the
  final assistant message. It does not hold for cost, which is partial and
  understated — neither the round's cost nor unknown. Recommended, if the current
  design is kept: record the recovered figure as a lower bound, report it as
  such, and have the episode bound treat it as at least that much. Reporting it
  as the round's cost understates the episode; reporting zero is worse.
- **§ 5's "unknown rather than zero" rule now has two triggers, not one.** A
  round killed before its first assistant message finished (every usage field
  zero), and a model the price catalog does not cover (zero cost, non-zero
  tokens). The rule itself is right as written.
- **§ 4's description of the stream is version-drifted.** See Reference; the
  event named there as the one never to hold in memory has changed.

## Reference

### The field

| | |
|---|---|
| **Event** | `message_end`, where `message.role` is `"assistant"` |
| **Field** | `message.usage.cost.total` |
| **Type** | number |
| **Units** | US dollars, already priced — not tokens |
| **A round's cost** | the sum of that field over every assistant `message_end` |

Alongside it, `message.usage` carries `input`, `output`, `cacheRead`,
`cacheWrite` and `totalTokens` as integer token counts, and the same four-way
breakdown in dollars under `message.usage.cost`.

Three rules go with reading it:

- **Only assistant messages carry `usage` at all.** `message_end` also fires for
  the `user` message and for every `toolResult` message; on those the `message`
  object has no `usage` key. Filtering on `usage` and on `role === "assistant"`
  are equivalent.
- **`turn_end` repeats the turn's last assistant message, cost included.**
  `turn_end.message.usage.cost.total` was identical to the last assistant
  `message_end` of that turn in every run. Summing both double-counts.
- **`agent_end` carries the whole transcript**, each assistant message in
  `agent_end.messages[]` with its own `usage.cost.total`. Summing those matches
  summing `message_end` to the cent, but it is the wrong place to read from: it
  grows with the transcript and was the largest line in the stream.

There is **no run-total event**. Neither `agent_end` nor `agent_settled` carries
an aggregate. The adapter does the addition.

Cost becomes non-zero on the last `message_update` before each `message_end`,
leading it by 0.3–1.4 ms. Reading `message_end` loses nothing.

### The dollars are `pi`'s arithmetic, not the provider's

`pi` prices the run itself in `pi-ai`'s `models.js`, as
`(rate / 1_000_000) * tokens` for each of input, output, cache read and cache
write, with rates from its own catalog at `~/.pi/agent/models-store.json`
(`deepseek-v4-pro`: 0.435 input, 0.87 output per million tokens).

So **a model the catalog does not price yields `cost.total: 0` against a
non-zero `totalTokens`**, indistinguishable from a genuinely free round if only
the cost is read. Treat `totalTokens > 0` with `cost.total === 0` as unknown.
Both fields belong in the episode state file for that check to be possible.

### A killed run

`SIGTERM` — what a time bound would send — makes `pi` kill its tracked children
and exit 143. It prints nothing after the signal and leaves no partial line.

| Killed | Assistant messages completed | Cost recoverable |
|---|---|---|
| 2007 ms, mid first message | 0 | **None.** Every usage field zero, `totalTokens` included |
| 4503 ms, after one message | 1 | $0.000224 |
| not killed, same prompt | 2 | $0.004059 |

The last two ran the same prompt, so the kill recovered $0.000224 of $0.004059.
The in-flight request's tokens are spent, billed, and never reported.

Nothing on disk fills the gap: with `--no-session`, `pi` wrote no file under
`--session-dir` and none appeared under `~/.pi`; stderr was empty in every run.
**The stdout stream is the only record of what a round cost.**

### Stream shape at 0.84.2

`message_update` no longer repeats the whole partial message — `dist/modes/json-event.js`
strips `partial` and emits the delta plus a constant-size `usage`. Those events
averaged 254 bytes and peaked at 1,196 across 337 of them. § 4's "194MB across
roughly 19,800 lines, of which all but a few hundred were `message_update`
events repeating the whole partial message" was 0.74.2's behaviour.

The bulk now sits in the message-carrying events: `agent_end`, `turn_end`,
`message_start`, `message_end` and `tool_execution_end` were the five largest
lines at 34–39KB each, since they carry whole messages including tool output.
Read incrementally and hold nothing — but the line that must not be held is now
`agent_end`, not `message_update`.

## Limits

- **Whether another provider reports cost mid-message.** Only `deepseek` is
  authenticated here, so only the OpenAI-completions path was exercised, which
  receives usage in the final SSE chunk. `pi-ai`'s Anthropic path populates and
  prices usage at the SSE `message_start`, putting a real cost *seconds* before
  `message_end` rather than a millisecond. Read from source, not measured. It
  strengthens the conclusion rather than weakening it.
- **`SIGKILL`.** Only `SIGTERM` was tested. `SIGKILL` denies `pi` its handler, so
  it can only recover less.
- **A review-sized run.** Probes lasted 2–8 seconds over 108–366 lines. A
  420-second review makes the sum longer, not different in kind.
- **Whether an aborted request is billed.** That in-flight tokens are paid for is
  ordinary streaming-API behaviour, not confirmed against an invoice.
