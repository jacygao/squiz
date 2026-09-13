---
settles: "§ 4 — the scale of the reviewer's JSONL stream, and how a fixture at that scale reaches a test"
issue: 96
recorded: 2026-09-12
versions: { pi: 0.85.1, node: 24.15.0 }
recheck-when: pi upgrades, or the reviewer's model changes
---

# The stream is too large to commit

A review-sized run of `pi` emits about ten megabytes of JSONL across thirty-odd
thousand lines. Almost all of that volume is tens of thousands of small
`message_update` deltas; almost all of the size of any one line is a single
`agent_end` carrying the whole transcript. A capture at that scale is not
committed: a test that needs the stream's shape gets a short run recorded whole,
and a test that needs the scale generates one.

## Decisions

- **A review-sized stream is about ten megabytes across thirty-odd thousand
  lines.** Measured over a 450-line change across four files at depth `read`,
  which produced 9,873,029 bytes across 32,854 lines.

- **That is a floor, not a bound.** The stream is the length of the round rather
  than the size of the diff: it grows with every tool call the reviewer makes
  and every token it thinks. Two runs of the same command over the same change
  agreed on bytes within 2% and differed fivefold in wall time.

- **The volume and the largest line are in different events.** `message_update`
  is 99.3% of the lines and 84.9% of the bytes, at about 260 bytes each.
  `agent_end` is a single line and the largest in the stream. An adapter that
  accumulates lines fails on the first; an adapter that holds one line fails on
  the second.

- **`agent_end` is not once per run.** `pi` restarts the agent on a failed
  request, and every attempt emits its own `agent_start` and `agent_end`. One
  run emitted 22. A reader that skips `agent_end` skips a line it may see many
  times.

- **A `message_update` is not always a small delta.** `thinking_end` and
  `text_end` repeat the whole content block they close, at about 24KB against
  about 260 bytes for a `thinking_delta`.

- **194MB across roughly 19,800 lines is retired.** That was `pi` 0.74.2, where
  `message_update` repeated the whole partial message, and it must not be quoted
  as current. What replaced it is not that the bulk moved into the
  message-carrying events: `agent_end`, `turn_end`, `message_start`,
  `message_end` and `tool_execution_end` together are 15.1% of the bytes. They
  are the largest lines and they are not the bulk.

- **A fixture at review scale is generated at test time. A fixture for shape is
  recorded whole and committed.**

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

  The large fixture has to be generated in order to prove what it exists to
  prove. A single capture of a fixed length cannot tell flat memory from linear.
  The length has to be a parameter for that comparison to exist at all.

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
