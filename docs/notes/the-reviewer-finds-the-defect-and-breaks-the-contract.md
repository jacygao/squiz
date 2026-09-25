---
settles: "§ 4 — whether the charter produces a review worth posting, and whether a real reviewer honours the output contract"
issue: 105
recorded: 2026-09-25
versions: { pi: 0.85.1, provider: deepseek, model: deepseek-v4-pro, node: 24.15.0 }
recheck-when: pi upgrades, pi's default model changes, or the charter's output contract changes
---

# The reviewer finds the defect and breaks the contract

## Intent

- **Nothing had put a real model through this harness.** Every earlier result
  came from an executable named `pi` that answers in the stream's shape by
  construction, or from one recorded capture whose last message is prose.
- **Whether the charter produces a review worth posting was unknown.** A
  reviewer that returns nothing, or returns the formatting and naming notes the
  charter rules out, or reports outside the scope the description declares, or
  reports what it did not check, is a finding about the charter rather than a
  passing run.
- **Whether the reviewer verifies before it reports, given no shell.** Depth
  `read` grants `read`, `grep`, `find` and `ls` and nothing else.
- **Whether the scope and the anchor § 4 asks for are what comes back.**
- **Whether the output contract holds.** The stand-in emits one JSON object
  because it was written to; a model decides for itself.
- **Whether the tree survives a live round at depth `read`**, where the grant is
  the only thing holding it.
- **Whether one round fits § 7's bounds**, in seconds and in dollars.

## Decisions

- **Ship the charter as it stands: it produces a review worth posting.** Four
  runs returned five findings. Four are within the scope the description
  declares, all four the same correctness bug, and the seeded defect came back
  in every run. None of the five is a kind § 4 excludes by category — no
  formatting, no naming, no import order, nothing the compiler catches, and no
  "consider whether". The fifth broke § 4's other exclusion, the declared scope,
  which the next decision is about.
- **Do not rely on the reviewer honouring the scope the description declares.**
  One finding in five ignored it. § 4's Charter opens on that rule, and the
  exclusion is the thing a round has no other guard for: the excluded kinds are
  recognisable in a finding, and a finding outside the declared scope is
  correct on its own facts and wrong only against the description.
- **Treat unparseable output as a round's likeliest failure rather than an edge
  case.** Two of the four runs broke the output contract, in two different ways:
  one wrapped the object in a fence, one omitted the `verdicts` key. § 7 allows
  one retry and then calls the model API unavailable, which is what happened to
  the round whose first attempt had found the defect at `high` and named its
  consequence exactly.
- **Trust the reviewer to verify, and at `read` do not read silence about the
  tests as a claim about them.** Every run read both changed files and grepped
  the tree for callers before reporting, and no run claimed a test passes.
- **Expect `line` scope and a changed-line anchor, and expect the anchor to
  wander within the file.** All five findings carried a scope, four `line` and
  one `file`; every anchor was a line the diff carries; and one of the three
  anchors for the seeded defect was not the line a reader would point at while
  explaining it.
- **Read severity as ordering and nothing more.** One defect, four readings:
  `high`, `medium`, `medium`, `high`.
- **Leave the time bound at its 420-second default.** One attempt took 255 to
  308 seconds and the round that retried took 379 of its 420, so a bound below
  the default buys no retry at all.
- **Budget about $0.10 a round, and about $0.14 where it retries.** § 7's $0.50
  episode bound buys three rounds of this size, four if none of them retries.
- **Depth `read` leaves the tree alone.** Over three rounds `git status
  --porcelain` stayed empty, `HEAD` was unchanged, and `git ls-files -s` was
  identical before and after.

## Needs your input

- **Whether the harness tolerates a fenced object and an absent `verdicts`, or
  holds the contract and loses the round.** Recommended: tolerate both. Strip a
  single surrounding fence before parsing, and read an absent `verdicts` as no
  verdicts, since § 4 already treats a thread the reviewer ruled on nowhere as
  open, so an absent key would mean what silence already means. The run that
  broke the contract twice had found the defect both times, at `high` the first
  time. Taking the recommendation changes § 4's Charter, under what the reviewer
  returns, and § 7's failure row for output the adapter cannot parse.
- **Whether anything is to hold the declared scope, now that the reviewer does
  not always.** Recommended: leave it with the reviewer and let the leakage
  show. A round holds the description and could weigh a finding against it, but
  the judgement is the reviewer's under § 4, and a second reader of the
  description is a second thing that can disagree with it. The cost of leaving
  it is a comment a person dismisses; the finding was true and merely unasked
  for.
- **Whether § 4's severity table needs tightening**, since the same line came
  back `high` twice and `medium` twice and § 5 orders the summary by severity.
  Recommended: accept it. § 4 already says severity orders findings rather than
  deciding whether they count, so the cost is the order of one comment.

## Reference

Three rounds against pull request #162, one at a time, depth `read`, the bound
at 420 seconds. A round's two attempts are the one parse retry.

| Round | Attempts | Outcome | Wall | Cost | Tokens | Assistant messages | Tool calls |
|---|---|---|---|---|---|---|---|
| 1 | 2 | `unavailable` | 379.2 s | $0.1386 | 113,020 | 8 | 11 |
| 2 | 1 | `reviewed` | 307.6 s | $0.1085 | 155,096 | 8 | 14 |
| 3 | 1 | `reviewed` | 254.7 s | $0.0920 | 90,805 | 5 | 8 |

Three rounds came to $0.3392 over 358,921 tokens. Round 1's first attempt was
$0.0516 over 36,814 tokens in about 119 seconds, and its retry spent the rest.

### The two reasons the round reported

One per attempt of round 1, verbatim and truncated where the reason quotes the
message:

````text
the reviewer's last message is not JSON: ```json
the reviewer's last message carries no list of verdicts
````

The first attempt's object was valid and carried both keys, inside a fence. The
retry's was unfenced and carried `findings` alone.

### What came back

| Run | Scope | Anchor | Severity | In the declared scope |
|---|---|---|---|---|
| 1, first attempt | `line` | `scratch/queue/retry.ts:29` | `high` | Yes |
| 1, retry | `line` | `scratch/queue/retry.ts:29` | `medium` | Yes |
| 1, retry | `file` | `scratch/queue/retry.test.ts` | `low` | **No** |
| 2 | `line` | `scratch/queue/retry.ts:16` | `medium` | Yes |
| 3 | `line` | `scratch/queue/retry.ts:30` | `high` | Yes |

The four `line` findings are all the seeded defect: `scheduleFor` loops
`attempt < attempts`, so it returns one entry fewer than the documentation above
it promises. Three of the four named the consequence the documentation names —
`scheduleFor(3)` returns two entries and the wait before the third attempt is
missing, so a caller summing the schedule underestimates.

`touchesLine` answers true for lines 16, 29 and 30 of `scratch/queue/retry.ts`
against the diff GitHub served, and every `line` finding routes inline.

### The one finding outside the declared scope

The `file` finding reported that the tests the change adds are not discovered by
the project's suite: `package.json` runs `node --test "src/**/*.test.ts"`, so a
test under `scratch/` never runs. That is true, and it is not a finding.

The description declares its scope as "The backoff arithmetic and the schedule.
Nothing else in the repository is touched", says of the tests only "three tests,
all passing", and says of itself "**Not for merging.** It exists to be
reviewed". Being in the suite is neither claimed nor asked for, and § 4's
Charter opens on the rule this breaks: a finding that contradicts something the
description declares out of scope is not a finding.

Accommodating it would make it retroactively right, so the tests stay where they
are.

### Where the reviewer's reading diverged

Round 3 resolved the contradiction by relabelling the entries rather than
restoring the missing one, so a coding agent that took its suggested fix would
leave the sum one wait short. Round 2 offered the loop fix first and relabelling
as an alternative. Both named the reason the fixture is ambiguous: `waitFor`'s
"the wait before attempt `n`" and the passing assertion that `scheduleFor(1)` is
`[]` cannot both hold.

### The model, and what depends on it

Provider `deepseek`, model `deepseek-v4-pro`, API path `openai-completions`,
priced from `pi`'s own catalogue at 1.32 input, 3.96 output and 0.044 cache-read
per million tokens. The adapter passes no `--model` and no `--provider`, so this
is `pi` 0.85.1's default and a changed default changes every figure here.

No assistant message in any run carried a `stopReason` of `error`, and every run
ended on one carrying `stop`. A run that never reaches the model looks complete
from outside — exit 0, empty stderr, every structural event present — so the
stop reason is what says a capture is a review.

## Limits

- **One defect, one pull request, one model.** Four of four is not a rate.
- **Round 1 only.** No thread existed, so every run returned `verdicts: []`, and
  the rules for ruling on a thread are untested against a model.
- **Nothing was posted.** The anchors were checked against the real diff with
  the harness's own validator; no comment was created, so what GitHub accepts is
  unverified here.
- **The clean tree rests on the grant and on two readings taken by hand.** The
  tracked-file comparison is M7's, and depth `deep` was not run, so whether a
  reviewer told to report rather than repair reaches for a write through `bash`
  is still open.
- **A small change.** The diff was 1,950 bytes and the prompt 2,584. Nothing
  here says what a reviewer does with a large one, or what it costs.
- **The dollars are `pi`'s arithmetic**, from a catalogue that refreshes itself.
- **The `file` scope appeared once**, on the one finding outside the declared
  scope and in the run the harness discarded, so nothing has yet scoped a
  finding to a file and meant it.
- **Whether the declared scope holds on a description that declares less.**
  #162's scope section is explicit and was still overstepped once. A change
  whose description says nothing about scope was not tried.
- **Wall times were measured one round at a time** on an otherwise idle machine,
  and provider latency varies.
- **Every figure here but the anchor checks was read from one recorded stream
  that is not in the repository.** The stream is too large to commit, so a
  reader cannot recompute the costs, the token counts, the attempt and tool-call
  counts or the wall times from anything committed; they are this author's
  reading of that capture, and re-establishing them means spending another run.
  The anchors are the exception: `parseDiff`, `touchesLine` and `routeFindings`
  can be run again over #162's diff.
