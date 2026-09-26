---
settles: "§ 3 — whether a live episode blocks, is acted on and closes itself, and what one costs; § 4 — whether a reviewer rules on the threads it is handed; § 2 — whether a coding agent's reply carries the marker Identity gives it"
issue: 154
recorded: 2026-09-26
versions: { claude-code: 2.1.270, pi: 0.85.1, provider: deepseek, model: deepseek-v4-pro, coding-agent: claude-sonnet-5, gh: 2.97.0, node: 24.15.0 }
recheck-when: the coding agent's model changes, pi upgrades, or § 3's blocking reason changes
---

# The coding agent acts on the block, and the episode closes itself

## Intent

- **Nothing had run the loop.** Every part of it had been measured on its own —
  the hook, the reviewer, the GitHub calls, the reason — and nothing had put a
  real subagent, a real pull request and a real reviewer in one episode.
- **Nothing said whether a coding agent acts on the reason § 3 composes.** The
  wording that was acted on in an earlier measurement named a `gh` command; the
  one that ships names `squiz threads` and `squiz reply`, which no agent had
  ever been handed.
- **`report_verdict` was unmeasured.** No round had ever ruled on a thread,
  because no pull request under review had ever carried one.
- **Nothing said what an episode costs or how long it takes**, as against a
  single round.
- **Nothing said whether a resolved thread can reach a later round at all.**
- **Nothing said whether the agent that dispatched the subagent reads a
  blocked-and-resumed result as tampering**, which an earlier run had done.

## Decisions

- **Ship the loop. It ran end to end and the block was acted on.** Round 1
  posted two inline threads and exited 2. The coding agent read the reason,
  fetched the threads, read the file, said both findings held, fixed both,
  pushed, and replied on both. Round 2 was handed all three threads on the pull
  request, closed every one of them, found nothing new, and exited 0 with the
  episode's state written. Nothing declined anything.

- **Budget an episode in cents on the reviewer and in tens of cents on the
  coding agent.** The two rounds cost $0.0421 between them, and the Claude Code
  session that drove them cost $0.2861 — about seven times as much. An episode
  is dominated by the agent being blocked, not by the agent doing the blocking.

- **A round of this size is seconds, not minutes.** 18.7 and 54.9 seconds
  against a 480-second bound. § 7's shares were never approached, so nothing in
  the window arithmetic was exercised by this run.

- **`report_verdict` works against a model, and a thread it rules closed stays
  closed.** Three verdicts, three threads, all three closed. One of them was
  already resolved and carried a person's comment rather than a finding, and the
  reviewer ruled on it rather than passing over it — which matters, because a
  thread it had passed over would have taken the default verdict of `open` and
  been re-opened.

- **Give a coding agent's reply the marker § 2 Identity gives it.** `squiz
  reply` posts the text it is handed and composes nothing, so both replies went
  up unmarked and read back as a person's. § 4's `disputed` status is a thread
  the coding agent replied on, and there is nothing to read that from. Issue
  #194 carries it.

- **Expect the coding agent to reach past the commands the reason names.**
  `squiz threads` prints an identifier and a location, so an agent that has been
  told two threads are open still cannot see what either says. It tried `squiz
  --help`, got the usage line, and fell back to `gh api graphql` for the comment
  bodies. Everything it then did was right, so this cost the round nothing — but
  the commands § 6 ships are not sufficient on their own to work a thread.

- **An episode closes itself before the cap, and that is the ordinary ending.**
  The cap was 3 and the episode ran 2 rounds, closing because nothing was left
  open. A demonstration that wants the cap reached has to leave a finding
  unfixed.

- **A blocked-and-resumed result is not read as tampering, and is still reported
  as unasked-for work.** The dispatching agent verified the pushed commit for
  itself, said the subagent had gone beyond its brief by editing functions it
  was not asked to touch and by replying on pull request threads, and noted that
  the subagent's final message never mentioned the task it was given. It named
  no attack and no injection, and it reverted nothing and halted nothing.

## Needs your input

- **Whether `squiz threads` should carry each thread's severity and headline.**
  § 6 gives it an identifier and a location, and the coding agent went to `gh
  api graphql` for the rest. Recommended: add them. The reason already tells the
  agent two threads are open and invites it to look; sending it to a second tool
  to find out what they say is a step the harness can take for it, and the
  parser that reads a headline off a thread is being built for the summary
  comment anyway.

- **Whether M5's acceptance criteria should stop asking the coding agent to
  resolve a thread.** `docs/specs/milestones.md` § M5 asks for round 2 to run
  "after the coding agent resolves one thread and replies on another", and § 3
  says the coding agent "does not close threads", and § 6 gives it no command
  that could. Nothing in the loop can put a resolved thread in front of round 2:
  the earliest a round can be handed one is round 3, after round 2's own `fixed`
  verdict closed it. The resolved thread this run handed round 2 was posted and
  resolved by hand beforehand, and is a person's thread rather than the loop's.
  Recommended: reword the criterion to ask for a resolved thread and a
  replied-to thread, whatever put them there, since that is what the round's
  behaviour actually turns on.

## Reference

The episode ran against pull request #185, from a session started with
`claude --plugin-dir <plugin root> -p --model sonnet --permission-mode
acceptEdits --allowed-tools Bash Read Write Edit Task Glob Grep
--output-format stream-json --verbose --include-hook-events
--forward-subagent-text`, whose prompt dispatched one subagent with the Task
tool. Its working directory was a worktree on the branch that pull request's
head names. The episode key was `a5f2da2e7c965a185`.

### The two rounds

Wall times are the interval between the `hook_started` and `hook_response`
events of one firing. Neither event carries a timestamp of its own, so the
session's stream was piped through `perl -MTime::HiRes=time -ne 'BEGIN{$|=1}
printf "%.3f %s", time, $_'` and each line stamped as it arrived. Cost, tokens
and messages are the entries the round wrote into
`.squiz/a5f2da2e7c965a185/state.json`.

| Round | Wall | Exit | Cost | Tokens | Assistant messages | Findings | Verdicts |
|---|---|---|---|---|---|---|---|
| 1 | 18.666 s | 2 | $0.011900 | 26,788 | 4 | 2 | none asked for |
| 2 | 54.907 s | 0 | $0.030190 | 62,119 | 7 | 0 | 3, all closing |

Two rounds came to $0.042090 over 88,907 tokens and 73.6 seconds of hook time,
inside a session of 182.5 seconds. `spentOutsideRounds` was zero on every field:
no attempt failed before it was a round.

The Claude Code session reported $0.286104 over 3 turns for the parent and the
subagent together.

### The blocking reason, verbatim

343 bytes on the hook's stderr, and the whole of what round 1 wrote there:

```
Squiz reviewed the change on this branch and left 2 comments on PR #185.

2 threads are open on it:
PRRT_kwDOUEd2qM6mPuUP scratch/paging/pages.ts:26
PRRT_kwDOUEd2qM6mPuVO scratch/paging/pages.ts:35

The commands that work them:
  squiz threads
  squiz reply <id> <text>

Address what applies, reply on anything you disagree with, then finish.
```

Round 2's stderr was empty, which is a round that closed the episode having
failed at nothing.

### What the coding agent did with it, in order

`squiz threads`; `squiz --help`, which answered `squiz: no command "--help". The
commands are: hook, threads, reply`; `gh api graphql` for the two threads with
their comment bodies; `git log` on the file and `git log main..HEAD`; a read of
the file; then `Both findings check out against the docstrings. Fixing both.`;
two edits; a commit and a push; `squiz reply` on both threads; and
`gh pr view 185 --json headRefOid` beside `squiz threads` to check both ends.

Both replies went up unmarked:

```
Confirmed. Fixed: pageCount now returns Math.ceil(total / perPage) in befac71.
Confirmed. Fixed: pageAt now starts at (number - 1) * perPage in befac71.
```

### The three threads round 2 was handed

| Thread | At hand-over | Carried | Left |
|---|---|---|---|
| `PRRT_kwDOUEd2qM6mPp0t` | resolved | a person's comment, no marker | resolved |
| `PRRT_kwDOUEd2qM6mPuUP` | open | the reviewer's finding, and a reply | resolved |
| `PRRT_kwDOUEd2qM6mPuVO` | open | the reviewer's finding, and a reply | resolved |

The first was posted and resolved by hand before the episode started, because
nothing in the loop can hand a resolved thread to round 2. The other two are
round 1's own, replied on by the coding agent between the rounds — 59.9 seconds
separated round 1's `hook_response` from round 2's `hook_started`.

### The defect the run was built on

`scratch/paging/pages.ts`, one file, nothing imports it. Its diff was 1,686
bytes at round 1, from `git diff main...<head>`, and 1,691 at round 2, from what
GitHub served. Two seeded defects, each a one-line contradiction of the doc
comment above it:

- `pageCount` returned `Math.floor(total / perPage)` where the comment says a
  short last page is a page of its own, so `pageCount(10, 4)` was 2 against a
  documented 3.
- `pageAt` computed `start = number * perPage` where the comment says pages
  count from 1 and page 1 starts at index 0, so page 1 began at index `perPage`
  and the first items were unreachable.

Both findings came back `line`-scoped at `high`. One anchor was the line the
defect is on, line 35; the other was line 26, the closing brace below the
`Math.floor`. The fixes were `Math.ceil(total / perPage)` and
`(number - 1) * perPage`.

### The tree after each round

`git status --porcelain` was empty after the episode, and no tracked file
differed from what the coding agent's own commits left. Depth `read` took
nothing from the tree.

## Limits

- **One episode, one defect pair, one pull request.** `claude-sonnet-5` as both
  the dispatching agent and the coding agent, `deepseek-v4-pro` as the reviewer.
  One run of one shape is not a rate, and the block was acted on once rather
  than repeatedly.

- **Whether each verdict was `fixed` or `withdrawn` was not established.** Both
  close the thread, the round records neither, and nothing on the pull request
  tells them apart. What is established is that every thread handed over was
  ruled on, because a thread the reviewer had passed over would have been
  re-opened and the episode would have blocked again.

- **Whether round 2 reported any finding at all was not established.** A finding
  scoped to `change` routes to the summary comment, the summary comment is not
  built, and such a finding is therefore posted nowhere and recorded nowhere. No
  new thread appeared, which rules out a finding that could have been anchored
  and nothing else.

- **The reviewer's own output was not kept.** The round reads the stream and
  discards it, `--no-session` left the session directory empty, and nothing
  records which files the reviewer opened, how many tool calls it made, or the
  stop reason of any message. Every figure above comes from the episode's state
  file, the hook events in the session's stream, or the pull request.

- **Two rounds, and the cap allows three.** The cap was never reached, the token
  bound was never approached at 62,119 tokens against 1,500,000, and neither
  closing reason was exercised. Nothing here says what a third round does.

- **No round failed.** Nothing timed out, nothing was salvaged, no finding went
  unposted, no verdict went unapplied, and the failure pointer on stderr was
  never written. Every row of § 7 remains as it was.

- **The rounds were far cheaper and faster than the rounds measured against pull
  request #162** — 18.7 and 54.9 seconds against 70 to 314, and $0.012 and
  $0.030 against $0.047 to $0.205 — on a diff of much the same size. The
  difference is how widely the reviewer read: 4 and 7 assistant messages against
  4, 29 and 16. Nothing here bounds that spread, and a round's cost is not
  predictable from the size of its diff.

- **The dollars are `pi`'s arithmetic**, from a catalogue that refreshes itself.

- **The pull request is a scratch one and its branch is not for merging.** It
  stays open as the record of this run; a later episode against it would add
  rounds to threads this note describes as settled.
