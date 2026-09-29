---
settles: "§ 7 — how each of the six rows a live run could not reach is forced through the real hook, what each one writes on stderr, and which shape of the window row and the pre-review row this method reaches; § 3 — what spends the posting share"
issue: 224
recorded: 2026-09-28
versions: { node: 24.15.0 }
recheck-when: § 7's rows change, the window's shares change, or pi's stream shape changes
---

# Two fakes on `PATH` force the six rows no environment reached

## Intent

- **Six of § 7's rows had never been seen happen.** Each was covered by unit
  tests, and the reasons a live run could not reach them were about the
  environment rather than about the rows.
- **Three of the six lose findings the reviewer had already confirmed**, which is
  the failure class the harness exists to avoid, and none had been watched
  end to end through the hook.
- **Nothing said whether the state file row can be forced at the write.** Only
  the read had been seen, and the write is the half that also stops what the
  round found from being posted.
- **Nothing said whether the posting margin can be spent at all** without the
  `windowMs` and `marginMs` knobs, which have no path from `.squiz.json`.
- **Nothing said whether the reviewer's one retry happens through the hook**, or
  what output reaches it.

## Decisions

- **Force these rows with a scripted `gh` and a scripted reviewer earlier on
  `PATH` than the real ones.** All six now run as `squiz hook` against a real
  worktree, and each is read from three things: the exit code the process
  returned, the ordered list of calls the fake `gh` recorded, and the one line on
  stderr. Every one of the six exits 0, and every one of them says what failed.

- **Name each call rather than matching its arguments.** Four of the harness's
  calls are `gh api graphql --include --input -` and differ only in the query on
  stdin, so a plan that keyed on arguments could not land one create and refuse
  the next. The discriminators are in Reference.

- **Have the fake read the whole of its stdin before it answers anything.** This
  is a fixture choice rather than the transport's contract. Only a `gh` that
  exits **zero** on a request it had not finished reading is reported as never
  having reached GitHub; a non-zero exit keeps its HTTP status, its body and its
  stderr and is reported by what it answered. So a fake that raced the write
  would sometimes answer with the zero-exit outcome instead of what the plan
  says, and draining first is what makes every answer the plan's.

- **Answer late on a timer, and install no `SIGTERM` handler.** Default handling
  kills a child however blocked its event loop is: a child in a 4,000 ms
  `Atomics.wait` with no handler was killed by a 150 ms `spawnSync` timeout in
  153 ms, reported `ETIMEDOUT` and `SIGTERM`. A **custom JavaScript** handler is
  what needs the loop — the same child with one ran all 4,043 ms and `spawnSync`
  waited for it — and a handler that ignores the signal survives it with a free
  loop too. The timer is the ordinary way to answer late rather than a way to
  stay killable.

- **Close the episode rather than block it when forcing a comment that was
  lost.** A blocked round composes no failure pointer, so a create GitHub refused
  is announced nowhere and only a later round's repeat of it says anything.
  `"rounds": 1` makes the round the closing one, and the loss is then on stderr
  and in the summary comment's Notes.

- **Force the state file at the write by sealing the episode's directory once its
  subdirectories exist.** `chmod 0o555` on `.squiz/<episode>/` with `session/`
  and `scratch/` already inside it: the read finds no state file and answers
  absent, the reviewer's directories are made by a `mkdir` that is a no-op on
  what is already there, and the round reaches the review and fails on the write
  that follows it. Nothing is posted, and the pointer carries the filesystem's
  own error.

- **Force § 7's "the window is gone before the findings are posted" at the
  posting deadline.** That row has two shapes and this method reaches one of
  them: the posting deadline passing part way through the posting, with plenty of
  the absolute window still left. It produces the row as written — findings
  reported as unposted, and no call made past the deadline. The other shape, the
  window already gone when the posting starts, is reached where the window can be
  lowered, and what spends the reserve there is the reviewer's own cleanup
  running past the moment the review had to be over by. **The posting share is
  not intact when posting begins**, and nothing here should be read as saying it
  is.

- **Spend the posting share with a call that pages.** The share handed to the
  posting is what is left divided by two calls per finding, and no call may
  exceed the 30-second ceiling, so a create killed at its bound cannot spend much
  of it. A create's read-back walks as many pages as GitHub claims, which is how
  a phase makes more calls than its share was split for. Five pages spent the
  whole share here.

- **Expect the calls before the review to report a shortened bound.** § 7 says
  stderr names the call that had nothing left. What this method produced is the
  last call killed at what the phase left it — `gh did not answer within 9.467
  seconds` against a 30-second ceiling on one call — which names the call and the
  time it had. A pre-review call refused outright for having nothing left needs
  the call before it to answer as the shared deadline passes, and nothing here
  arranges that.

- **Budget three minutes of wall clock for the two rows that are about time.**
  The pre-review share is 60 seconds and the posting share is 120, neither is
  configurable, and reaching either means spending it. The two tests measured
  60.1 and 121.1 seconds.

- **A reviewer that writes prose and stops is what reaches the retry.** Two
  processes ran, and the round reported the reviewer unavailable. What makes it
  that row rather than a setup problem is the assistant message's stop reason: a
  message that stopped for an answer is a run that reached the model, so its
  unreadable output is retried, and a run that completed no message is not.

## Needs your input

- **Whether § 7's pre-review row wants a second sentence.** Its "stderr says
  which call had nothing left" reads as a call that was not made, and what this
  method reaches is a call bounded by what the phase left it. Both name the call
  and both exit 0 with nothing posted. Recommended: leave the code alone, and say
  in the row that the phase's remaining time bounds its last call as well as
  refusing one with nothing left at all.

## Reference

### What each row wrote on stderr

Every row exited 0 and wrote nothing on stdout.

| Row | How it was forced | stderr |
|---|---|---|
| Some comments post and others fail | One create answers HTTP 201, the next exits 1 on HTTP 502, at `"rounds": 1` | `squiz: the round closed the episode on PR #142 having failed to post 1 of 2 findings` |
| The local state file cannot be written | `.squiz/<episode>/` at mode 555 with `session/` and `scratch/` already in it | `squiz: nothing was posted: <worktree>/.squiz/<episode>/state.json could not be written: EACCES: permission denied, open '<...>/state.json.<pid>.writing'` |
| The window is gone before the findings are posted | A create's read-back paging, four pages answering after 25 seconds each and the fifth killed by what was left | `squiz: the round closed the episode on PR #142 having failed to post 1 of 2 findings and to post the episode's summary: the time left for GitHub ran out before this call was made` |
| The threads cannot all be listed | Page 1 carries a thread and claims another page, page 2 exits 1 on HTTP 502 | `squiz: no review ran: the threads on PR #142 could not be listed: gh exited 1 on HTTP 502: gh: HTTP 502: Bad gateway` |
| The calls before the review run out of time | The lookup and the listing each answer after 25 seconds, and the diff is killed at what the 60-second share left | `squiz: no review ran: the diff of PR #142 could not be fetched: gh did not answer within 9.467 seconds, so GitHub could not be reached` |
| The reviewer stops without finishing its review | A reviewer writing one assistant message with stop reason `stop` and no `finish_review` call | `squiz: the review did not run: the reviewer reported nothing and did not finish its review` |

### What reached GitHub, per row

The calls, in the order they were made. This is what says a comment that landed
stayed, and what says nothing was attempted past a deadline.

| Row | Calls |
|---|---|
| Some comments post and others fail | lookup, threads, diff, create, read-back, create, summary |
| The local state file cannot be written | lookup, threads, diff |
| The window is gone before the findings are posted | lookup, threads, diff, create, read-back × 5 |
| The threads cannot all be listed | lookup, threads × 2 |
| The calls before the review run out of time | lookup, threads, diff |
| The reviewer stops without finishing its review | lookup, threads, diff |

The reviewer was started once for the state-file row, twice for the row it
stopped in the middle of, and not at all for the two rows that fail before the
review.

### Telling the harness's calls apart

`gh pr …` is the lookup. `gh api …` with no `graphql` carries a path beginning
`repos/`, and the path decides: one holding `/issues/` is the summary comment,
one holding `/pulls/` and ending `/comments` is a create, and any other
`/pulls/` path is the diff. A `gh api graphql` call is decided by its request
body, in this order:

| In the body | The call |
|---|---|
| `mutation(` | a verdict's resolve or re-open |
| `$pullRequest` | the threads listing |
| `$comment` | the read-back after a create |
| `$thread` | the rest of one thread's comments |

The order matters: the read-back's query names `pullRequest` as a field without
the `$`, and a verdict's mutation names `$threadId`, which holds `$thread`.

### What the summary comment carried

The row that lost one create closed the episode, and its comment reported both
findings:

```
- `src/ui/card.ts:86` — the reason is dropped and the outcome returned alone (open)
- `src/ui/card.ts:87` — the retry runs on a bound that is already spent (raised, and its comment could not be posted)
```

The first is in **Needs a person**, because its thread is on the pull request and
open. The second is in **Notes**, because nothing on the pull request holds it.

### What the fake reviewer has to emit

- Every line's first key is `type`, because the stream reader decides a line's
  type from its first bytes before parsing it.
- One `message_end` with `message.role` of `assistant` and a `usage` object is
  what makes the run one that completed a message. A fake that carries no such
  message and writes to stderr as well has that stderr appended to its reason,
  which is one more thing for a test to match.
- `stopReason: "stop"` on that message is what makes unreadable output a run to
  retry. Any other stop reason makes it a run that completed no message, which is
  a setup problem and is never retried.
- Each report is a `tool_execution_end` with `isError: false` and the report
  under `result.details`. `report_finding` carries the finding; `finish_review`
  carries nothing and is the only thing that says a review is done.

### The arithmetic the two timed rows rest on

The window is 600 seconds. The posting share is 120 and the pre-review share is
60, and neither is configurable. The moment the review has to be over by is the
window less the posting share, and the reviewer is given the smaller of what the
project configured and what is left of that, so the calls before the review
shorten the review.

**The posting share is what is left of the window when the posting begins, capped
at 120 seconds.** Stopping the reviewer runs after the moment the review had to
be over by, and what that overrun spends comes out of the posting. So the share
is not a reserve the posting is guaranteed: a round can reach the posting with the
window already gone.

Within the share, each call is bounded by the 30-second ceiling, by its share of
what is left, and by what is left. A call with nothing left is not made at all,
and that is the state the paging read-back reaches.

## Limits

- **One fake reviewer, and nothing about a real one.** The stream the fake writes
  is the shape `pi` emits, and what a real `pi` does with a prompt is untouched
  by any of this.

- **The window row was reached at the posting deadline, not with the window
  already gone.** The calls before the review and the review itself took about a
  second between them, so nearly the whole 600 seconds was still left when the
  posting began. Whether a round driven through the hook can instead reach the
  posting with the window gone is not established here: it needs a reviewer whose
  cleanup overruns by the length of the share, and nothing here arranged one.

- **Neither timed row establishes what the shares are worth in a real round.**
  Both spend their share on a `gh` that is slow on purpose. Nothing here measures
  how much of either share the harness's own calls take against real GitHub.

- **Each row was forced once, on one machine.** The two timed rows measured 60.1
  and 121.1 seconds of wall clock, and both have about 5 seconds of slack in the
  pages that answer. A machine slow enough to spend that would fail them rather
  than pass them wrongly.

- **The refused create was refused with HTTP 502.** A 422 naming an anchor field
  is a different outcome — the finding goes to the summary rather than being
  reported as lost — and it was not exercised here.

- **No verdict reached a thread.** The listing hands over no thread in five of
  the six rows, and the sixth fails the listing, so the resolve and re-open
  mutations were never called.
