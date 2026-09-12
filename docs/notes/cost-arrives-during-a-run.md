---
settles: "§ 8 — whether pi reports cost during a run"
issue: [12, 21]
recorded: 2026-09-12
versions: { pi: "0.84.2, 0.85.1", node: 24.15.0 }
recheck-when: pi upgrades, or an unmeasured API path is configured
---

# Cost arrives during a run

`pi` reports cost during a run, not at the end of it. A final, non-zero cost
lands on every assistant message, and a run produces several; the run's cost is
their sum, which is only complete when the process exits. § 8 asked this
question and answered it the other way, saying the cost bound "holds only if
cost arrives at the end"; that premise was wrong, the design it defended still
works, and the sentence has since gone from the spec. A killed round therefore
yields a cost floor rather than nothing.

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

**An Anthropic key, if you want the last interesting path closed.** Two of the
four paths are measured and agree. Of the two that are not, only
`anthropic-messages` could behave differently, and no Anthropic credential is
configured here. It does not block M5: the conclusion holds whichever way it
goes, because a cost that arrives earlier still arrives during the run.

Not worth your time: **`azure-openai-responses` needs an endpoint** —
`AZURE_OPENAI_BASE_URL` or `AZURE_OPENAI_RESOURCE_NAME` — and runs the same
stream processor as the `openai-responses` path already measured. `pi auth
check` reports it ready on the strength of its stored key, which is why it
looks available when it is not.

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

**`message_end` is the only event to read the cost from.** What `message_update`
holds depends on the API path, and on one of the two measured it holds zero for
the whole of the message.

On `message_update` the usage sits at the event's top level, as `usage`, not
under `message` — that event carries no `message` key at all.

### Which API path a provider takes

The timing belongs to the API path, not to the provider or the model. `pi`
names the path on every assistant message, as `message.api`, which is what
identifies it in output rather than in the source.

| `message.api` | Priced at | Where a non-zero cost first appears |
|---|---|---|
| `openai-completions` | the final SSE chunk | the last `message_update`, 0.2–1.5 ms before `message_end` |
| `openai-responses` | the terminal response event | `message_end` itself, in 14 messages of 15 |
| `azure-openai-responses` | the terminal response event | *(unverified)* — same stream processor as `openai-responses` |
| `anthropic-messages` | the SSE `message_start`, then again on each usage update | *(unverified)* — would be seconds before `message_end` |

Both measured paths price at the end of a message. They differ in whether
anything earlier shows it, and that difference is what makes `message_end` the
only field worth reading:

- On `openai-completions` the last `message_update` reliably carries the final
  cost, **0.2–1.5 milliseconds** ahead of `message_end` across seventeen
  assistant messages lasting 0.6–1.4 seconds each — too little to act on.
- On `openai-responses` it usually carries **zero**. The last `message_update`
  arrives 3–174 ms before `message_end` and is emitted before the response is
  finalised, so the cost is not in it yet. One message in fifteen showed a cost
  on an update, 0.5 ms early; the other fourteen showed it first at
  `message_end`. Which side of the finalisation the last update falls on is a
  race.

So an adapter that reads `message_update` for cost recovers everything on one
path and almost nothing on the other. Reading `message_end` is correct on both.

`azure-openai-responses` and `openai-responses` are separate paths with separate
modules, but they share `processResponsesStream`, which prices the message in
its `finalizeResponse`. Azure is therefore the least informative of the two
unverified rows: closing it would exercise code already exercised.

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

A model's rate is also not always a single number. Several carry a `tiers` array
that raises every rate above a threshold — 272,000 input tokens, roughly
doubling them. A long review can cross that line mid-episode.

So **a model the catalog does not price yields `cost.total: 0` against a
non-zero `totalTokens`**, indistinguishable from a genuinely free round if only
the cost is read. Treat `totalTokens > 0` with `cost.total === 0` as unknown.
Both fields belong in the episode state file for that check to be possible.

### Reasoning tokens are priced, and are not a new zero-cost case

`usage.reasoning` is a **subset of `usage.output`**, not an addition to it. On a
reasoning model it dominates: 832 of 903 output tokens on one message, 192 of
227 on another. `totalTokens` is `input + output`, with reasoning already inside
`output` and never counted twice.

`calculateCost` has no reasoning rate. It prices `input`, `output`, `cacheRead`
and `cacheWrite` and nothing else, so reasoning is billed at the output rate by
virtue of sitting inside the output count. The arithmetic checks out: every
observed `cost.output` equals `output × rate ÷ 1,000,000` exactly, reasoning
tokens included.

A reasoning model therefore **does not** report tokens that carry no cost. The
worry is real for a provider that bills reasoning separately rather than folding
it into output, because `pi` has nowhere to put such a rate and would silently
under-price the round — but no measured path does that.

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

- **Whether `anthropic-messages` reports cost mid-message.** `pi-ai`'s Anthropic
  path populates and prices usage at the SSE `message_start`, which would put a
  real cost *seconds* before `message_end` *(unverified — read from `pi`'s
  source, never observed in output)*. No Anthropic credential exists here, so
  it is as unverified as it ever was. It strengthens the conclusion rather than
  weakening it either way, because a cost that arrives earlier still arrives
  during the run.
- **Whether a provider that bills reasoning separately exists.** Both measured
  paths fold reasoning into the output token count, where the output rate
  prices it. `calculateCost` has no rate for reasoning, so a provider that
  billed it apart from output would be under-priced with nothing in the stream
  to show it.
- **Tiered rates in practice.** That `tiers` raises the rate above 272,000 input
  tokens was read from the catalog and from `calculateCost`. No probe came close
  to the threshold, so no tiered round was observed.
- **`SIGKILL`.** Only `SIGTERM` was tested. `SIGKILL` denies `pi` its handler, so
  it can only recover less.
- **What a killed run recovers at 0.85.1.** The kill behaviour was measured at
  0.84.2 only. What was re-checked at 0.85.1 is the stream shape, not the
  signal handling.
- **A review-sized run.** Probes lasted 2–8 seconds over 108–366 lines. A
  420-second review makes the sum longer, not different in kind.
- **Whether an aborted request is billed.** That in-flight tokens are paid for is
  ordinary streaming-API behaviour, not confirmed against an invoice.
