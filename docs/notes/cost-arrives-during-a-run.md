---
settles: "§ 8 — whether pi reports cost during a run"
issue: [12, 21]
recorded: 2026-09-12
versions: { pi: "0.84.2, 0.85.1", node: 24.15.0 }
recheck-when: pi upgrades, or a non-openai-completions API path is configured
---

# Cost arrives during a run

`pi` reports cost during a run, not at the end of it. A final, non-zero cost
lands on every assistant message, and a run produces several; the run's cost is
their sum, which is only complete when the process exits. § 8 asks this question
and answers it the other way, saying the cost bound "holds only if cost arrives
at the end", so the premise is wrong even though the design it defends still
works. A killed round therefore yields a cost floor rather than nothing.

## Decisions

- **Cost arrives per assistant message, not at the end of the run.** A round's
  cost is the sum over assistant `message_end` events; there is no run-total
  event, so the adapter does the addition.
- **A killed round yields a floor, not a figure.** The tokens of the request in
  flight are spent, billed, and never reported.
- **A zero cost is not proof of a free round.** `pi` prices runs from its own
  catalog, so an unpriced model reports zero cost against non-zero tokens.
  Treat that as unknown, and keep both fields in the episode state file.
- **A provider that never ran also reports zero.** Cost and tokens are both
  zero, exit status is 0 and stderr is empty; the only signal is a
  `stopReason` of `"error"` on the assistant message. The adapter reads that
  field, because cost and tokens alone cannot tell a failed round from a free
  one.

## Needs your input

**A credential or a setting, for whichever of the two unmeasured API paths you
want closed.** Both are blocked on something only you can supply, and neither
blocks M5.

- **`anthropic-messages` needs an Anthropic key.** None is configured here. This
  is the path whose source says cost is priced *seconds* earlier in a message,
  and it is the only one where the timing could differ enough to matter.
- **`azure-openai-responses` needs an endpoint.** The key is configured and
  `pi auth check` reports the provider ready, but no base URL is set, so every
  request fails before it is sent. `AZURE_OPENAI_BASE_URL` or
  `AZURE_OPENAI_RESOURCE_NAME` in the environment is enough.

Recommended: supply the Anthropic key and leave Azure alone. Azure is a third
API path that prices cost at the end of a message like the one already
measured, so closing it would confirm what is already the expected answer.

Also for you: **§ 2's Verified against table records `pi` 0.84.2.** Everything
measured since is 0.85.1, and the two agree wherever both were run.

The four consequences for the specification raised by the original work are all
settled, in § 4, § 5, § 7 and § 8:

- The cost bound stops the next round and never kills a running one. A mid-round
  bound is technically available and is not taken, because killing a run loses
  its findings and recovers only the tail of one round's cost. § 8's premise that
  the bound "holds only if cost arrives at the end" was false and is gone.
- A round the time bound killed records its **last tracked cost** — the cost of
  the assistant messages that completed — and the episode's total counts it. The
  message in flight is spent and never reported, so the figure understates and is
  labelled as what it is rather than as the round's cost.
- The two situations that report no cost at all are named separately. A round
  killed before its first assistant message completed is a fact about that round.
  A model the price catalogue does not cover is a setup problem, reported once,
  with the summary recording that the cost bound could not be enforced.
- The adapter sums every assistant `message_end` rather than reading the last
  one, and returns the token count beside the cost.

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
`cacheWrite`, `reasoning` and `totalTokens` as integer token counts, and a
four-way breakdown in dollars under `message.usage.cost` — `input`, `output`,
`cacheRead`, `cacheWrite`, `total`. There is no `reasoning` key under `cost`.

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
so reading `message_end` loses nothing. The gap between the two is **0.3–1.5
milliseconds** across fourteen assistant messages, against messages lasting
0.6–1.4 seconds: cost is effectively part of `message_end`, and no adapter can
usefully act on the earlier event. On `message_update` the usage sits at the
event's top level, as `usage`, not under `message` — that event carries no
`message` key at all.

### Which API path a provider takes

The timing belongs to the API path, not to the provider or the model. `pi`
names the path on every assistant message, as `message.api`, which is what
identifies it in output rather than in the source.

| `message.api` | Priced at | Measured |
|---|---|---|
| `openai-completions` | the final SSE chunk | Yes — `deepseek-v4-pro`, `deepseek-flash` |
| `azure-openai-responses` | the terminal response event | No *(unverified)* |
| `anthropic-messages` | the SSE `message_start`, then again on each usage update | No *(unverified)* |

`azure-openai-responses` is a third path, not the plain OpenAI one. It has its
own `dist/api/azure-openai-responses.js` and shares a stream processor with the
OpenAI Responses path, which prices the message in its `finalizeResponse` —
the end of the message, as `openai-completions` does. Only `anthropic-messages`
prices at the start.

### A provider that cannot run

A misconfigured provider fails inside the stream rather than around it. `pi`
exits 0, writes nothing to stderr, and emits a complete assistant message whose
`stopReason` is `"error"` and whose `errorMessage` holds the reason. Every usage
field on it is zero, `totalTokens` included, so it is indistinguishable by cost
from both a free round and a round `pi` could not price.

`pi auth check --provider <name> --json` reports `{"status":"ready"}` on the
strength of a stored key alone. It does not establish that the provider can be
reached, so it is not a substitute for a run.

§ 7's failure table gives "the model API is unavailable" a behaviour of stderr
saying the review did not run. `pi`'s stderr is empty in this case, so the
harness has to construct that message from `stopReason` itself.

### The dollars are `pi`'s arithmetic, not the provider's

`pi` prices the run itself in `pi-ai`'s `models.js`, as
`(rate / 1_000_000) * tokens` for each of input, output, cache read and cache
write, with rates from its own catalog at `~/.pi/agent/models-store.json`.

**The catalog refreshes itself, so a rate read from it is a current value
rather than a fixed one.** `deepseek-v4-pro` was recorded at 0.435 input and
0.87 output per million tokens on 2026-09-06; on 2026-09-12 the catalog held
1.32 and 3.96, and the observed per-message costs divide out to the later pair.
The cost bound is enforced against whatever the catalog holds when the round
runs, which need not be what a person read when they chose the bound.

So **a model the catalog does not price yields `cost.total: 0` against a
non-zero `totalTokens`**, indistinguishable from a genuinely free round if only
the cost is read. Treat `totalTokens > 0` with `cost.total === 0` as unknown.
Both fields belong in the episode state file for that check to be possible.

### A killed run

`SIGTERM` — what a time bound would send — makes `pi` kill its tracked children
and exit 143. It prints nothing after the signal and leaves no partial line.

A kill before the first assistant message finishes recovers **nothing** — every
usage field reads zero, `totalTokens` included. After that, it recovers only the
messages already complete: on the same prompt, a kill recovered $0.000224 of the
$0.004059 the finished run reported. The in-flight request's tokens are spent,
billed, and never reported.

Nothing on disk fills the gap: with `--no-session`, `pi` wrote no file under
`--session-dir` and none appeared under `~/.pi`; stderr was empty in every run.
**The stdout stream is the only record of what a round cost.**

### Stream shape at 0.84.2 and 0.85.1

Three things were re-checked at 0.85.1 and matched 0.84.2 exactly: where the
cost first appears and how long before `message_end`, the usage fields and their
names, and which events are the large ones.

`message_update` no longer repeats the whole partial message — `dist/modes/json-event.js`
strips `partial` and emits the delta plus a constant-size `usage`, so those
events are small. § 4's "194MB across roughly 19,800 lines, of which all but a
few hundred were `message_update` events repeating the whole partial message"
was 0.74.2's behaviour.

The bulk now sits in the message-carrying events — `agent_end`, `turn_end`,
`message_start`, `message_end` and `tool_execution_end` — which carry whole
messages including tool output and run to tens of kilobytes each. Read
incrementally and hold nothing, but the line that must not be held is now
`agent_end`, not `message_update`.

## Limits

- **Whether another API path reports cost mid-message.** Only
  `openai-completions` has been run, on two models. `pi-ai`'s Anthropic path
  populates and prices usage at the SSE `message_start`, which would put a real
  cost *seconds* before `message_end` *(unverified — read from `pi`'s source,
  never observed in output)*. That claim is exactly as unverified as it was: no
  Anthropic credential exists here, and the second provider that does exist,
  `azure-openai-responses`, is a third path rather than the Anthropic one. It
  strengthens the conclusion rather than weakening it either way, because a
  cost that arrives earlier still arrives during the run.
- **`SIGKILL`.** Only `SIGTERM` was tested. `SIGKILL` denies `pi` its handler, so
  it can only recover less.
- **What a killed run recovers at 0.85.1.** The kill behaviour was measured at
  0.84.2 only. What was re-checked at 0.85.1 is the stream shape, not the
  signal handling.
- **A review-sized run.** Probes lasted 2–8 seconds over 108–366 lines. A
  420-second review makes the sum longer, not different in kind.
- **Whether an aborted request is billed.** That in-flight tokens are paid for is
  ordinary streaming-API behaviour, not confirmed against an invoice.
