---
settles: "§ 4 — the scale of the reviewer's JSONL stream, and how a fixture at that scale reaches a test"
issue: 96
recorded: 2026-09-12
versions: { pi: 0.85.1, node: 24.15.0 }
recheck-when: pi upgrades, or the reviewer's model changes
---

# The stream is too large to commit

A review of a 450-line change at depth `read` produced 9.9MB of JSONL across
32,854 lines, at `pi` 0.85.1. Almost all of that volume is `message_update`,
which is tens of thousands of streaming deltas of about 260 bytes each. Almost
none of the size of any one line is: the largest was a single 361KB `agent_end`
carrying the whole transcript. A capture at that scale is not committed. A test
that needs the stream's shape gets a whole short run instead, which is 135 lines
and 73KB and carries every event type; a test that needs the scale generates the
stream from the figures below.

## Decisions

- **A review-sized stream is about ten megabytes across thirty-odd thousand
  lines.** 9,873,029 bytes across 32,854 lines in 408 seconds, for a 450-line
  change across four files at depth `read`, with 20 assistant messages and 34
  tool calls. `pi` 0.85.1, `deepseek-v4-pro`, the `openai-completions` API path.
  A second run of the same command over the same change reached 10,035,038 bytes
  across 34,551 lines before it was killed.

- **That is a floor, not a bound.** The stream is the length of the round, not
  the size of the diff: it grows with every tool call the reviewer makes and
  every token it thinks. The two runs of the same command on the same model and
  the same change agreed on the byte total to within 2% and on nothing else. One
  finished in 408 seconds after 20 assistant messages; the other had done 12 in
  2,269 seconds and was still going when it was killed.

- **The volume and the largest line are in different events.** `message_update`
  is 99.3% of the lines and 84.9% of the bytes, at about 260 bytes each.
  `agent_end` is 3.7% of the bytes in a single line, and it is the largest line
  in the stream. An adapter that accumulates lines fails on the first; an
  adapter that holds one line fails on the second.

- **`agent_end` is not once per run.** `pi` restarts the agent on a failed
  request, and every attempt emits its own `agent_start` and `agent_end`. One
  run emitted 22 of them, totalling 694,989 bytes, the largest 348,357. A reader
  that skips `agent_end` skips a line it may see many times.

- **A `message_update` is not always a small delta.** `thinking_end` and
  `text_end` repeat the whole content block they close. The largest observed was
  23,805 bytes, against about 260 for a `thinking_delta`.

- **194MB across roughly 19,800 lines is retired.** That was `pi` 0.74.2, where
  `message_update` repeated the whole partial message. It must not be quoted as
  current. What replaced it is not that the bulk moved into the
  message-carrying events: `agent_end`, `turn_end`, `message_start`,
  `message_end` and `tool_execution_end` together are 15.1% of the bytes. They
  are the largest lines and they are not the bulk, and a probe of a few hundred
  lines is too short to tell the two apart.

- **A fixture at review scale is generated at test time. A fixture for shape is
  recorded whole and committed.** Two fixtures, two jobs:

  | | Recorded | Generated |
  |---|---|---|
  | **Proves** | that the parse matches what `pi` emits | that peak memory does not grow with the stream's length |
  | **Source** | one short `pi` run, committed byte for byte | built in the test from the event mix below |
  | **Size** | 135 lines, 73,332 bytes | whatever length the test asks for |
  | **Reaches the test** | as a file in the repository | as an in-process stream, never written to disk |

  Nothing in the recorded fixture is edited, because a hand-written fixture is
  what is wrong when the parser is right. Nothing in the generated one is real,
  because nothing about a 10MB capture is a contract: it is one model's
  reasoning about one pull request, it would sit in every clone forever, and it
  is larger than the repository that would carry it.

  The large fixture also has to be generated in order to prove what it exists to
  prove. A single capture of a fixed length cannot tell flat memory from linear.
  Two lengths can, and the length has to be a parameter for that comparison to
  exist at all.

## Needs your input

**Whether the specification should say what a retried request is.** § 7 gives
"the model API is unavailable" a behaviour, and the signal § 4's adapter has for
it — an assistant message whose `stopReason` is `"error"` and whose usage is all
zero — now also fires inside a round that is working. One measured run carried
22 such messages and still did 34 tool calls, because `pi` retried each failed
request and succeeded on all but the last. Nothing about the cost arithmetic
breaks: those messages
carry zero usage, so summing them is still correct. What breaks is a round that
reports the API as unavailable when it was briefly rate-limited.

Recommended: say that a round has failed when the last `auto_retry_end` carries
`success: false`, or when no assistant message completed with non-zero usage,
rather than on the first errored message. Both were observed and either
distinguishes the two cases. It is one sentence in § 4 and one row in § 7, and
it is a decision rather than a finding, which is why it is here.

Also for you: **a clean measurement of the `openai-responses` path needs a
higher rate limit than this account has.** The run exhausted a 200,000
tokens-per-minute ceiling — a single request asked for 108,876 — and `pi` gave
up after three retries with no review. Filed as `needs-human`. Not worth buying:
the fixture is generated from a shape, and the shape is the same on both paths.

## Reference

### The three runs

§ 4's command line at depth `read`, over this repository's own pull request #85
— 450 lines across four files, 569 diff lines, 22,875 bytes. Only the model flag
differs between the three.

| | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| **Model** | `deepseek-v4-pro` | `deepseek-v4-pro` | `gpt-5.4-mini` |
| **`message.api`** | `openai-completions` | `openai-completions` | `openai-responses` |
| **Outcome** | completed | killed at 2,269s | gave up after three retries |
| **Exit status** | 0 | 143 | 0 |
| **Wall time** | 408s | 2,269s | 273s |
| **Lines** | 32,854 | 34,551 | 7,957 |
| **Bytes** | 9,873,029 | 10,035,038 | 4,902,107 |
| **Assistant messages** | 20 | 12 | 46 |
| **Tool calls** | 34 | 20 | 34 |
| **`agent_end` lines** | 1 | 2 | 22 |
| **Largest line** | 361,483 | 302,118 | 348,357 |
| **`message_update`, % of bytes** | 84.9% | 87.5% | 40.1% |
| **Cost** | $0.257581 | $0.140877, a floor | $0.228608 |

Stderr was empty and no line was unparseable in any of the three. The killed run
left no partial line: its last line was whole, newline included.

### The event mix

Run 1, every line, with its share of the 9,873,029 bytes. This is the shape a
generated fixture is built from.

| Event | Count | Bytes | % of bytes | Largest line |
|---|---|---|---|---|
| `message_update` | 32,632 | 8,383,852 | 84.9% | 23,805 |
| `message_end` | 55 | 363,246 | 3.7% | 41,349 |
| `agent_end` | 1 | 361,483 | 3.7% | **361,483** |
| `turn_end` | 20 | 334,027 | 3.4% | 64,371 |
| `message_start` | 55 | 230,119 | 2.3% | 41,351 |
| `tool_execution_end` | 34 | 193,571 | 2.0% | 41,309 |
| `tool_execution_start` | 34 | 6,096 | 0.1% | 253 |
| `turn_start` | 20 | 440 | 0.0% | 22 |
| `session` | 1 | 147 | 0.0% | 147 |
| `agent_settled` | 1 | 25 | 0.0% | 25 |
| `agent_start` | 1 | 23 | 0.0% | 23 |

`message_start` and `message_end` fire 55 times against 20 assistant messages,
because they also fire for the user message and for every `toolResult` message.

Inside a `message_update` the delta sits under `assistantMessageEvent`, and its
type is what decides the line's size:

| `assistantMessageEvent.type` | Count | Bytes | Largest line |
|---|---|---|---|
| `thinking_delta` | 31,001 | 7,840,753 | 264 |
| `toolcall_delta` | 1,117 | 280,895 | 257 |
| `text_delta` | 404 | 100,546 | 260 |
| `thinking_end` | 20 | 128,104 | **23,805** |
| `toolcall_end` | 34 | 16,614 | 557 |
| `toolcall_start` | 34 | 10,058 | 296 |
| `thinking_start` | 20 | 4,760 | 238 |
| `text_end` | 1 | 1,888 | 1,888 |
| `text_start` | 1 | 234 | 234 |

### The two events a clean run never emits

A failing request adds `auto_retry_start` and `auto_retry_end` to the eleven
types above, so an event list taken from one capture is incomplete.

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

A whole short run, committed byte for byte, is 135 lines and 73,332 bytes. It
carries all eleven event types and all nine `assistantMessageEvent` types.

**A short run does not necessarily think.** A probe that answered from a single
file read emitted no `thinking_start`, `thinking_delta` or `thinking_end` at all,
so its capture was missing the sub-event that repeats a whole block — the one
thing that makes a `message_update` large. A recorded fixture is checked against
the nine types rather than assumed to carry them.

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
and counted by `ps` as running the whole time. The cause was not established.
A bound that has to hold is measured against the clock rather than slept
through.

## Limits

- **One change, one repository, round 1, depth `read`.** No threads were handed
  in, and `deep` grants a shell, whose output lands in `tool_execution_end`.
- **The charter and the task prompt were stand-ins.** Neither is built. They
  were composed from § 4's charter rules and from what § 4 says is handed to the
  reviewer, so the figures move with whatever ships.
- **The configured default model was not run at review scale.** It is priced at
  three times the measured model's input rate and five times its output rate,
  and every figure here belongs to the model that produced it rather than to
  `pi`.
- **`openai-responses` was never measured on a run that completed.** Every
  attempt hit the account's token-per-minute ceiling. What that run does
  establish is the retry events and the repeated `agent_end`, both of which are
  independent of why the request failed.
- **No figure here bounds a round.** § 7's review budget kills at a time, and a
  round that reaches it has been emitting for as long as the budget allows.
