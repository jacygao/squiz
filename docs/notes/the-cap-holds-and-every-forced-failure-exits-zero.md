---
settles: "§ 3 — whether the round cap hands threads back R−1 times against a real runtime, by blocking when this was recorded; § 7 — which failure rows a configuration or an environment can force, what each writes on stderr, and which rows a live run cannot reach at all; § 4 — whether a verdict of `open` re-opens a thread the loop had closed"
issue: 201
recorded: 2026-09-27
versions: { claude-code: 2.1.270, pi: 0.85.1, provider: deepseek, model: deepseek-v4-pro, coding-agent: claude-sonnet-5, gh: 2.97.0, node: 24.15.0 }
recheck-when: the hook's exit-code decisions change, pi upgrades, or § 7's rows change
---

# The cap holds, and every failure a configuration can force exits 0

## Intent

- **Nothing had reached the cap.** An episode had closed because nothing was
  left open, so neither half of the arithmetic had been seen: that a cap of 1
  never blocks, and that a cap of R blocks R−1 times.
- **No round had ever failed.** The failure pointer on stderr was written by
  unit tests alone, and nothing said whether a real firing writes it on the
  right channel.
- **Nothing said which of § 7's rows a live run can reach at all**, or what
  forcing one costs. Every row was covered by tests and none had been seen
  happen.
- **Nothing had seen a verdict of `open`.** The earlier episode closed three
  threads, so the closing half was measured and the re-opening half was not.
- **Nothing had produced a `disputed` thread**, because until the coding agent's
  reply carried a marker there was nothing to read one from.
- **Nothing said whether a configured value reaches the round.** A setting the
  validator refuses, or a file in the wrong directory, produces a run that looks
  like the default behaviour.

## Decisions

- **Ship the cap arithmetic. Both halves hold against the real runtime.** A cap
  of 1 reviewed once, posted two threads, left them open and exited 0 on its
  only firing. A cap of 2 exited 2 on round 1 and 0 on round 2 with a thread
  still open. Read from the exit code the hook returned, not from what the round
  said about itself. The round host now runs the rounds, and `squiz review`
  returns the same exits.

- **Every failure forced exited 0, and the two stderr channels stayed apart.**
  Eight firings failed in seven different ways and every one of them exited 0
  with one `squiz: ` line naming what failed. The two firings that blocked
  carried the blocking reason and no pointer beside it. No firing carried both,
  and no firing that failed was silent.

  2026-10-05: since M7 no hook blocks or runs a round, and the hook still exits
  0 on every path. The round host runs the round, `squiz review` exits 2 where
  threads are open and 1 where the round failed, and a failed round posts a
  failure comment (§ 6, § 7).

- **A verdict of `open` re-opens a thread the loop had closed.** A thread the
  previous episode's round 2 had resolved was handed to a later round with the
  defect restored, and GitHub reported it unresolved afterwards. That is the
  first time the re-open mutation has run for a reviewer's own ruling.

- **A coding agent's reply reads back as its own, so a thread ends `disputed`.**
  Four threads on the pull request carry a reply `squiz reply` composed, and the
  harness's own reader takes every one of them as the coding agent's. Nothing in
  the loop computes the status yet, because the summary comment is M6, so the
  status was computed by hand from what GitHub served.

- **Expect a provider that cannot be reached to be reported as a setup problem,
  not as a review that did not run.** `pi` answers an unreachable API by
  retrying three times, completing four errored messages, and exiting 0 with an
  empty stderr, so no message ever stops for an answer. The harness reads that
  as a reviewer that completed no message, and its pointer says the reviewer
  could not run. The wording § 7 gives the unavailable-API row is reachable only
  through the retry path, which needs output no fresh process could read either.

- **Do not expect a killed round to salvage findings from a round this small.**
  A reviewer of a 130-line change spends nearly the whole round reading and
  reports every finding in the last seconds of it. A bound of 50 seconds and a
  bound of 65 seconds each killed a review that had reported nothing, and a
  bound of 75 seconds left a round of the same shape to finish and post. The
  salvage that § 7 describes needs a round long enough for the reports to spread
  out.

- **Force a row from `.squiz.json` where one can be forced there, and prove the
  file arrived by having it refused first.** A refused setting names the path it
  was read from, the setting, the value and the range, which is the cheapest
  proof that the file the round read is the file that was written. `timeout` is
  the setting to do it with: it is refused above 480 and its value is quoted
  back in the pointer of a round it kills. 2026-10-05: M7 made the range 60 to
  3,600 seconds, with 900 the default (§ 9 Configuration).

- **Tell a driving session why a destructive step is wanted.** A parent given a
  numbered script that deleted the harness's own state directory investigated
  the repository, declined the whole script, and asked for confirmation, at the
  cost of a session. The same script with one paragraph saying the worktree is
  disposable and the destruction is the measurement ran every step without
  comment.

- **Never force a hanging GitHub with a hanging proxy.** A proxy that accepts a
  connection and never answers hangs the session that drives the run as surely
  as it hangs the round's own calls, and the session then emits nothing at all.
  A proxy that refuses the connection is safe, because every client fails fast.

- **Budget seven times the reviewer's spend for the sessions that drive it.**
  Nine rounds came to $0.23 and the sessions driving them came to $1.61. That is
  about the ratio the earlier episode measured, and it holds for the short
  failing firings as well as for the long reviewing ones: a session that
  dispatches one subagent and fails its round in a second still costs tens of
  cents.

- **Keep § 7's two rows, and name the second for what reaches it rather than for
  a cause.** Every unreachable provider lands on the row for a reviewer that runs,
  exits cleanly and completes no message, so naming the other one after the model
  API described a case `pi` cannot produce. It is now named for output that cannot
  be read and that no retry recovers, which is the only thing that reaches it.

- **Drop the round's re-opened count.** Nothing read it: not the state file, not
  the failure pointer, and not the summary comment, which carries terminal
  statuses and no re-opened count. A thread re-opened in one round and fixed in
  the next still ends its episode `fixed`. The re-open above was confirmed from
  GitHub's own resolved state, which is the better evidence in any case.

## Needs your input

- **Whether the salvage half of the review-budget row is worth buying.** It
  needs a scratch change big enough that the reviewer's reports spread over tens
  of seconds, which is a wider diff and a dearer round than anything measured
  here. Recommended: leave it, and treat a killed round that kept nothing as the
  row's ordinary shape for a small change.

## Reference

### How the runs were driven

Every run was one session started from the scratch worktree, on the branch pull
request #204 names:

```
claude --plugin-dir <plugin root> -p "<prompt>" --model sonnet
  --permission-mode acceptEdits --allowed-tools Bash Read Write Edit Task Glob Grep
  --output-format stream-json --verbose --include-hook-events --forward-subagent-text
  < /dev/null
```

The prompt dispatched subagents with the Task tool, one at a time, and a session
running several of them rewrote `.squiz.json` between them. Each subagent's stop
is one firing of the hook and one episode of its own, keyed on the subagent's
id. Wall times below are the interval between a firing's `hook_started` and its
`hook_response`, each line of the stream stamped as it arrived.

**A firing is attributed to an episode by the stream's own `task_id`.** It is the
subagent's id, so it is the name of the directory the episode writes under, and
the two matched for every episode here. A `hook_response` carries no id of its
own, so without that there is nothing in the stream tying a firing to the state
file it wrote.

**The environment the session is started with reaches the hook**, which is what
makes most of these rows forceable. `PATH` without the directory holding `pi` and
`HTTPS_PROXY` beside a `NO_PROXY` naming the hosts that must keep working were
each observed arriving. The hook's own `PATH` is the login one and carries
nothing the plugin added, so the variables a run sets are the whole of what it
can change.

### The rows a live run reached

Each row's evidence is the exit code in the `hook_response` event, the threads on
pull request #204 read back through GraphQL, and the `stderr` that event carried.

| § 7 row | How it was forced | Exit | stderr | Posted |
|---|---|---|---|---|
| The reviewer is not installed | `PATH` without the directory holding `pi` | 0 | `squiz: the reviewer could not run: the reviewer pi could not be started: spawn pi ENOENT` | nothing |
| The reviewer runs, exits cleanly, and completes no message | `HTTPS_PROXY` at a refused port, `NO_PROXY` keeping GitHub reachable | 0 | `squiz: the reviewer could not run: Connection error.` | nothing |
| GitHub is unreachable | `HTTPS_PROXY` at a refused port, GitHub not in `NO_PROXY` | 0 | `squiz: no review ran: the pull request for "scratch/m5-failure-rows" could not be looked up: gh exited 1: Post "https://api.github.com/graphql": proxyconnect tcp: dial tcp 127.0.0.1:1: connect: connection refused` | nothing |
| The reviewer exceeds the review budget | `"timeout": 50`, and again `"timeout": 65` with `"thinking": "max"` | 0 | `squiz: the reviewer was killed at its 50-second bound, and the round recorded no findings` | nothing |
| The local state file cannot be read | `.squiz` replaced by an empty regular file, so the episode's directory cannot exist | 0 | `squiz: no review ran: <worktree>/.squiz/<episode>/state.json could not be read: ENOTDIR: not a directory, open '<worktree>/.squiz/<episode>/state.json'` | nothing |
| The round cap is reached | `"rounds": 1`, and `"rounds": 2` | 0 | empty | 2 threads under the cap of 1, none new by the cap of 2's round 2 |
| The token bound is reached | `"tokens": 100000` with `"rounds": 3` and `"thinking": "max"` | 0 | empty | 3 threads |
| A `.squiz.json` that cannot be read or parsed (§ 9) | `"timeout": 700`, then a key named `reviewEverything` | 0 | `squiz: no review ran: <worktree>/.squiz.json: "timeout" is 700, but it must be a whole number of seconds from 1 to 480` | nothing |

The subagent finished normally after every one of those firings: each one's
`task_updated` carried `"status": "completed"`.

§ 7 names the state file only at the write. The forcing above stops the episode
at the read, before a reviewer starts, so the write is in the table of rows a run
did not reach.

### The cap, read from the exit codes

| Episode | Cap | Firings | Exits | Threads open at the close |
|---|---|---|---|---|
| `a7321f808df045344` | 1 | 1 | 0 | 2 of its own, both unresolved |
| `a5f6acc8bfd99d4f6` | 2 | 2 | 2 then 0 | 1 of the 2 it opened |
| `a965dc0cfd1e1be90` | 2 | 2 | 2 then 0 | 4, one of them re-opened |
| `a15acd976992e54e8` | 3 | 1 | 0 | 3 of its own |

The cap-of-1 episode is the criterion that was most likely to be broken: round 1
posted real findings, left both threads unresolved, and still exited 0.

The cap-of-3 episode closed on its first firing with two blocks left and three
threads open, so neither the cap nor an absence of open threads can account for
it. Its round spent 105,984 tokens against the bound's 100,000, which is the
only remaining reason the episode closed.

### The `open` verdict, and the thread it re-opened

`PRRT_kwDOUEd2qM6mVtzt` was opened by one episode's round 1 over `spanCount`
returning `Math.floor(total / size)`. The coding agent fixed it and replied; that
episode's round 2 ruled the thread closed, and GraphQL reported
`isResolved: true`. The fix was then reverted on the branch by hand, and a later
episode's round 2 was handed the thread with the defect standing. GraphQL
reported `isResolved: false` afterwards.

The reviewer was given nothing but the threads and the tree. The coding agent in
that episode was told to leave the file alone and to reply on any thread about
it, so the defect the thread names was still there when the reviewer read it.

Which verdict closed the thread in the first place — `fixed` or `withdrawn` — is
not recorded anywhere, and neither is the round's own count of what it re-opened.

### The coding agent's marker, read back live

Both replies the coding agent posted through `squiz reply` open with the marker,
on a line of their own:

```
**Squiz coding agent**

Fixed: spanCount now returns Math.ceil(total / size), so a partial last span counts as its own span, matching the docstring.
```

```
**Squiz coding agent**

Not changing spanStart in this turn: I've been told to leave it exactly as it is here, so this fix is out of scope for now.
```

Run over the pull request's threads as GraphQL served them, `readThread` takes
all four as findings the reviewer raised, each carrying its severity, its
headline, and `codingAgentReplied: true`. `statusOf` then gives `disputed` for
each, the verdict being the one an unresolved thread takes by default. The
verdict is supplied by hand here, because the round records none.

### What a killed round keeps

| Bound | Wall | Outcome | Recorded | Findings |
|---|---|---|---|---|
| 50 s, `thinking` default | 51.2 s | killed | $0.027428 over 56,912 tokens, 5 messages | none |
| 65 s, `"thinking": "max"` | 66.4 s | killed | $0.017982 over 10,165 tokens, 1 message | none |
| 75 s, `"thinking": "max"` | 77.2 s | reviewed | $0.034484 over 72,936 tokens, 6 messages | 2, both threaded |

A killed round is recorded as a round, so it spends one of the cap, and what it
spent goes in as the floor it left. The 65-second kill kept one message of the
six a finished round of the same shape completed, which is a seventh of the
tokens and half the dollars: a round thinking at `max` completes few messages and
each of them is dear.

Both killed rounds were killed mid-review rather than after a review the reviewer
had declared. The pointer says which: a round holding the declaration is the
review it declared whatever ended the run, and its pointer would not name the
bound at all.

### What the runs cost

| | Sessions | Rounds | Tokens |
|---|---|---|---|
| Whole run | $1.6082 | $0.2262 over 9 rounds | 436,248 |

Eleven sessions were started and ten of them reported a cost. The total of the
two figures is $1.8344.

One attempt was not a round: the unreachable-provider firing recorded four
messages, zero tokens and zero dollars against `spentOutsideRounds`, and no
round against the cap.

Per episode, in the order they ran:

| Episode | Row | Rounds | Cost | Tokens |
|---|---|---|---|---|
| `a4789f98aa5b3140c` | reviewer not installed | none | $0 | 0 |
| `a0ab2a48b5fb06890`, `a009e7bf19e18a57d` | `timeout` out of range, then a key that is not a setting | none | $0 | 0 |
| `a30c5db92e7e99b15` | state file unreadable | none | $0 | 0 |
| `a4db6cee6b59ae489` | GitHub unreachable | none | $0 | 0 |
| `a25719b411d2d09c1` | provider unreachable | none, 4 messages | $0 | 0 |
| `a5f6acc8bfd99d4f6` | cap of 2, and the disputed thread | 2 | $0.031159 | 57,711 |
| `a965dc0cfd1e1be90` | the `open` verdict re-opening | 2 | $0.045950 | 94,468 |
| `a7321f808df045344` | cap of 1 | 1 | $0.018977 | 38,072 |
| `a15acd976992e54e8` | token bound | 1 | $0.050219 | 105,984 |
| `a1fef86cce744a3cd` | review budget, 50 s | 1 | $0.027428 | 56,912 |
| `afd36eb85c94287cc` | review budget, 75 s, not reached | 1 | $0.034484 | 72,936 |
| `a9002306167ac984e` | review budget, 65 s | 1 | $0.017982 | 10,165 |

The two sessions that bought nothing were the parent that declined its script,
at $0.1613, and the hanging-proxy attempt, which emitted no stream at all and so
reported no cost.

### The rows a live run could not reach

The state file's write, a reviewer with no API key, a reviewer that stops
without finishing and no retry recovers it, the calls before the review running
out of time, a threads listing that fails part way, and some comments posting
while others fail. None of them was reached by a configuration or an
environment, and each is covered by the harness's own tests.

### Where a run contradicted the specification

**Round 1 of an episode hands the reviewer no threads, even where the pull
request carries some.** § 4's Invocation says the reviewer is handed "every
review thread already on it with the replies and resolved state of each", with
no exception, and § 3's step 4 blocks where threads are still open. Five
episodes posted a round 1's findings against #204 one after another, and the four
that followed the first reported the same two defects again, so the pull request
now carries five pairs of threads on the same two lines. The same shortcut
decides the close: a round 1 counts only
the threads its own findings opened, so one that found nothing would close the
episode as though nothing were open. #211 fixed it: every round now hands the
reviewer the threads it opened on the pull request.

### The pull request the runs were built on

#204, `scratch/m5/spans.ts` and `scratch/m5/schedule.ts`, about 130 lines. Two
seeded defects in the first file, each a one-line contradiction of the doc
comment above it: `spanCount` floors where a short last span is documented as a
span of its own, and `spanStart` returns `number * size` where span 1 is
documented to begin at index 0. Eleven threads were opened by the five rounds
that posted anything, and every one of them is about those two lines or about
`spansOf`, which composes them.

**The defect seeded in the second file was never reported.** `sharesOf`
subtracts the posting margin twice, so its three shares do not add up to the
window its doc comment says they do. The file was added after the pull request's
description was written, and that description declares its scope as the span
arithmetic in the first file alone. A reviewer honouring the declared scope and a
reviewer that never opened the file are both consistent with what was observed.

## Limits

- **One pull request, one defect pair, one model.** `deepseek-v4-pro` as the
  reviewer and `claude-sonnet-5` as both the coding agent and its parent. Each
  row was forced once, except the review budget, which was forced twice and
  missed once.

- **The disputing reply was directed.** The coding agent was told which function
  to leave alone and to reply on any thread about it. It did exactly that, and
  its replies say so in as many words. Nothing here says what a coding agent does
  with a finding it disagrees with on its own judgement, and no reviewer ruling
  was tested against a reply that argued the finding was wrong.

- **The re-opened thread's defect was restored by hand.** The branch's fix was
  reverted between two episodes, committed and pushed. Nothing in the loop
  produces a closed thread whose defect has come back, so the shape had to be
  arranged.

- **`disputed` is not reported anywhere yet**, so what was read is the status
  the harness's own reader computes from the live thread rather than a status
  some output carried. The verdict half of that computation was supplied rather
  than read.

- **A GitHub failure during posting was not exercised.** The unreachable-GitHub
  firing failed at the pull request lookup, which is before the review, so
  "nothing posted" was true of it for a reason that says nothing about what
  happens to findings a round is holding.

- **The state file was forced at the read rather than at the write.** Replacing
  `.squiz` with a file stops the episode before the reviewer runs. A write that
  fails after the review, which is where the round records what it spent and
  reports that nothing was posted, was not reached.

- **`"thinking": "max"` cannot be confirmed to have reached the reviewer.**
  Nothing the round writes names the level. What is observable is the token
  count, which was 105,984 and 72,936 at `max` against 38,072 for a comparable
  round at the default.

- **Print mode only, one machine, one subagent at a time.** Every session was
  `claude -p` on macOS, and the sessions running several episodes dispatched them
  one after another. No interactive session and no two episodes at once.

- **The cost figures are `pi`'s arithmetic**, from a catalogue that refreshes
  itself, and the session figures are Claude Code's own.

- **Wall times cover a firing rather than a review.** Each includes the calls
  before the review and the posting after it, which were two to six seconds in
  these rounds.

- **The scratch pull request stays open as the record of these runs.** Its
  branch is not for merging, and a later episode against it would add rounds to
  threads this note describes as settled.
