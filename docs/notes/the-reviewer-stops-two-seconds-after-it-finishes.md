---
settles: "§ 5: whether the round has to end the run on the reviewer's declaration, and what a stop reason still decides; § 8: how a round is read when the time bound ends a run that had finished"
issue: 165
recorded: 2026-09-26
versions: { pi: 0.85.1, model: deepseek-v4-pro, node: 24.15.0 }
recheck-when: pi upgrades, or the reviewer's model changes
---

# The reviewer stops two seconds after it finishes

## Intent

- Whether the round has to end the reviewer's run as soon as it calls
  `finish_review`.
- What a finished run's stop reason says.

## Decisions

- **Let the run end itself after `finish_review`.** Left alone, the reviewer
  wrote one more assistant message, made no further tool call, and its output
  closed about two seconds later for about $0.0025, in three runs of three. The
  extension calls `ctx.shutdown()` after `finish_review`, which `pi` defers until
  it is idle, so the closing message is written.
- **Keep the round's time bound as the only thing that ends a run the reviewer
  does not.** A reviewer that declares itself finished and then does not stop is
  one the bound kills.
- **Conclude a round on the reviewer's declaration even when the bound is what
  ended the run.** Otherwise a closing message that crosses the deadline turns a
  finished review into a failed round: the findings survive, but the round hands
  no threads back and posts a failure comment instead.
- **Recognise a finished review by its declaration, before any stop reason.**
  The stop reason decides only a run that finished no review. A reviewer that
  wrote prose and ended its turn carries `stop`, and is retried once. One that
  answered nothing, or only errored, carries none, and is a setup problem that is
  not retried.

## Needs your input

Nothing.

## Reference

| | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| Declaration to output closed | 2,713 ms | 2,139 ms | 1,868 ms |
| Assistant messages after it | 1 | 1 | 1 |
| Tool calls after it | 0 | 0 | 0 |
| Cost after it | $0.002509 | $0.001713 | $0.002839 |
| Tokens after it | 43,243 | 28,958 | 56,104 |
| Stop reasons | 9 `toolUse`, 1 `stop` | 6 `toolUse`, 1 `stop` | 20 `toolUse`, 1 `stop` |

- The message after the declaration begins in the same millisecond as the
  declaration's result: the model had already composed it, so the two seconds
  are the message arriving.
- A finished run ends with exactly one message whose stop reason is `stop`. A run
  killed on the declaration carries only `toolUse`.

## Limits

- **Three runs, one model, one 1,950-byte diff.** A model that narrates at length
  after finishing would have a longer tail, and nothing here bounds one.
- **The tail was measured with the round's early stop disabled in a working
  tree**, not on the code as it now stands.
- **`report_verdict` was never called**, because the pull request carried no
  thread. What the reviewer does after a review that ruled on threads is
  unmeasured.
