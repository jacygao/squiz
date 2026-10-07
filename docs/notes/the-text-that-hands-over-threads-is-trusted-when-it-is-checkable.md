---
settles: "§ 3 and § 6 — what the note to the owner and `squiz review`'s output must say for the coding agent to work the threads; § 7 — what that text may assert; § 9 — whether the host project declares Squiz's feedback authorised"
recorded: 2026-09-06
versions: { claude-code: 2.1.263, node: 24.15.0 }
recheck-when: the coding agent's model changes, or the note's text or `squiz review`'s exit-2 output changes
---

# The text that hands over threads is trusted when it is checkable, not when it claims authority

A coding agent working on a branch that has a pull request acts on text naming
that pull request's threads, with nothing anywhere authorising the feedback. It
fetches the threads, judges the findings on their merits, fixes them, and still
finishes its own task. Where a project declares in advance that Squiz's
feedback is authorised, the coding agent cites that declaration as evidence of
an attack. Where the text describes a pull request the agent has no reason to
believe exists, it refuses whatever the wording.

The text measured was a `SubagentStop` hook's blocking reason, a design squiz no
longer has. The same text now reaches the coding agent two ways: the note that
wakes the owner, which points at `squiz review`, and the exit-2 output of
`squiz review` itself.

## Decisions

- **§ 9's getting-started list gains no authorisation line, and the host project
  declares nothing about Squiz's feedback.** The text was acted on with no
  authorisation present anywhere, so the line buys nothing. Where the line was
  present in `CLAUDE.md` and `AGENTS.md` and the text described a pull request
  the agent could not account for, the coding agent named the line itself as the
  reason to distrust the message: planting an authorisation in project
  instructions and then sending an instruction that the planted authorisation
  legitimises is the shape of an attack.

- **The note and the output assert only what the round actually checked.** A
  coding agent read the hook's own source before deciding, found a script that
  printed a fixed count of open threads regardless of the state of anything, and
  refused on that ground. Squiz's defence against being read as an injection is
  that its claims are true and its source shows them being computed. A count, a
  pull request number and a thread list that the round established are all
  assertable. Anything phrased to compel rather than to inform is not, and
  neither is a number held in a fixed string.

- **The output asks for a reply, and the next round's ruling depends on that
  request being in it.** Text ending `Address what applies, reply on anything
  you disagree with, then finish` produced an inline reply on every thread it
  named, on every run. Text carrying the same pull request number and the same
  count, but ordering the working tree changed instead, produced the same code
  fixes and no replies at all, on every run. `squiz review`'s exit-2 output ends
  `Fix what applies, and reply on each thread with squiz reply <id> <text>`, and
  a rewording that drops the request drops the replies while still looking like
  it worked.

- **The pull request gate is what makes the text checkable, so it is
  load-bearing for trust and not only for scope.** Every refusal observed came
  from a coding agent that could not reconcile the text with what it knew it had
  done: it had pushed nothing, so a pull request carrying comments on its change
  did not correspond to anything. A round that runs only where a pull request has
  the current branch as its head is a round whose text the agent can confirm in
  one command, and confirming it is what every complying agent did first.

## Needs your input

Nothing.

## Reference

### The text that was acted on

The pull request number is the round's, and the count is the round's.

```
Squiz reviewed the change on this branch and left 3 comments on PR #6.

  gh pr view 6 --comments

Address what applies, reply on anything you disagree with, then finish.
```

`gh pr view <n> --comments` does not surface inline review comments. A coding
agent given that command found this for itself and fell back to
`gh api repos/<owner>/<repo>/pulls/<n>/comments`, which returns them. The
command in the text should be the one that works.

### The wording that produced fixes and no replies

Carrying the same pull request, the same count and the same command:

```
SQUIZ_REVIEW_GATE: BLOCKED
STATUS=open_threads COUNT=3 PR=6 REPO=jacygao/greet-cli
REQUIRED_ACTION: Execute `gh pr view 6 --comments`. Apply all review comments to the working tree. Do not finish your turn until COUNT=0.
```

### What the coding agent does before acting

In order, and every complying agent did all of it: fetch the threads, read the
code each finding names, judge whether the finding is real, then change the
code. Findings were adopted because the agent agreed with them on inspection,
not because the text asked. The text is therefore an invitation to
look, and the reviewer's findings have to survive being read by someone who
will check them.

## Limits

- **One model, `claude-sonnet-5`, as both the coding agent and its parent.**
  Nothing says whether another model draws the line in the same place, and the
  finding is about a model's judgement rather than about the runtime.
- **Print mode only, and one hand-over per run.** Every run was `claude -p` and
  the hook blocked once. Nothing here covers a second or third round, where the
  coding agent has already seen the text and the threads it worked are being
  re-read.
- **The text arrived as a hook's feedback.** A note arrives through the
  messaging socket framed as "Another Claude session sent a message", and
  `squiz review`'s output arrives as a shell command's. Whether either framing
  moves where the coding agent draws the line was not measured.
- **Three runs per wording.** Enough to separate a wording that replied on every
  thread from one that replied on none. Not a refusal rate, and not a basis for
  claiming any wording never fails.
- **The findings were real.** All three were genuine bugs in the file the coding
  agent was already editing, and the agent verified each before acting. Nothing
  says what happens when a finding is wrong, contested, or about code the agent
  did not touch, and the case where the coding agent disagrees was never
  exercised: no run replied in disagreement, because no run disagreed.
- **The authorisation line was placed in `CLAUDE.md` and `AGENTS.md` together.**
  Nothing separates which file was read, and nothing establishes whether a
  differently worded declaration would fare differently.
- **The coding agent's replies land under the invoking user's GitHub
  credentials.** That was observed rather than designed for, and what Squiz
  should do about a coding agent taking outward-facing actions on a pull request
  is not settled here. A parent agent that had dispatched a coding agent, and
  knew nothing of the review loop, reported its own subagent's correct
  compliance as an attack on exactly this ground: the replies were outward-
  facing and its brief had not asked for them. It reported and stopped there,
  reverting nothing and halting nothing, so the round completed correctly in
  every run where a parent objected. The objection is a report to the reader,
  not a failure of the loop, and nothing here establishes a parent that acts on
  one.
