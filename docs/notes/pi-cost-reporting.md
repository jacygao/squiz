# When `pi` reports the cost of a run

`pi` reports cost **during** a run, not only at the end of it. A cost figure is
final and non-zero on every assistant message the run produces, and a run
produces one such message per turn. The run's cost is the sum of them, and that
sum is only complete when the process exits, because nothing in the stream says
how many more assistant messages are still to come.

This contradicts the premise written into § 8 of the specification, which asks
"whether `pi` reports cost during a run or only at the end" and says the cost
bound "holds only if cost arrives at the end". What follows sets out what was
measured, what it means for § 5 and § 7, and what was not determined. **The
specification has not been edited.** Reconciling it is a separate decision.

## The field, named exactly

| | |
|---|---|
| **Event** | `message_end`, where `message.role` is `"assistant"` |
| **Field** | `message.usage.cost.total` |
| **Type** | number |
| **Units** | US dollars, already priced — not tokens |
| **A round's cost** | the sum of that field over every assistant `message_end` in the run |

Alongside it, `message.usage` carries `input`, `output`, `cacheRead`,
`cacheWrite`, `totalTokens` (integers, token counts) and the same breakdown in
dollars under `message.usage.cost` as `input`, `output`, `cacheRead`,
`cacheWrite`.

Three rules go with reading it:

- **Only assistant messages carry `usage` at all.** `message_end` also fires for
  the `user` message and for every `toolResult` message, and on those the
  `message` object has no `usage` key whatsoever. Filtering on the presence of
  `usage` and on `role === "assistant"` are equivalent here.
- **`turn_end` repeats the turn's last assistant message, cost included.** In
  every run measured, `turn_end.message.usage.cost.total` was identical to the
  cost on the last assistant `message_end` of that turn. Summing both events
  double-counts.
- **`agent_end` carries the whole transcript**, and each assistant message in
  `agent_end.messages[]` carries its own `usage.cost.total`. Summing those gives
  the same total as summing `message_end` — confirmed to the cent on both
  complete runs. It is the wrong place to read it from anyway: in both runs that
  reached it, `agent_end` was the largest line in the stream, and it grows with
  the whole transcript — 3KB in the four-second probe and 39KB in the
  eight-second one. Assistant `message_end` lines are bounded by the assistant's
  own reply.

There is **no run-total event**. Neither `agent_end` nor `agent_settled` carries
an aggregate usage or cost figure. The adapter has to do the addition.

### The dollars are `pi`'s arithmetic, not the provider's

`pi` computes the cost itself, in `pi-ai`'s `models.js`, as
`(rate / 1_000_000) * tokens` for each of input, output, cache read and cache
write, with the rates coming from its model catalog. The catalog for the model
used here lives in `~/.pi/agent/models-store.json` and prices
`deepseek-v4-pro` at 0.435 input and 0.87 output per million tokens.

The consequence matters for § 5. **A model the catalog does not price yields
`cost.total: 0` with a non-zero `totalTokens`**, and that zero is
indistinguishable from a genuinely free round if only the cost is read. The
adapter should treat a round with `totalTokens > 0` and `cost.total === 0` as
*unknown*, which is what § 5 already says to report where the CLI reports no
cost. Reading `totalTokens` alongside the cost is what makes that check
possible, so both belong in the episode state file.

## What was measured

Four runs of the command line from § 4, against the working tree of this
repository:

```
pi --print --mode json --no-session --session-dir <scratch>/<label>.session \
   --tools read,grep,find,ls,bash \
   --append-system-prompt <charter> <prompt>
```

stdin was `/dev/null` in every run, as § 4 requires; the probe opened
`/dev/null` and handed it to the child as fd 0, which is what the shell's
`< /dev/null` does. Every run also had a hard `SIGKILL` timeout, and none of
them reached it.

| | |
|---|---|
| `pi` | **0.84.2** (the specification's Verified against table records 0.74.2) |
| Runtime | Node v24.15.0; `pi` is a Node script, not a Bun binary |
| Provider and model | `deepseek` / `deepseek-v4-pro`, thinking level `high` — the machine's configured default |
| Platform | macOS (darwin 25.6.0) |

The stream was read as it arrived. The probe spawned `pi` with a pipe on
stdout, stamped every `read()` chunk with the elapsed time at the moment it
arrived, split lines out of the chunks, and gave each line the arrival time of
the chunk that completed it. Raw bytes went straight to a file for later
independent checking; only the event type and the cost-bearing fields were kept
in memory, one line at a time.

### Cost becomes non-zero at the end of each assistant message

The `usage` object is present on `message_update` events as well, but for this
provider its value stays at zero for the whole of the message and only becomes
real on the last update before `message_end`.

| Run | Assistant message | `message_start` | First non-zero cost | `message_end` | Lead |
|---|---|---|---|---|---|
| full | 1 | 867.0ms | 2635.2ms (`message_update` / `toolcall_end`) | 2635.5ms | 0.3ms |
| full | 2 | 2969.1ms | 3954.7ms (`message_update` / `text_end`) | 3955.0ms | 0.3ms |
| kill_mid | 1 | 888.2ms | 3290.8ms (`message_update` / `thinking_end`) | 3292.2ms | 1.4ms |
| kill_late | 1 | 757.2ms | 3207.9ms (`message_update` / `thinking_end`) | 3209.2ms | 1.3ms |
| kill_late | 2 | 3781.0ms | 7882.4ms (`message_update` / `text_end`) | 7882.9ms | 0.5ms |

Of the 83 `message_update` events in the `full` run, exactly three carried a
non-zero cost, and each was the final update of its message. So the honest
statement is narrower than "cost streams continuously": **cost arrives once per
assistant message, at that message's end, and a run has several.** Reading it
from `message_end` loses nothing, and is a millisecond behind the earliest
possible read.

That last-millisecond behaviour belongs to the provider, not to `pi`. The
OpenAI-completions API path only receives usage in the final chunk of the SSE
stream. `pi-ai`'s Anthropic path assigns usage and calls `calculateCost` at the
SSE `message_start`, at the *beginning* of the assistant message. With an
Anthropic model, a non-zero cost would therefore appear seconds before its
`message_end`, not a millisecond. That was read from the source and not
measured; see What was not determined.

## What a killed run yields

Each kill was a `SIGTERM` to the `pi` process, which is what a time bound would
send. `pi` installs a `SIGTERM` handler, kills its own tracked children, and
exits 143. It printed nothing after the signal, and no partial line was left
dangling in any run.

| Run | Killed at | Assistant messages completed | Cost recoverable |
|---|---|---|---|
| kill_early | 2007ms, mid-stream in the first assistant message | 0 | **None.** Every `usage` field seen was zero, including `totalTokens` |
| kill_mid | 4503ms, after one message, mid-stream in the second | 1 | $0.000224 — real, but only the first message's |
| kill_late | not reached; the run finished at 7909ms | 2 | $0.004059, the whole run |

`kill_mid` and `kill_late` ran the same prompt, so their numbers are comparable:
the kill recovered $0.000224 of what the same work reported as $0.004059 when
allowed to finish. A killed round therefore yields **a floor, not a figure**.
The tokens of the request that was in flight when the signal landed were spent
and are billed by the provider, and `pi` never reports them — the work is paid
for and unaccounted.

Nothing else on disk fills the gap. With `--no-session`, `pi` created no file at
all under `--session-dir`, and no session appeared under `~/.pi` during any of
the runs. stderr was empty in all four. **The stdout stream is the only record
of what a round cost, and killing the process truncates it.**

## What this means for the specification

**§ 8 Prerequisites.** The premise is wrong as written. Cost does not arrive
only at the end; it arrives at each assistant message boundary. The design that
premise was defending — a bound checked when a round records its cost, stopping
the next round — is still perfectly implementable, but it is now a choice rather
than a consequence. A mid-round bound is technically available: an adapter
summing assistant `message_end` costs as they stream could kill the reviewer the
moment the running total crosses $0.10.

**§ 7 The review budget.** "Killing the reviewer yields nothing rather than a
partial review, because the findings arrive at the end of the run" is still true
*about findings* — they are in the final assistant message, and killing the run
loses them. It is not true about cost. A killed round has a partial, understated
cost, which is a third state the specification does not currently have a word
for: not the round's cost, and not unknown either.

Recommended resolution, if the current design is kept: a round killed by the
time bound records its recovered cost as a lower bound and is reported as such,
and the episode's bound treats it as at least that much. Reporting it as the
round's cost understates the episode; reporting it as zero is worse.

**§ 5 The summary.** "Where the reviewer's CLI reports no cost for a round, the
comment gives that round's cost as unknown rather than as zero" is the right
rule and now has two distinct triggers rather than one: a round killed before
its first assistant message finished, which reports zero for every usage field;
and a model the price catalog does not cover, which reports zero cost against
non-zero tokens.

**§ 4 The `pi` adapter.** Two facts drifted with the version. In 0.84.2 the
JSON writer strips the cumulative message snapshot out of `message_update`
before emitting it — `dist/modes/json-event.js` removes `partial` and keeps only
the delta plus the constant-size `usage` — so `message_update` events are small.
They averaged 254 bytes and peaked at 1,196 bytes across 337 of them. The
"194MB across roughly 19,800 lines, of which all but a few hundred were
`message_update` events repeating the whole partial message" was 0.74.2's
behaviour. The bulk now sits in the message-carrying events instead:
`agent_end`, `turn_end`, `message_start`, `message_end` and `tool_execution_end`
were the five largest lines of the `kill_late` run, at 34–39KB each, because
they carry whole messages including tool output. Reading the stream
incrementally and never holding it in memory is still the right instruction; the
line that must not be held in memory is now `agent_end`, not `message_update`.

## Why the measurement means what it claims

**The stream was observed live, not after the fact.** Every line has an arrival
timestamp taken when its chunk came off the pipe. The `full` run arrived in 87
separate chunks spread from 481ms to 3,957ms, with 77 distinct arrival times.

**Pipe buffering did not fake it.** Three things rule it out.

- Ordering across a pipe is preserved, so any claim of the form "X arrived
  before Y" is immune to buffering by construction. Buffering can only shift
  arrivals later in time; it cannot swap two events.
- The observed chunks are far too small and too spread out to be a buffer
  flushing. Chunks averaged 408 bytes, three were under 64 bytes, and the
  largest was 3KB — orders of magnitude below the pipe capacity that would have
  to fill before a block-buffered writer flushed. A 21-byte `turn_start` line
  arriving alone is not what batching looks like.
- `pi` writes each event as its own `process.stdout.write` and awaits the write
  callback before starting the next, in `dist/core/output-guard.js`. There is no
  application-level batching between events, and Node does not block-buffer pipe
  writes.

A control run confirmed the reader adds no batching of its own: a child writing
one 41-byte line every 300ms was seen as six separate chunks at 328, 624, 925,
1226, 1527 and 1828ms.

**"No cost before `message_end`" was not a filter artefact.** The claim being
made is the opposite one — cost *was* found early — but the filter was checked
anyway, in case it was hiding a second, earlier cost field. Every raw stream was
re-read afterwards by a separate script that walked each event's full JSON tree
and collected every key path matching `cost|price|usd|token|spend|bill|charge`,
without assuming any field name. Across all four runs the complete set of
cost-shaped key paths was `usage.cost.{input,output,cacheRead,cacheWrite,total}`
and `usage.totalTokens` on `message_update`, the same two under `message.usage`
on `message_start`, `message_end` and `turn_end`, and the same again under
`agent_end.messages[].usage`. There is no other cost-bearing field, under any
name, anywhere in the stream. Every line of all four runs parsed as JSON; none
was skipped.

The event types the `full` run emitted, which is the population the filter ran
over: `session` (1), `agent_start` (1), `turn_start` (2), `message_start` (5),
`message_update` (83), `message_end` (5), `tool_execution_start` (2),
`tool_execution_update` (3), `tool_execution_end` (2), `turn_end` (2),
`agent_end` (1), `agent_settled` (1) — 108 lines, 35KB.

## What was not determined

- **Whether another provider reports cost mid-message.** Only `deepseek` is
  authenticated on this machine, so only the OpenAI-completions path was
  exercised. `pi-ai`'s Anthropic path populates usage and prices it at the SSE
  `message_start`, which would put a real non-zero cost seconds earlier in the
  message rather than a millisecond. That is read from source, not measured. It
  strengthens rather than weakens the conclusion: cost arrives during a run.
- **`SIGKILL`.** Only `SIGTERM` was tested. `SIGKILL` gives `pi` no chance to
  run its handler, so it can only lose more, never less.
- **A real review-sized run.** The probes lasted 2–8 seconds and produced
  108–366 lines. A 420-second review will produce far more assistant messages,
  which makes the sum over `message_end` longer but not different in kind.
- **Whether an aborted request is billed by the provider.** The statement above
  that the in-flight tokens are paid for is the ordinary billing behaviour of a
  streaming API; it was not confirmed against a DeepSeek invoice.

## Cost of establishing this

`pi` reported $0.005366 in total across the four runs: $0.001083, $0.000000,
$0.000224 and $0.004059. The two killed runs each abandoned a request in flight
whose tokens `pi` never reported; judging by the same prompt's completed run,
that adds at most another $0.005. **Under $0.02 for the whole investigation**,
against the $0.10 per-episode budget.

## Re-running this

The probe script is throwaway and is **not committed**. It lived in the session
scratch directory and did the following, which is enough to rebuild it: spawn
`pi` with the § 4 command line and fd 0 on `/dev/null`, stamp each stdout chunk
with the elapsed time as it arrives, split lines out of the chunks, write the
raw bytes straight to a file, and keep only `type`, the
`assistantMessageEvent.type`, and `usage`/`usage.cost.total` per line. Take a
`--kill-after-ms` and send `SIGTERM` at that point to reproduce the killed runs.

Re-check the version drift with `pi --version`.
