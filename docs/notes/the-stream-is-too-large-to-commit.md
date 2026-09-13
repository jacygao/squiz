---
settles: "§ 4 — the scale of the reviewer's JSONL stream, and how a fixture at that scale reaches a test"
issue: 96
recorded: 2026-09-12
versions: { pi: 0.85.1, node: 24.15.0 }
recheck-when: pi upgrades, or the reviewer's model changes
---

# The stream is too large to commit

## Intent

- **Nothing said how much output a real review produces.** The figure § 4 used
  to carry came from an old `pi` and was retired, so the code that reads the
  output had no idea what it has to cope with.
- **Nothing said what test data to check that code against.** Commit a real
  capture, build a fake one in the test, or commit a short real run — three
  answers, and the choice decides whether the test proves anything at all.

## Decisions

- **Never hold `agent_end` in memory.** § 4 already said to read the output a
  line at a time. What it did not say is that one line is big enough to break
  the adapter on its own.

- **Commit one small real capture, and let the tests build the big ones.** The
  committed run is small enough to live in the repository and proves the parser
  handles what `pi` really emits. The big streams are built by the test at
  whatever length it asks for, because memory is only proven flat by running two
  different lengths and comparing.

## Needs your input

**Whether the specification should say what a retried request is.** § 7 gives
"the model API is unavailable" a behaviour, and the signal § 4's adapter has for
it — an assistant message whose `stopReason` is `"error"` and whose usage is all
zero — also fires inside a round that is working. One run carried 22 such
messages and still completed 34 tool calls, because `pi` retried each failed
request and succeeded on all but the last. The cost arithmetic is unaffected,
since those messages carry zero usage. What breaks is a round reporting the API
as unavailable when it was briefly rate-limited.

Recommended: say a round failed when the last `auto_retry_end` carries
`success: false`, or when no assistant message completed with non-zero usage,
rather than on the first errored message. Both were observed and either
distinguishes the two cases.

Also for you: **a clean measurement of the `openai-responses` path needs a
higher rate limit than this account has.** The run exhausted a 200,000
tokens-per-minute ceiling and `pi` gave up after three retries with no review.
Filed as `needs-human`. Not worth buying: the fixture is generated from a shape,
and the shape is the same on both paths.

## Reference

### The two fixtures

| | Recorded | Generated |
|---|---|---|
| **Proves** | that the parse matches what `pi` emits | that peak memory does not grow with the stream's length |
| **Source** | one short `pi` run, committed byte for byte | built in the test from the shape below |
| **Size** | 135 lines, 73,332 bytes | whatever length the test asks for |
| **Reaches the test** | as a file in the repository | as an in-process stream, never written to disk |

Nothing in the recorded fixture is edited, because a hand-written fixture is
what is wrong when the parser is right. Nothing in the generated one is real,
because nothing about a 10MB capture is a contract and it would sit in every
clone forever.

The generated fixture's length has to be a parameter. A single capture of a
fixed length cannot tell flat memory from linear; two lengths can, and that
comparison does not exist unless the length can vary.

### The scale

A 450-line change across four files, reviewed at depth `read`, produced
9,873,029 bytes across 32,854 lines in 408 seconds. A second run of the same
command over the same change agreed on bytes within 2% and differed fivefold in
wall time.

- `message_update` is 99.3% of the lines and 84.9% of the bytes, at about 260
  bytes each.
- `agent_end` is 3.7% of the bytes in a single line, and the largest line in the
  stream.
- `agent_end`, `turn_end`, `message_start`, `message_end` and
  `tool_execution_end` together are 15.1% of the bytes. They are the largest
  lines and they are not the bulk, which is what an earlier correction, drawn
  from probes of a few hundred lines, had the wrong way round.

The retired figure was 194MB across roughly 19,800 lines, at `pi` 0.74.2, where
`message_update` repeated the whole partial message rather than a delta.

**`agent_end` is not once per run.** `pi` restarts the agent on a failed
request, and every attempt emits its own `agent_start` and `agent_end`. One run
emitted 22, so a reader that skips `agent_end` skips a line it may see many
times.

**A `message_update` is not always a small delta.** `thinking_end` and
`text_end` repeat the whole content block they close, at about 24KB against
about 260 bytes for a `thinking_delta`.

### The event types

Eleven, emitted by a clean run:

`session`, `agent_start`, `turn_start`, `message_start`, `message_update`,
`message_end`, `turn_end`, `tool_execution_start`, `tool_execution_end`,
`agent_end`, `agent_settled`.

Inside a `message_update` the delta sits under `assistantMessageEvent`, whose
`type` is one of nine and is what decides the line's size:

`thinking_start`, `thinking_delta`, `thinking_end`, `text_start`, `text_delta`,
`text_end`, `toolcall_start`, `toolcall_delta`, `toolcall_end`.

### What a generated fixture has to reproduce

Four properties, which are what make the stream hard to read rather than merely
long:

- `message_update` is about 99% of the lines, at about 260 bytes each, and
  `thinking_delta` is the bulk of those.
- One `agent_end` of a few hundred kilobytes, carrying the whole transcript.
- `thinking_end` and `text_end` at about 24KB, so a `message_update` is not
  safely assumed small.
- `message_start` and `message_end` fire for the user message and for every
  `toolResult` message, not only for assistant messages.

### The two events a clean run never emits

A failing request adds `auto_retry_start` and `auto_retry_end` to the eleven
types a clean run emits, so an event list taken from one capture is incomplete.

| Event | Fields |
|---|---|
| `auto_retry_start` | `attempt`, `maxAttempts`, `delayMs`, `errorMessage` |
| `auto_retry_end` | `attempt`, `success` |

`maxAttempts` was 3. `agent_end` carries `willRetry` alongside `messages`. A
`success` of `false` on the last `auto_retry_end` is `pi` giving up: the run
still exits 0 with empty stderr, and no assistant message anywhere in it carries
`stopReason: "stop"`.

### Discriminating a line without parsing it

`type` is the first key of every line, so a line's event is readable from its
first bytes.

```
{"type":"agent_end",...
```

Two groups share a prefix, and a discriminator has to read as far as the closing
quote to separate them: `agent_start` from `agent_settled`, and `message_start`
from `message_update` and `message_end`.

### The recorded fixture

**A short run does not necessarily think.** A probe that answered from a single
file read emitted no `thinking_start`, `thinking_delta` or `thinking_end` at
all, so its capture was missing the sub-event that repeats a whole block — the
one thing that makes a `message_update` large. A recorded fixture is checked
against all eleven event types and all nine `assistantMessageEvent` types rather
than assumed to carry them.

### Running one of these

`< /dev/null` and a hard timeout are both required. With stdin inherited `pi`
emits nothing and never exits, which is indistinguishable from a reviewer
thinking.

A run that never reached the model looks complete from outside: exit 0, empty
stderr, every structural event present. The `stopReason` on the assistant
messages is what tells the two apart, and a capture whose assistant messages all
carry `stopReason: "error"` is not a review.

**`sleep` is not a timeout on this machine.** A watchdog of `sleep 480` sent no
signal after 2,269 seconds of wall clock, with the sleeping process still alive
and counted by `ps` as running the whole time. The cause was not established. A
bound that has to hold is measured against the clock rather than slept through.

## Limits

- **One change, one repository, round 1, depth `read`.** No threads were handed
  in, and `deep` grants a shell, whose output lands in `tool_execution_end`.
- **The charter and the task prompt were stand-ins.** Neither was built when
  this was measured, so the figures move with whatever ships.
- **The configured default model was not run at review scale.** It is priced at
  three times the measured model's input rate and five times its output rate,
  and every figure here belongs to the model that produced it rather than to
  `pi`.
- **`openai-responses` was never measured on a run that completed.** Every
  attempt hit the account's token-per-minute ceiling. That run does establish
  the retry events and the repeated `agent_end`, both independent of why the
  request failed.
- **No figure here bounds a round.** § 7's review budget kills at a time, and a
  round that reaches it has been emitting for as long as the budget allows.
