# 5. The summary

One comment is posted on the pull request when an episode closes. It carries the
status of every finding, what each round did, and the cost of the review.

The comment is never edited or replaced. A second episode on the same pull
request posts a second comment, and the comments accumulate as a history of the
review passes.

**An episode reports its close once, and its closing round reports it again.**
The round that closes it writes the close to the episode's state, and then posts
the comment, as The state file under [§ 3](loop.md#the-state-file) sets out. Every path that ends an
episode writes the close, the paths that end one with no comment included. A
closing round ([§ 3 The round cap](loop.md#the-round-cap)) posts a second comment, composed the same way
from the episode as the closing round leaves it. It is the episode's last, and the
first stays as it was posted.

A round that leaves threads open for the coding agent posts no summary and records
no close, because the comment is the close of the episode rather than the end of a
round. A round the reviewer failed posts no summary either: it reached no decision
about the episode, and counts taken from a review that did not finish would read
as counts from one that did. It posts the failure comment under [§ 7](failure-modes.md) instead.

A run that finds the round cap or the token bound already spent closes the
episode without running a reviewer. A bound lowered between runs reaches this: the
episode reviewed, its last round left threads open, and the next run ends it. The
run lists the episode's threads, posts the summary comment from them and from what
the episode recorded, and prints the open ones. It exits 3 where any are open and 0
where none are, as any close does.

An episode that ran no round at all reaches this too, when its failed attempts
spent the token bound. Such an attempt may still have posted the findings it
salvaged, so the run lists the threads the same way. Where any of the reviewer's
threads are on the pull request, it posts the summary, prints the open ones, and
exits 3 or 0 as any close does. Only where there are none does it post no summary,
exit 0, and say on stderr that the episode closed before any round ran.

**A close that runs no reviewer counts each thread by its resolved state and the
last ruling the state file holds for it** ([§ 3 The state file](loop.md#the-state-file)):

| The thread | Counted as |
|---|---|
| Unresolved | `open`, or `disputed` where the coding agent replied, as at any close |
| Resolved, last ruled `fixed` | `fixed` |
| Resolved, last ruled `withdrawn` | `withdrawn` |
| Resolved, last ruled `open`, or with no ruling on record | resolved, ruling unknown |

A resolved thread with no ruling on record was resolved by a person, or in an
episode whose state is in another worktree. One last ruled `open` was resolved
after the reviewer kept it open. Neither says whether a defect was fixed, so
neither is counted `fixed` or `withdrawn`. Neither needs a person, because
someone closed the thread.

## What the comment carries

Four blocks, in this order.

1. **The counts, what the review spent, and who reviewed it.** Rounds run, and
   the closing round where one ran, findings raised, how many ended `fixed`, `withdrawn`, `open` and `disputed`,
   and the tokens each round spent with the episode's total, followed by the
   dollars where the reviewer's CLI priced the model, and the AI credits where it
   reported those. Then the reviewer CLI and the model each round ran on, as the
   run reported them. Findings raised counts every thread of the episode, and
   every finding that no thread holds that Notes lists. The findings that no
   thread holds carry no status. A close that ran no reviewer adds a count of
   the threads it found resolved with no ruling to count them by, and only where
   there are any:

   ```markdown
   Fixed 1 · Withdrawn 0 · Open 1 · Disputed 0 · Resolved, ruling unknown 2
   ```
2. **The findings that need a person.** Every `open` finding and every
   `disputed` one, each with its headline and where it sits: `file:line` for a
   thread anchored to a line, and the file alone for one anchored to the file.
   When there are none, the comment says so in one line.
3. **Rounds.** Each round in the order it ran, with the short commit it
   reviewed, how many findings it raised, and the rulings it replied with: each
   thread it closed while the thread was open, and each it kept open. A round
   that raised nothing and ruled on nothing says so in one line, as
   `- Round 4 at 9a0b1c2: found nothing new and ruled on nothing`. The closing
   round is named as one, as `- The closing round at 9e01b2c: raised nothing,
   and ruled 1 fixed and 2 open`. The list is
   read from the episode's state file and never from the pull request, so a
   round whose replies GitHub refused is listed all the same. A round whose entry
   holds none of this, which only a state file an earlier version wrote has, is
   listed as not recorded, and an episode none of whose rounds holds it carries
   no Rounds block.
4. **Notes.** Anything else a person reviewing the pull request should know:
   findings about the change as a whole, each with its headline; a finding the
   harness could anchor to neither a line nor a file, with its `file:line`; a
   finding whose comment could not be posted at all, with the location the
   finding carries; a thread the last round kept open whose reason could
   not be posted, with its location and headline; a thread any round closed
   whose reply could not be posted, with its location, headline and ruling; a
   ruling of the last round that could not be applied, with what the
   reviewer ruled; a finding the closing round reported, which was not posted;
   what the closing round settled; a round whose review the time bound cut
   short, with the round's number and the bound; and a cap or bound that ended
   the episode early, with each queued state it left not reviewed.

**A closing reply that could not be posted is a line naming the ruling.** The
thread is closed with nothing on it saying so, and the round recorded the line
in its entry of the state file, so the close lists it whichever round it was:

```markdown
- `src/queue.ts:134` — Retry backoff resets (ruled fixed, and the reviewer's reply could not be posted on its thread)
```

**A ruling that could not be applied is a line saying what the reviewer ruled.**
Its thread stays as GitHub had it, and the line is what a person reads to apply
the ruling by hand. A ruling on a thread that was handed over names the thread by
its location and headline. One naming a thread that was not handed over names it
by the id the reviewer gave. What GitHub answered is left out:

```markdown
- `src/queue.ts:134` — Retry backoff resets (ruled fixed, and the thread could not be resolved)
- `src/queue.ts:140` — The cap is never read (ruled open, and the thread could not be re-opened)
- `src/cache.ts:12` — The cache is never cleared (given no ruling, which keeps it open, and the thread could not be re-opened)
- `src/cache.ts:30` — The key ignores the locale (ruled open a second time, which was not applied: the first ruling stands)
- A ruling of withdrawn on thread `PRRT_kwDOAbc999`, which was not handed to the reviewer, was not applied
```

**The findings that no thread holds are the last round's, and those an
earlier round left that no later round settled.** A round that leaves the
episode open posts no summary, so its record keeps each of those findings as
its Notes line ([§ 3 The state file](loop.md#the-state-file)), and `squiz review` prints each on stderr
for the coding agent working that round ([§ 6](commands.md)). A later round whose reviewer
finished its review settles them: the reviewer read the whole change again, and
raised again each one it still found. The earlier findings are therefore listed
only by a close that ran no reviewer, which lists those of the last round that
reached a result. They come first in Notes, before the last round's own. A
closing round's summary does not list them again: the round that reached the cap
listed its own in the first summary.

A failed round settles nothing and posts no summary. The findings it salvaged
that no thread holds are listed in its failure comment instead, as [§ 7 The
failure comment](failure-modes.md#the-failure-comment) sets out.

A finding whose comment could not be posted is in Notes because nothing else on
the pull request holds it. The reviewer confirmed it and the harness lost it, so
a comment that left it out would read as a review that found nothing there.

**A round whose review the time bound cut short is a line of its own.** Its
findings are on the pull request like a finished review's, so nothing else tells
a person that the reviewer stopped before it had read everything it meant to.
The round is a failed one and closes no episode, so the line is written by the
round that closes the episode later, from the episode's state:

```markdown
- The review was cut short by the 900-second time bound in round 2, and the round kept only the findings it had reported by then
```

**A closing round is a line of its own, saying what it settled.** It names the
threads it was handed and each one it closed, with its location, its headline and
the ruling that closed it. What it left open is under Needs a person:

```markdown
- The closing round ruled on the 2 threads the round cap left open, and settled 1: `src/queue.ts:134` — Retry backoff resets on every enqueue (fixed)
- The closing round ruled on the 1 thread the round cap left open, and settled none
```

A finding the closing round reported is a line each, given as a finding no
thread holds is, saying it was not posted. Findings raised does not count it,
because nothing on the pull request raised it:

```markdown
- `src/cache.ts:12` — The cache is never cleared (reported in the closing round, which raises no findings, so it was not posted)
```

**A cap or bound that left queued states not reviewed is one line, naming the
bound and each of those states.** It takes the place of the line the bound
writes where nothing was queued. Each state is named as [§ 3 The state file](loop.md#the-state-file) names
it:

```markdown
- The episode ended at its round cap rather than with nothing left open, and did not review 8d21a4f or 8d21a4f with different replies
- The episode ended at the token bound with nothing left open, and did not review 3f9c2e0 with different replies
```

The second is a last round that left nothing open, with a state queued behind it
that the bound left no round for.

## The format

```markdown
**Squiz review — 3 rounds, 7 findings**

Fixed 2 · Withdrawn 1 · Open 2 · Disputed 1
48,200 tokens over 3 rounds: 20,100, 16,400, 11,700 · $0.0134
Reviewed by `pi` on `openai/gpt-5-mini`

**Needs a person**

- `packages/sync/src/queue.ts:134` — Retry backoff resets on every enqueue (open)
- `packages/sync/src/session.ts:57` — Clock skew is read as token expiry (disputed)
- `packages/sync/src/retry.ts` — Every path here is dead once the queue lands (open)

**Rounds**

- Round 1 at 3f9c2e0: raised 6 findings
- Round 2 at 1b86987: raised nothing, and ruled 2 fixed, 1 withdrawn and 3 open
- Round 3 at 8d21a4f: raised 1 finding, and ruled 3 open

**Notes**

- About the change as a whole: the retry queue duplicates the scheduler already
  in `packages/sync/src/scheduler.ts`, which nothing calls
- The review was cut short by the 900-second time bound in round 2, and the round kept only the findings it had reported by then
```

Notes is omitted when there is nothing to report.

A closing round's summary names it in the heading, in the spend line, where its
tokens come last, and in Rounds:

```markdown
**Squiz review — 3 rounds and a closing round, 6 findings**

Fixed 3 · Withdrawn 1 · Open 1 · Disputed 1
52,500 tokens over 3 rounds and the closing round: 20,100, 16,400, 11,700, 4,300 · $0.0151
Reviewed by `pi` on `openai/gpt-5-mini`

**Needs a person**

- `packages/sync/src/session.ts:57` — Clock skew is read as token expiry (disputed)
- `packages/sync/src/retry.ts` — Every path here is dead once the queue lands (open)

**Rounds**

- Round 1 at 3f9c2e0: raised 6 findings
- Round 2 at 1b86987: raised nothing, and ruled 2 fixed, 1 withdrawn and 3 open
- Round 3 at 8d21a4f: raised nothing, and ruled 3 open
- The closing round at 9e01b2c: raised nothing, and ruled 1 fixed and 2 open

**Notes**

- The closing round ruled on the 3 threads the round cap left open, and settled 1: `packages/sync/src/queue.ts:134` — Retry backoff resets on every enqueue (fixed)
- The episode ended at its round cap rather than with nothing left open
```

Where some rounds have no cost, the spend line counts the closing round among
the rounds, as "over 3 of 4 rounds". Where the time bound cut the closing round
short, its line names it "the closing round" rather than a round's number.

Each round is written to the episode's local state file as the review finishes,
before anything is posted. The closing replies it could not post are added when
it records its end, and its posting time once posting ends:

```json
{ "reviewer": "pi", "dollars": 0.0134, "tokens": 20100, "messages": 9, "models": ["openai/gpt-5-mini"], "elapsedSeconds": 901.2, "cutShortAtSeconds": 900, "postingSeconds": 4.3, "head": "1b86987c4f0e2d6a9b3c5e7f8a1d2c3b4e5f6a7b", "raised": 0, "ruled": { "fixed": 2, "withdrawn": 1, "open": 3 }, "unpostedReplies": ["`src/queue.ts:134` — Retry backoff resets (ruled fixed, and the reviewer's reply could not be posted on its thread)"] }
```

- `reviewer` is the reviewer CLI the round ran, as `reviewer` in [Configuration](adoption.md#configuration)
  names it.

- `dollars` and `tokens` are what the round spent, the dollars being zero where
  the reviewer's CLI did not price the model. `messages` is how many assistant
  messages the two cover, or for Copilot how many model requests. A round with no
  cost, which only a Copilot round can be, carries none of the three.
- `credits` is the AI credits the round spent, where the reviewer's CLI
  reported them, as Copilot does. It is absent for a `pi` round.
- `models` is every model the round's runs reported their spend against, in the
  order they first named each, spelled as the adapter reads them ([§ 4](adapters.md)). A round
  that ran the reviewer twice names the models of both runs. It is absent where
  no run named a model, and a round with no cost carries none.
- `elapsedSeconds` is the wall clock from starting the reviewer to having it
  stopped, to a tenth of a second. A round that ran the reviewer twice counts
  both runs.
- `cutShortAtSeconds` is the time bound the round ran under, present only where
  the bound ended a review the reviewer had not finished.
- `postingSeconds` is the wall clock from the first call of the posting reserve to
  the last, to a tenth of a second. It is absent where the round posted nothing,
  and where the round was stopped before posting ended.
- `floor` is `true` where the round's cost is a floor ([§ 4, The `pi` adapter](adapters.md#the-pi-adapter)),
  and absent where it is a total. A Copilot round never carries it.
- `head` is the full head commit of the state the round reviewed.
- `raised` is how many findings the reviewer reported, whether or not their
  comments were posted.
- `ruled` counts the rulings the round set out to reply with, by verdict: a
  `fixed` or `withdrawn` verdict on a thread that was open when it was handed
  over, and every `open` verdict the reviewer gave. A verdict naming a thread
  that was not handed over, and a second verdict on one thread, are not counted.
  The counts are taken before anything is posted.
- `unpostedReplies` is the Notes line of each reply on a thread the round
  closed that GitHub refused, and is absent where none was refused. A round
  that fails records none, and lists them in its failure comment.
- `closing` is `true` on the closing round's entry, and absent on every other.
  The round cap counts the entries that do not carry it. The closing round's
  `raised` is 0, because the findings its reviewer reported were not posted.

A state file written before `elapsedSeconds`, `cutShortAtSeconds`,
`postingSeconds`, `floor`, `credits`, `reviewer`, `models`, `head`, `raised`,
`ruled`, `unpostedReplies` and `closing` existed has none of them, and reads back
as rounds with no timing, no cut, no credits, no reviewer and no model, costs
that are totals, no record of what they reviewed or ruled, and no closing round.
A field that is there and does not hold a value of the right kind makes the file
unreadable, like any other.

The comment leads with the tokens, because every reviewer reports them and not
every reviewer is priced. A model run on a subscription has no dollar figure at
all, and the line carries none for it. Where some rounds were priced and others
were not, the dollar total covers the rounds that carry one.

**A Copilot round carries AI credits in place of dollars**, to two decimal
places. Copilot reports no dollars, so the line shows none for its rounds, and
never shows zero dollars for them:

```markdown
31,400 tokens over 2 rounds: 18,200, 13,200 · 0.84 AI credits
```

Where some rounds carry credits and others dollars, the line gives both totals,
each covering the rounds that carry it.

A round that completed no assistant message is given as unknown rather than as
zero. Nothing it spent was reported, and zero would say it spent nothing.

**A round with no cost has no figure in the line**, neither a zero nor a floor.
The line covers the rounds that have one, and says how many those are:

```markdown
18,200 tokens over 1 of 2 rounds · 0.36 AI credits
```

Where no round of the episode has a cost, the comment carries no spend line.

**A figure that is a floor reads "at least".** That is a round whose cost is a
floor, and every total of an episode holding one, its tokens, its dollars and
its credits alike. An episode none of whose rounds is a floor reads as the format above
shows. Here the second of two rounds is a floor:

```markdown
At least 36,500 tokens over 2 rounds: 20,100, at least 16,400 · at least $0.0105
```

A round the time bound killed is one such round. It reports its **last tracked
spend**, which covers the assistant messages that completed, and the message in
flight when the reviewer was killed was spent and never reported. A Copilot
round the bound stopped has no cost, and so no figure. A floor round
that completed no assistant message is given as unknown, and the totals beside it
are still marked, because what it spent is in none of them.

**The reviewer line names the reviewer CLI each round ran and the model the run
reported.** The model comes from the run: from each assistant message for `pi`,
and from the usage line for Copilot, as [§ 4](adapters.md) sets out for each adapter. The
`model` that `.squiz.json` configures never stands in for it, because a CLI can
run a model other than the one it was handed. A round whose run reported no
model reads "an unknown model". A Copilot round with no cost is one, and so is a
`pi` round killed before its first message completed.

Where every round ran the same reviewer on the same models, the line names them
once:

```markdown
Reviewed by `pi` on `openai/gpt-5-mini`
Reviewed by `copilot` on `gpt-5-mini` and `claude-haiku-4.5`
```

Where the rounds differ, each model is named with the rounds that ran on it,
under the reviewer that ran them, in the order the rounds first named each. A
round that ran two models is listed under both:

```markdown
Reviewed by `pi` on `openai/gpt-5-mini` in rounds 1 and 3, and on an unknown model in round 2
Reviewed by `pi` on `openai/gpt-5-mini` in rounds 1 and 2, and by `copilot` on `gpt-5-mini` in round 3
```

Each model is one code span on one line, with every run of whitespace in its
name collapsed to a space. A round recorded with no reviewer reads "an unknown
reviewer". An episode that ran no round has no reviewer line.
