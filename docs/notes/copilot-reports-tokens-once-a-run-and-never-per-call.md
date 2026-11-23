---
settles: "§ 5 The Copilot adapter: what a Copilot round records as its cost; § 8 The review budget: what a Copilot round counts against the token bound"
issue: [458, 599]
recorded: 2026-10-06
versions: { copilot: "1.0.91, 1.0.92", models: "gpt-5-mini, claude-haiku-4.5, gpt-6-astra", macos: 26.6.2 }
recheck-when: Copilot CLI upgrades past 1.0.92, its JSON stream gains a per-call usage event, or it changes what `--usage-output-file` writes
---

# Copilot reports tokens once a run, and never per call

## Intent

- What Copilot's JSON output reports for each model call: tokens, premium
  requests, AI credits, or nothing.
- Where a run's total arrives, and whether a run stopped from outside still
  reports one.
- Whether the token bound counts Copilot's cached input.
- Whether AI credits are recorded beside tokens.

## Decisions

- **Read a Copilot round's cost once, from the file `--usage-output-file`
  writes, and never from the stream.** `model.call_start`,
  `model.call_finished`, `assistant.message` and `assistant.turn_end` carry no
  usage, so nothing reports a call as it happens. Only the file holds the run's
  tokens by kind and by model.
- **Take a cost only from an attempt where Copilot exited 0 by itself, and
  never as a floor.** The reviewer's shell line appends the usage to the report
  file after Copilot exits 0, so an attempt stopped from outside, or one where
  Copilot exited nonzero, adds no cost and names no model. After `SIGKILL`
  there is no usage file at all.
- **Keep what a round's attempts reported, whatever the round's outcome.** An
  attempt that exited 0 without finishing the review still reports its usage,
  and a round whose retry fails or runs out of time keeps the first attempt's
  spend.
- **Count `inputTokens + outputTokens` against the token bound, with nothing
  added.** Copilot's `inputTokens` already holds fresh input, cache reads and
  cache writes, so adding the cache figures would count them twice. The sum is
  what `pi`'s `totalTokens` means, so one bound means the same whichever CLI
  reviews.
- **Record `totalNanoAiu` as the round's AI credits, at 10⁹ to a credit, and
  leave premium requests out.** Copilot reports no dollars. Premium requests are
  one figure per run, set by the model and not by the number of calls: 0.33 for
  a seven-call run on `claude-haiku-4.5`, and 0 on `gpt-5-mini`.
- **Read whether the review finished from the finish call, never from
  Copilot's exit.** Copilot exits by itself whether or not the reviewer
  finished.

## Needs your input

Nothing.

## Reference

The usage file, abridged from a five-call run:

```json
{
  "totalPremiumRequestCost": 0,
  "totalNanoAiu": 535970000,
  "tokenDetails": { "input": { "tokenCount": 12458 }, "cache_read": { "tokenCount": 48128 },
                    "cache_write": { "tokenCount": 0 }, "output": { "tokenCount": 521 } },
  "modelMetrics": { "gpt-5-mini": {
      "requests": { "count": 5, "cost": 0 },
      "usage": { "inputTokens": 60586, "outputTokens": 521, "cacheReadTokens": 48128,
                 "cacheWriteTokens": 0, "reasoningTokens": 64 },
      "totalNanoAiu": 535970000 } }
}
```

It is several lines of indented JSON, so the shell joins it into one line
before appending it to the report file, which takes one line per record. A run
that reached no model exits 1 and still writes a usage file, with
`"modelMetrics": {}` and `"totalNanoAiu": 0`.

The same totals are in the `session.shutdown` event of
`<COPILOT_HOME>/session-state/<session id>/events.jsonl`, which is written in
interactive mode as well.

What the stream carries:

| Event | When | Usage it carries |
|---|---|---|
| `model.call_finished` | each call | none: `dispatchDurationMs`, `outcome` |
| `session.usage_checkpoint` | once, about 5 ms before `result` | `totalNanoAiu`, `totalPremiumRequests`, and the last call's `prompt_tokens` and `cache_read` |
| `result` | last line | `usage.premiumRequests` only |

`reasoningTokens` is reported beside `outputTokens`. Whether it is a part of
it, as in `pi`, was not established.

## Limits

- Every run was short: at most seven model calls. Whether
  `session.usage_checkpoint` is also emitted during a long run was not seen.
- Three models, all through GitHub's own routing. A BYOK provider
  (`COPILOT_PROVIDER_BASE_URL`) was not configured, and the run that reached no
  model used a stand-in provider through it answering 400.
- The `SIGKILL` case is one run. That a stopped round appends no usage line is
  the adapter's design, and no stopped round was run against it.
- No run that exited without a finish is recorded here.
