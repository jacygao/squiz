---
settles: "§ 4 — whether a real reviewer reports through the three calls, and § 7 — what tells a capture that reached the model from one that did not, now that a finished review carries no stop reason"
issue: 165
recorded: 2026-09-26
versions: { pi: 0.85.1, provider: deepseek, model: deepseek-v4-pro, node: 24.15.0 }
recheck-when: pi upgrades, pi's default model changes, or the charter's reporting contract changes
---

# The reviewer reports through the calls and writes no prose

## Intent

- **Nothing had tried the reporting calls against a model.** The charter and the
  three tool descriptions are the whole of what steers a reviewer to
  `report_finding`, and a reviewer that describes a finding in prose instead
  returns nothing at all, because no message it writes is read.
- **Nothing said whether `finish_review` arrives**, before or after the reports,
  or in the same assistant message as one — which is the case the round's own
  stop of the reviewer exists for.
- **Nothing said whether `report_verdict` is called where there is nothing to
  rule on.**
- **Nothing said whether a round that reported nothing can be told from a round
  that reviewed nothing.** That distinction is the only fallback left if a
  reviewer ignores the calls.
- **Nothing said whether the round's conclusion matches what the reviewer did.**
- **Nothing said what a round now costs or how long it takes**, now that the
  round ends the run itself rather than waiting for a last message.
- **Nothing said whether the tree survives**, since at depth `read` the grant is
  the only thing holding it.

## Decisions

- **Ship the three calls.** Three rounds of three called `report_finding` and
  then `finish_review`, the round read every report back, and the seeded defect
  was reported in all three. No assistant message in any round carried a line of
  prose: every one carried thinking and tool calls and nothing else. There is no
  longer a last message to lose, and nothing was returned outside a call.
- **Do not read a `stopReason` of `stop` as the sign that a capture reached the
  model.** All 49 assistant messages over the three rounds carried `toolUse`,
  and none carried `stop` or `error`, because the round stops the reviewer on
  `finish_review` before the model writes a closing message. A successful round
  now looks, by stop reason alone, exactly like a run that reached no model at
  all. What says a capture is a review is the model name and the non-zero usage
  on each completed message, together with tool answers that came off disk.
- **Keep a finished review ahead of the stop reason in deciding what a run
  established.** It is load-bearing rather than tidy. Every one of the three
  rounds was a review the reviewer finished and a run with no `stop` anywhere in
  it, so a reader that asked about the stop reason first would have called all
  three unreviewed, reported that the reviewer completed no message, and posted
  nothing.
- **Read the reviewer's own tool calls to tell an empty review from an absent
  one.** `tool_execution_start` carries the name and the arguments of every call
  the reviewer makes, read tools and reporting calls alike, so a round that
  reported nothing is readable as one that opened nothing or one that opened a
  great deal. The three rounds made 4, 43 and 24 calls that were not reports.
  The fallback the reporting risk needs is available.
- **Treat `report_verdict` as unmeasured.** #162 carries no thread and no round
  called it. Three rounds that reported findings and finished say nothing about a
  round that must rule on one.
- **Budget a round at up to $0.21 and 320 seconds.** The three rounds cost
  $0.0472, $0.2048 and $0.1090 and took 70, 314 and 188 seconds. Cost tracks how
  widely the reviewer reads rather than what it finds: cache reads were 819,000
  of the widest round's 874,000 tokens, so every file opened is re-sent on every
  later request of the round.
- **Leave the time bound at 480 seconds.** The longest round used 314 of it, and
  a bound below 320 would cut off the widest reading measured with the review
  nearly done.
- **Depth `read` leaves the tree alone.** After each of the three rounds `git
  status --porcelain` was empty, `HEAD` was unchanged, and the hash of `git
  ls-files -s` was identical to the reading taken before the first round.
- **Put nothing in the extension or in what it imports that the reviewer must
  not read.** `pi` compiles the extension and every module it imports with
  `jiti` into `TMPDIR`, which is the scratch space inside the tree under review,
  and one round opened the compiled finding validator there and read it. The same
  round read the repository's git directory, including the metadata naming the
  harness's own worktree.
- **Expect a `line` anchor beside the defect rather than on it.** The four
  findings anchored to lines 31, 30, 30 and 16 of `scratch/queue/retry.ts`; the
  loop that owns the defect is line 29. Every anchor is a line the diff carries
  and every finding routed inline.

## Needs your input

- **Whether § 7's two failure rows are still told apart, now that no finished
  review carries a stop reason.** A run is reported as having completed no
  message, and is never retried, when no assistant message carried `stop`. Under
  the old contract every finished review carried one, so its absence meant the
  run reached no model. It is now absent from every round, successful ones
  included, so a round that reported nothing, did not finish, and lost its
  process without a stop reason is reported with the reason "the reviewer
  completed no message" however many messages it completed — while § 7's row for
  a reviewer that stops without finishing its review asks for one retry.
  Recommended: decide that case on whether any assistant message completed,
  which the round already counts, and leave the stop reason out of it. It
  touches § 7's failure table, the row for a reviewer that completes no message
  and the row for one that stops without finishing.
- **Whether § 7's $0.50 episode bound still buys the three rounds § 7's round cap
  allows.** One of the three cost $0.2048, which is 41% of it. Recommended:
  leave the bound. Three rounds of the widest reading measured would exceed it,
  and closing the episode after two is what the bound is for; the figure to
  revisit is the round cap's default, not the dollars.
- **Whether the scratch space belongs inside the tree under review**, now that
  `pi` writes the harness's own compiled extension and validator into it.
  Recommended: leave it there. Neither file holds anything secret, and moving
  `TMPDIR` outside the worktree gives up the guard that a probe script cannot
  land in the tree. It touches § 4's Confinement, the scratch-space row.
- **Whether a reviewer reviewing this repository should be handed the tree's own
  `charter.md`.** One round read it, found it describing the final-message
  contract this branch replaced, and wrote out its reasoning for preferring its
  system prompt before continuing. It chose correctly, and it paid a request to
  do so. Recommended: accept it. The charter reaching the reviewer twice is a
  property of squiz reviewing squiz and not of the harness, and a rule telling
  the reviewer to disregard a file in the tree is a rule that would misfire on
  every other project.

## Reference

The three calls, in the order each round made them, one line per round:

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

Three rounds came to $0.3609 over 1,248,898 tokens in 572 seconds. Each round's
outcome and findings are exactly what the reviewer reported, and every round
returned `verdicts: []`.

What came back:

| Round | Scope | Anchor | Severity | Routes |
|---|---|---|---|---|
| 1 | `line` | `scratch/queue/retry.ts:31` | `high` | inline |
| 2 | `line` | `scratch/queue/retry.ts:30` | `medium` | inline |
| 2 | `line` | `scratch/queue/retry.ts:16` | `low` | inline |
| 3 | `line` | `scratch/queue/retry.ts:30` | `medium` | inline |

All four are within the scope #162's description declares, and none is a kind
§ 4 excludes by category. All three rounds read the seeded off-by-one as
mislabelling rather than as a missing entry: the `waitMs` values are right, the
`attempt` field names the attempt before the one the wait precedes, and the
schedule never names the final attempt. Every suggested fix relabels the entries
and leaves the loop, so a coding agent taking one would change the labels.

No reporting call was refused in any round. The four refusals across the three
rounds were read tools: `ls` and `read` on `.git`, which is a file rather than a
directory in a worktree, and `ls` on a path that did not exist.

The files `pi` writes into the scratch space, one set per round:
`jiti/pi-extension.3ffe37ba.mjs`, `jiti/findings-reported.e5960af2.mjs` and
`jiti/pi-reporting.a0aa6585.mjs`.

## Limits

- **Three rounds, one defect, one pull request, one model.** Three of three is
  not a rate.
- **The rounds ran against the branch as it stood before it was taught to wait
  for the finishing message's answers before stopping the reviewer.** Which call
  the reviewer makes is not what that changes, but when the round stops the run
  is, so the wall times and the dollars are a floor for the version that waits.
- **Round 1 only.** No thread existed, so `report_verdict` is untried against a
  model, as is the refusal of a second ruling on one thread.
- **`finish_review` never shared a message with a report**, so the round's stop
  of a reviewer that reports and finishes in one message is still untried
  against a model, and so is a report still on its way when the round stops the
  reviewer.
- **No call was ever refused**, so a refusal reaching the reviewer and the
  reviewer correcting the call is untried against a model.
- **Nothing was posted.** Anchors were checked with the harness's own
  `parseDiff`, `touchesLine` and `routeFindings` against the diff GitHub served
  for #162; no comment was created.
- **The reviewer knows the defect is there.** #162's description says it exists
  to be reviewed and that it carries a defect, and two rounds grepped the tree
  for what the defect was meant to be. Nothing here says what a reviewer does
  with a change that does not advertise one.
- **The clean tree rests on the grant and on three readings taken by hand.**
  `git status --porcelain`, `HEAD` and the hash of `git ls-files -s`, after each
  round. Depth `deep` was not run.
- **Each round ran with its own directory under `.squiz/`**, where an episode
  gives its rounds one. A round could therefore list what the rounds before it
  left; in an episode it would see the same episode's.
- **A small change.** The diff was 1,950 bytes and the prompt 2,588. Nothing
  here says what a reviewer does with a large one, or what it costs.
- **The dollars are `pi`'s arithmetic**, from a catalogue that refreshes itself.
- **Wall times were measured one round at a time** on an otherwise idle machine,
  and provider latency varies.
- **Every figure but the anchor checks was read from three recorded streams that
  are not in the repository**, of 8,733, 35,408 and 20,665 lines. They are too
  large to commit, so re-establishing the costs, the token counts, the message
  counts and the wall times means spending another three rounds.
