---
settles: "§ 4 — whether the round has to end the run on the reviewer's declaration"
issue: 175
recorded: 2026-09-26
versions: { pi: 0.85.1, model: deepseek-v4-pro, node: 24.15.0 }
recheck-when: pi upgrades, or the reviewer's model changes
---

# The reviewer stops two seconds after it finishes

Left unkilled after calling `finish_review`, the reviewer writes one more
assistant message, makes no further tool call, and its output closes about two
seconds later for about a quarter of a cent. That last message carries a stop
reason of `stop`, which no killed run has ever produced. Three runs of three, and
the answer did not vary.

## Decisions

- **Let the run end itself rather than ending it on the declaration.** The
  reviewer stops on its own in about two seconds for about $0.0025, against a
  round costing $0.09 to $0.20 and running 70 to 370 seconds. Ending it on the
  declaration is what the outstanding-call tracking, the two-second answering
  bound, and the wait for in-flight results all exist for, and all three can go.

- **Keep the round's own time bound as the only thing that ends a run the
  reviewer does not.** Waiting is bounded by the bound that was already there. A
  reviewer that declares itself finished and then does not stop is a reviewer the
  bound kills, which is what it is for.

- **Conclude a round on the reviewer's declaration even when the bound is what
  ended the run.** Without this, removing the early stop turns a finished review
  into a timed-out round whenever the closing message crosses the deadline: the
  run races the whole parse against expiry and returns a killed attempt without
  consulting the declaration it is already holding, and the loop reads a killed
  attempt as a round the reviewer failed, which does not block the coding agent.
  The findings survive that; the block does not.

## Needs your input

Nothing. The measurement answers the question it was taken for.

## Reference

### The tail, in three runs

| | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| Declaration to output closed | 2,713 ms | 2,139 ms | 1,868 ms |
| Assistant messages after it | 1 | 1 | 1 |
| Tool calls after it | 0 | 0 | 0 |
| Cost after it | $0.002509 | $0.001713 | $0.002839 |
| Tokens after it | 43,243 | 28,958 | 56,104 |
| Whole run | $0.154564 | $0.087271 | $0.195986 |
| Stop reasons | 9 `toolUse`, 1 `stop` | 6 `toolUse`, 1 `stop` | 20 `toolUse`, 1 `stop` |

The message after the declaration begins in the same millisecond as the
declaration's own result: the model had already composed it. So the two seconds
are the message arriving, not the model deciding to write one.

### A finished review does carry a stop reason, once it is allowed to

Every one of the three runs ended with exactly one message whose stop reason is
`stop`, and no killed run has produced one — the earlier measurement of the same
reviewer against the same pull request recorded 49 messages, all `toolUse`,
because the round killed it first.

For a run whose output closes before the bound passes, this changes nothing about
how the run is read. A finished review is recognised by the reviewer's own
declaration, which is a validated call, and that is checked before any stop
reason is — but only on the path where the parse completes, which is why the
expiry path has to consult the declaration too. What a stop reason still decides is the run that
finished no review: a reviewer that wrote prose and ended its turn carries
`stop`, and is retried once; one that answered nothing, or only errored, carries
none, and is a setup problem that is not retried.

### What the tail costs when it crosses the bound

Under a one-second bound, against the real parser, a reviewer that reported a
finding and finished at about 200 ms and then held its output open: with the
early stop, `reviewed` at about 258 ms; with it disabled, `timed-out` at about
1,028 ms. Both carried the same finding. Two seconds of tail is small against a
480-second bound and decides the outcome entirely at the boundary.

## Limits

- **Three runs, one model, one pull request.** `deepseek-v4-pro` against a
  1,950-byte diff. A model that narrates at length after finishing would have a
  longer tail, and nothing here bounds one.
- **The tail was measured with the round's stop disabled in a working tree**, not
  with the stop removed. What a round does once the code is changed is not what
  was measured here.
- **`report_verdict` was never called**, because the pull request carries no
  thread. What the reviewer does after finishing a review that ruled on threads
  is unmeasured.
