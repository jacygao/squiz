---
settles: "§ 4 — what a Copilot adapter's read can return as a round's cost; § 7 — what a Copilot round that is killed records; M8 — whether the token bound can read Copilot's tokens"
issue: 458
recorded: 2026-10-06
versions: { copilot: 1.0.91, models: "gpt-5-mini, claude-haiku-4.5, gpt-6-astra", macos: 26.6.2 }
recheck-when: Copilot CLI upgrades past 1.0.91, or its JSON stream gains a per-call usage event
---

# Copilot reports tokens once a run, and never per call

## Intent

- What Copilot's JSON output reports for each model call: tokens, premium
  requests, AI credits, or nothing.
- Where a run's total arrives, and whether a run stopped from outside still
  reports one.

## Decisions

- **Read a Copilot round's tokens from the end of the run, not from its calls.**
  `model.call_start`, `model.call_finished`, `assistant.message` and
  `assistant.turn_end` carry no usage, so no event reports a call as it happens.
  The totals arrive once, as the run ends.
- **Pass `--usage-output-file` and read the file, rather than the stream.** It
  holds the run's tokens by kind and by model, which the stream does not. The
  stream's `session.usage_checkpoint` carries the run's AI credits and premium
  requests, and the last call's `prompt_tokens` and `cache_read` alone. `result`
  carries premium requests alone.
- **Treat a Copilot round stopped by `SIGTERM` as reporting its total, and one
  stopped by `SIGKILL` as reporting nothing.** On `SIGTERM` Copilot wrote the
  usage file and emitted its final events before exiting. After `SIGKILL` there
  was no usage file. So a Copilot round never reports a floor during the run, as
  `pi` does: it reports everything at the end or nothing.

## Needs your input

- **Whether the token bound counts Copilot's cached input.** Its
  `inputTokens` is the sum of fresh input, cache reads and cache writes: 60,586
  on a run whose fresh input was 12,458 and cache reads 48,128. Recommended:
  count `inputTokens + outputTokens`, as `pi`'s `totalTokens` does, so one bound
  means the same thing whichever CLI reviews.

  2026-10-07: settled as recommended (§ 7 The review budget).
- **Whether AI credits should be recorded beside tokens.** Copilot reports no
  dollars. It reports AI credits, as `totalNanoAiu` (10⁹ to a credit), and
  premium requests. Recommended: record `totalNanoAiu` as the round's cost, and
  leave premium requests out. They are one figure per run, set by the model
  and not by the number of calls: 0.33 for a seven-call run on `claude-haiku-4.5`, and 0 on
  `gpt-5-mini`.

  2026-10-07: settled as recommended. A Copilot round records tokens and AI
  credits, and the summary shows both (§ 4 The Copilot adapter).

## Reference

The usage file `--usage-output-file <file>` writes, abridged from a five-call run:

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

The same totals are in the session's own record, as the `session.shutdown`
event of `<COPILOT_HOME>/session-state/<session id>/events.jsonl`. That file is
written in interactive mode as well, where stdout is the screen.

What the stream carries, and where:

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
  (`COPILOT_PROVIDER_BASE_URL`) was not configured.
- The `SIGKILL` case is one run.
