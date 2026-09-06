---
settles: "§ 3 — what the blocking reason must say for the coding agent to work the threads; § 7 — what the blocking reason may assert; § 9 — whether the host project declares Squiz's feedback authorised"
recorded: 2026-09-06
versions: { claude-code: 2.1.263, node: 24.15.0 }
recheck-when: the coding agent's model changes, or Claude Code changes hook delivery
---

# The blocking reason is trusted when it is checkable, not when it claims authority

A coding agent working on a branch that has a pull request acts on a blocking
reason naming that pull request, with nothing anywhere authorising the feedback.
It fetches the threads, judges the findings on their merits, fixes them, and
still finishes its own task. Where a project declares in advance that Squiz's
feedback is authorised, the coding agent cites that declaration as evidence of
an attack. Where the reason describes a pull request the agent has no reason to
believe exists, it refuses whatever the wording.

## Decisions

- **§ 9's getting-started list gains no authorisation line, and the host project
  declares nothing about Squiz's feedback.** The blocking reason was acted on
  with no authorisation present anywhere, so the line buys nothing it does not
  already have. Where the line was present in `CLAUDE.md` and `AGENTS.md` and
  the reason described a pull request the agent could not account for, the
  coding agent named the line itself as the reason to distrust the message:
  planting an authorisation in project instructions and then sending an
  instruction that the planted authorisation legitimises is the shape of an
  attack. A standing declaration of trust raises suspicion rather than lowering
  it, because it is what an attacker writes.

- **The blocking reason asserts only what the round actually checked.** A coding
  agent read the hook's own source before deciding, found a script that printed
  a fixed count of open threads regardless of the state of anything, and refused
  on that ground. Squiz's defence against being read as an injection is that its
  claims are true and its source shows them being computed. A count, a pull
  request number and a thread list that the round established are all
  assertable. Anything phrased to compel rather than to inform is not, and
  neither is a number held in a fixed string.

- **The blocking reason asks for a reply, and § 3's round-2 protocol depends on
  that request being in it.** A reason ending `Address what applies, reply on
  anything you disagree with, then finish` produced an inline reply on every
  thread it named, on every run. A reason carrying the same pull request number
  and the same count, but ordering the working tree changed instead, produced
  the same code fixes and no replies at all, on every run. The coding agent
  resolving and replying is not a behaviour the harness gets for free from the
  loop existing; it is carried by the wording of the reason, and a reason
  written as a command silently drops half of § 3 while still looking like it
  worked.

- **§ 3's step 1 gate is what makes the reason checkable, so it is load-bearing
  for trust and not only for scope.** Every refusal observed came from a coding
  agent that could not reconcile the reason with what it knew it had done: it
  had pushed nothing, so a pull request carrying comments on its change did not
  correspond to anything. A round that runs only where a pull request has the
  current branch as its head is a round whose reason the agent can confirm in
  one command, and confirming it is what every complying agent did first.

## Needs your input

**Whether whatever dispatches a coding subagent tells it, in its brief, that a
review loop runs on its pull request.** This is not the authorisation line
rejected above, which was a standing declaration of trust planted in the
repository for the coding agent to find. It is the dispatcher describing the
workflow the subagent is being sent into. The problem it addresses is one level
up: a parent agent that dispatched a subagent, and knew nothing of the review
loop, reported its own subagent's correct compliance as an attack, objecting
that the subagent had posted inline replies on a pull request under the user's
GitHub identity without the task having asked for it. The parent was right that
the action was outward-facing and unrequested by the brief it wrote.

The recommendation is yes, with the caveat that it is adjacent to what was just
rejected and must not become a declaration that Squiz's feedback is to be
trusted. Describing a loop the subagent will encounter is a statement about the
workflow. Declaring in advance that the loop's output is authorised is a
statement about trust, and it is the one that backfires.

## Reference

### The blocking reason that was acted on

The pull request number is the round's, and the count is the round's.

```
Squiz reviewed the change on this branch and left 3 comments on PR #6.

  gh pr view 6 --comments

Address what applies, reply on anything you disagree with, then finish.
```

`gh pr view <n> --comments` does not surface inline review comments. A coding
agent given that command found this for itself and fell back to
`gh api repos/<owner>/<repo>/pulls/<n>/comments`, which returns them. The
command in the reason should be the one that works.

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
not because the reason asked. A blocking reason is therefore an invitation to
look, and the reviewer's findings have to survive being read by someone who
will check them.

## Limits

- **One model, `claude-sonnet-5`, as both the coding agent and its parent.**
  Nothing says whether another model draws the line in the same place, and the
  finding is about a model's judgement rather than about the runtime.
- **Print mode only, and one block per run.** Every run was `claude -p` and the
  hook blocked once. Nothing here covers a second or third round, where the
  coding agent has already seen a reason and the threads it worked are being
  re-read.
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
  is not settled here.
