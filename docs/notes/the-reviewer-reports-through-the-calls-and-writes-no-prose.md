---
settles: "§ 4 — whether a real reviewer reports through the three calls, whether the charter produces a review worth posting, and how far the reviewer honours the declared scope; § 7 — what tells a run that reached the model from one that did not, and what bounds a round"
issue: [105, 165]
recorded: 2026-09-26
versions: { pi: 0.85.1, provider: deepseek, model: deepseek-v4-pro, node: 24.15.0 }
recheck-when: pi upgrades, the reviewer's model changes, or the charter or its reporting calls change
---

# The reviewer reports through the calls and writes no prose

## Intent

- **Nothing had tried the reporting calls against a model.** The charter and the
  three tool descriptions are the whole of what steers a reviewer to
  `report_finding`, and a reviewer that describes a finding in prose instead
  returns nothing at all, because no message it writes is read.
- **Whether the charter produces a review worth posting**, and whether the
  reviewer verifies before it reports with reading tools alone.
- **Whether the reviewer honours the scope the description declares.**
- **Nothing said whether `finish_review` arrives**, before or after the reports,
  or in the same assistant message as one.
- **Nothing said whether a round that reported nothing can be told from a round
  that reviewed nothing.**
- **Nothing said what a round costs or how long it takes.**
- **Nothing said whether the tree survives** a live round where the grant is the
  only thing holding it.
- **Nothing said what a reviewer does with the harness's own files it can
  reach**: the compiled extension and `charter.md`.

## Decisions

- **Ship the three calls.** Three rounds of three called `report_finding` and
  then `finish_review`, the round read every report back, and the seeded defect
  was reported in all three. No assistant message in any round carried a line of
  prose: every one carried thinking and tool calls and nothing else, so nothing
  was returned outside a call.
- **Ship the charter: it produces a review worth posting.** Every finding was a
  correctness finding about the seeded defect, and none was a kind the charter
  excludes by category: no formatting, no naming, no import order, nothing the
  compiler catches, and no "consider whether". Every round read the changed
  files and grepped for callers before reporting.
- **Do not rely on the reviewer honouring the declared scope.** Under the
  earlier contract, where the reviewer returned its findings as one last
  message, one finding in five over four runs on the same pull request was
  outside the scope its description declared: true on its own facts, and not a
  finding. The three rounds here stayed inside it. Nothing in the round weighs a
  finding against the description, so a person dismisses such a comment.
- **Read severity as ordering and nothing more.** The same defect came back
  `high`, `medium`, `medium` and `high` in the four earlier runs, and `high`,
  `medium` and `medium` here.
- **Do not read a `stopReason` of `stop` as the sign that a run reached the
  model.** All 49 assistant messages over the three rounds carried `toolUse`,
  because the round then stopped the reviewer on `finish_review` before the
  model wrote a closing message. What says a run is a review is the model name
  and the non-zero usage on each completed message, together with tool answers
  that came off disk. Since then the extension ends the reviewer with
  `ctx.shutdown()`, which lets the closing message arrive, and that message
  does carry `stop`, as
  `the-reviewer-stops-two-seconds-after-it-finishes.md` records.
- **Keep a finished review ahead of the stop reason in deciding what a run
  established.** Every one of the three rounds was a review the reviewer
  finished and a run with no `stop` anywhere in it, so a reader that asked about
  the stop reason first would have called all three unreviewed and posted
  nothing. Leave the stop-reason test itself alone: a reviewer that writes prose
  and ends its turn does carry `stop`, which is the row asking for a retry, and a
  run with a bad credential completes one errored message, so deciding the row on
  whether any message completed would retry a setup problem forever.
- **Tell an empty review from an absent one by the finish.** A round that
  reported nothing and recorded a finish is a review that found nothing. One
  with no finish is a review that stopped without finishing. The round reads
  that from the report file, which records reports, refusals, usage and the
  finish but no read-tool call. Where a person needs to know how widely such a
  reviewer read, its calls are in the session `pi` keeps under
  `rounds/<k>/session/`. When this was measured they were read from the
  stream's `tool_execution_start` events, and the three rounds made 4, 43 and 24
  calls that were not reports.
- **Bound a round on tokens, and set no bound below the widest round measured.**
  The three rounds used 53,933, 873,569 and 321,396 tokens, took 70, 314 and 188
  seconds, and cost $0.0472, $0.2048 and $0.1090. The widest is the round that
  found the seeded defect, so a bound under it cuts off a good review. A round's
  size tracks how widely the reviewer reads rather than what it finds: cache
  reads were 819,000 of that round's 874,000 tokens, so every file opened is
  re-sent on every later request of the round. Dollars stay recorded and
  reported, and bound nothing: a subscription puts no price on a round, and this
  model was repriced within a week.
- **A grant of reading tools and reporting calls leaves the tree alone.** After
  each of the three rounds `git status --porcelain` was empty, `HEAD` was
  unchanged, and the hash of `git ls-files -s` was identical to the reading taken
  before the first round.
- **Put nothing in the extension or in what it imports that the reviewer must
  not read.** `pi` compiles the extension and every module it imports with
  `jiti` into `TMPDIR`. When this was recorded `TMPDIR` was a scratch space
  inside the tree under review, and one round opened the compiled finding
  validator there and read it. `TMPDIR` is now the system's, outside the
  snapshot, and the reading tools are confined to the snapshot, but the rule
  stands for anything the reviewer can reach.
- **Hand the reviewer the tree's own `charter.md` like any other file it may
  read.** A rule telling the reviewer to disregard a file in the tree would
  misfire on every other project.
- **Expect a `line` anchor beside the defect rather than on it.** The four
  findings anchored to lines 31, 30, 30 and 16 of `scratch/queue/retry.ts`; the
  loop that owns the defect is line 29. Every anchor is a line the diff carries
  and every finding routed inline.

## Needs your input

Nothing.

## Reference

The calls, in the order each round made them:

| Round | Calls the reviewer made |
|---|---|
| 1 | `read`×2, `find`, `grep`, `report_finding`, `finish_review` |
| 2 | 43 calls of `read`, `ls`, `grep` and `find`, then `report_finding`×2, `finish_review` |
| 3 | 24 calls of `read`, `ls`, `grep` and `find`, then `report_finding`, `finish_review` |

`report_finding` and `finish_review` each arrived alone in their own assistant
message in every round, and `finish_review` last.

| Round | Outcome | Wall | Cost | Tokens | Assistant messages | Findings |
|---|---|---|---|---|---|---|
| 1 | `reviewed` | 70.3 s | $0.0472 | 53,933 | 4 | 1 |
| 2 | `reviewed` | 313.8 s | $0.2048 | 873,569 | 29 | 2 |
| 3 | `reviewed` | 188.0 s | $0.1090 | 321,396 | 16 | 1 |

What came back:

| Round | Scope | Anchor | Severity | Routes |
|---|---|---|---|---|
| 1 | `line` | `scratch/queue/retry.ts:31` | `high` | inline |
| 2 | `line` | `scratch/queue/retry.ts:30` | `medium` | inline |
| 2 | `line` | `scratch/queue/retry.ts:16` | `low` | inline |
| 3 | `line` | `scratch/queue/retry.ts:30` | `medium` | inline |

The seeded defect: `scheduleFor` loops `attempt < attempts`, so it returns one
entry fewer than the documentation above it promises. All three rounds read it
as mislabelling rather than as a missing entry, and every suggested fix
relabels the entries and leaves the loop, so a coding agent taking one would
leave the schedule one wait short.

The finding outside the declared scope, under the earlier contract, was a
`file` finding that the change's tests are not discovered by the project's
suite. The description declares its scope as "The backoff arithmetic and the
schedule. Nothing else in the repository is touched".

No reporting call was refused in any round. The four refusals across the three
rounds were read tools: `ls` and `read` on `.git`, which is a file rather than a
directory in a worktree, and `ls` on a path that did not exist.

## Limits

- **Three rounds, one defect, one pull request, one model.** Three of three is
  not a rate.
- **The wall times and the dollars are a floor** for a round that lets the
  reviewer write its closing message, which these rounds did not.
- **No thread existed**, so `report_verdict` is untried here, as is the refusal
  of a second ruling on one thread.
- **`finish_review` never shared a message with a report.**
- **Nothing was posted.** Anchors were checked with the harness's own
  `parseDiff`, `touchesLine` and `routeFindings` against the diff GitHub served
  for #162; no comment was created.
- **The reviewer knows the defect is there.** #162's description says it exists
  to be reviewed and that it carries a defect, and two rounds grepped the tree
  for what the defect was meant to be.
- **The history tools were not granted.** These rounds had the reading tools and
  the reporting calls alone.
- **A small change.** The diff was 1,950 bytes and the prompt 2,588.
- **The dollars are `pi`'s arithmetic**, from a catalogue that refreshes itself.
- **Every figure but the anchor checks was read from recorded streams that are
  not in the repository**, so re-establishing them means spending more rounds.
