# Milestones

**Version:** 0.24 (draft)
**Status:** For review
**Owner:** TBD

---

Twelve milestones for building squiz, in the order they are done. Each ends in
something that can be run or seen, never in a module written.

| Order | Milestone | State |
|---|---|---|
| 1 | M0 — Prerequisites spike | Done |
| 2 | M1 — Plugin skeleton, configuration, and the gate | Done |
| 3 | M2 — The finding contract and the comment format | Done |
| 4 | M3 — The GitHub client and the coding agent's commands | Done |
| 5 | M4 — The reviewer | Done |
| 6 | M5 — The round | Done |
| 7 | M6 — The summary comment | Done |
| 8 | M7 — The reviewer as a detached session | Done |
| 9 | M10 — The subagent-era workarounds removed | |
| 10 | M11 — Depth `deep` | |
| 11 | M8 — Episode boundaries | |
| 12 | M9 — Install and dogfood | |

**A milestone's number names it, and the table places it.** M10 and M11 come
before M8 and M9 in the order.

**From M7, squiz runs its reviewer as a session of its own, instead of inside a
subagent's hook or shell call.** The review itself stays as it is: findings as
threads on the pull request, verdicts on replies, rounds, a cap, and a summary.
So do the commands the coding agent runs to read and answer it.

**`docs/specs/review-harness-spec.md` specifies the design**, from version
0.57. The session, trigger and wake code lives in `src/sessions/`, which knows
nothing about reviews and imports nothing from the rest of `src/`, so it can be
lifted out if a second tool needs it.

**The first version leaves three things out:** delivering a note when a session
starts, rules for acknowledging a note and retrying one, and messages in both
directions. Hooks for agents other than Claude Code, GitHub Copilot's among them,
come after M9.

M9 is the last of them. The P1 and P2 entries of the specification's What ships
that no milestone here delivers are a second version, and its milestones are
planned once M9 closes.

## M0 — Prerequisites spike

**Done.**

The confirmations named in the specification, run with `claude --plugin-dir ./`
against throwaway scaffolding. No production code survives this milestone. The
findings do.

### Acceptance criteria

A written finding in `docs/notes/` for each of:

- [x] `SubagentStop` fires, exit 2 feeds its reason back into the subagent's
      open turn, and the subagent resumes.
- [x] **The hook payload's fields, named exactly.** M1 to M6 keyed an episode
      on the subagent's id from that payload, so confirm the field exists and is
      the same every time that subagent stops. M7 rekeys the episode on the
      pull request's number, which no payload field decides.
- [x] Whether `stop_hook_active` is set on re-entry. The loop re-blocks
      deliberately and must not be confused with the runtime's own loop guard.
- [x] The hook's working directory resolves the right worktree, and two
      concurrent subagents are separated by `git rev-parse --show-toplevel`.
- [x] `gh api` creates a review comment thread anchored to a file and line,
      replies inside it, and resolves and re-opens it, with the exact request
      shapes recorded.
- [x] `pi --tools` withholds `edit` and `write`.
- [x] Whether `pi` reports cost during a run or only at the end.

A result that contradicts the specification is reconciled in the specification,
not worked around.

## M1 — Plugin skeleton, configuration, and the gate

**Done.**

The repository becomes a loadable plugin with a `squiz` binary and a
`SubagentStop` hook that does the one thing needing no dependencies: gate on the
pull request and exit 0. `squiz review`, which exits 1 at the gate, arrives in
M7.

Covers the plugin manifest, the hook registration, `bin/` and `src/`,
`tsconfig.json`, `tsc --noEmit` and tests in CI, `.squiz/` in `.gitignore`,
`.squiz.json` loading with its six defaults and range validation, the top-level
trap that turns any throw in the hook into exit 0, and the single-line stderr
reporter every later milestone writes through.

### Acceptance criteria

- [x] `claude --plugin-dir ./` loads the plugin and `squiz` resolves on the Bash
      tool's `PATH`.
- [x] The hook exits 0 and posts nothing when the branch has no pull request,
      and finds the pull request when it has one.
- [x] `.squiz.json` with no keys yields rounds 3, depth `read`, thinking
      `medium`, timeout 480, tokens 10,000,000 and no test command. An
      out-of-range `rounds` is rejected with a readable error.
- [x] CI runs `tsc --noEmit` and the tests green, with no runtime dependencies.

`bin/squiz` cannot be an extensionless Node file: Node decides to strip types
from the `.ts` extension. It is a shell shim that execs `node src/cli.ts "$@"`.

## M2 — The finding contract and the comment format

**Done.**

Pure code, no input or output. The finding shape, the three verdicts and the
four terminal statuses, severity ordering, the comment renderer, and the anchor
validator — a unified-diff parser answering whether the line a finding names is
one the change touched.

### Acceptance criteria

- [x] A finding renders to the template in the specification, with and without
      the optional trailing reference, and reads correctly with it deleted.
- [x] A finding scoped to `line` routes inline; one scoped to `change` routes
      general and carries no `file` or `line`.
- [x] An anchor the parser rejects falls back to a general finding carrying its
      `file:line`, rather than being dropped or failing the round.
- [x] A thread the reviewer returned no verdict for resolves to `open`.
- [x] The diff parser is tested against added, removed, context and multi-hunk
      cases.

## M3 — The GitHub client and the coding agent's commands

**Done.**

Everything that shells out to `gh`, and the two commands that make it
demonstrable before the loop exists: `squiz threads` and `squiz reply`.

Covers bringing the head-branch lookup M1 landed under the typed error
contract; fetching the pull request's number, base and head refs, description
and diff; listing review threads with their comments and resolved state;
creating an anchored review comment with `path`, `line`, `side` and
`commit_id`; replying in a thread; resolving and re-opening; and posting an
issue-level comment.

### Acceptance criteria

- [x] Against a scratch pull request, `squiz threads` lists the open threads
      and `squiz reply` adds a reply that appears in the thread.
- [x] Every capability in the specification's GitHub access list has a tested
      call behind it, re-opening included.
- [x] A failure returns a typed error rather than throwing, and a partial
      success is never reported as success.
- [x] The thread identifier `squiz reply` takes is decided and recorded. It
      round-trips from `squiz threads` output and survives being copied by an
      agent.

This milestone needs a scratch repository and pull request to test against.

## M4 — The reviewer

**Done.**

`charter.md`, the `pi` adapter's `argv`, `parse` and `grants`, and the spawn
harness: working directory, `TMPDIR` at the episode's `scratch/` directory,
`< /dev/null`, the time bound, one parse retry, cost extraction, and the prompt
carrying the pull request and the existing threads. Depth `read` only. The
comparison that detects what `bash` can do was built in M7, and the `bash` grant
is M11's.

### Acceptance criteria

- [x] Run against a fixture repository with a seeded defect, the reviewer
      returns findings in M2's shape.
- [x] A JSONL fixture at the scale `docs/notes/` records parses with flat
      memory. Individual lines are large, so cheap type discrimination comes
      before `JSON.parse`.
- [x] The command line carries the `read` grant and no `bash`, and the adapter
      never chooses depth for itself.
- [x] `edit` and `write` appear in no command line the adapter builds.
- [x] A kill at the time bound records a failed round with no findings, distinct
      from an honest finding of nothing.
- [x] Unparseable output is retried once, then treated as an unavailable API.
- [x] `git status` of the fixture tree is clean after a run.

## M5 — The round

**Done.**

The loop composes M3 and M4. Episode state under a directory in `.squiz/`, whose
name is the subagent's `agent_id` stripped to a safe character set
before it becomes a path component, and the round itself: gate, review, post new
findings as threads, apply each verdict to the thread it names, then exit 2 with
a blocking reason or exit 0 at the cap.

Everything here was built as the hook. M7 moves the round into a round host
that `squiz review <number>` and the hooks reach, keys the episode on the pull
request's number, and replaces the hook's exit 2 with a note and a wake to the
session that owns the work.

### Acceptance criteria

- [x] Round 1 on a real pull request posts inline threads and exits 2, with a
      blocking reason naming the open threads and the commands that work them.
- [x] Handed a resolved thread and a replied-to thread, round 2 hands both to
      the reviewer and applies its verdicts: `fixed` and `withdrawn` close,
      `open` re-opens.
- [x] The coding agent acts on the blocking reason rather than declining it. A
      round whose block is declined is recorded as a failed round rather than
      passing as a round that found nothing to do.
- [x] The agent that dispatched the subagent reads a blocked-and-resumed result
      without treating it as tampering.
- [x] A cap of 1 reviews once and never blocks. A cap of R blocks at most R−1
      times.
- [x] Every row of the specification's failure table exits the hook 0 when
      exercised.
- [x] The episode closes by exiting the hook 0 and recording final state.

The blocking reason on exit 2 and the one-line failure pointer on exit 0 are
separate channels and stay separate. Under `squiz review` they become stdout
and stderr.

## M6 — The summary comment

**Done.**

Classification of every thread into its terminal status at close, and the
three-block comment, posted once and never edited.

### Acceptance criteria

- [x] A closing episode posts one comment carrying the counts, the per-round
      costs with the episode total, the needs-a-person list with `file:line` and
      headline, and Notes.
- [x] Notes is omitted when there is nothing to report.
- [x] A round whose cost was not reported prints as unknown rather than zero.
- [x] General findings appear in Notes with their headline and no `file:line`,
      and count toward findings raised while carrying no status.
- [x] A second episode on the same pull request posts a second comment, and the
      first is untouched.

## M7 — The reviewer as a detached session

A trigger queues the pull request's state, and a round host runs the round. The
round host is `squiz host <number>`: one detached process per episode, outside
the process tree of whatever started it. Each round's reviewer is a fresh `pi`,
run as a session of its own. It reads a snapshot of the head commit, in a tmux
or Herdr pane where one exists, and detached otherwise.

There are two kinds of trigger:

- **`squiz review <number>`** queues the state and waits for the round, within
  one deadline of 540 seconds.
- **Squiz's hooks**, on Claude Code's `Stop` as well as `SubagentStop`, queue
  the state and return at once. They never run a round and never block.

So no stall threshold, hook timeout or hand-back bounds the review. When a round
records its result, the session that owns the work gets a note in
`.squiz/<number>/notes/<session id>/` and a wake. The owner is the session
itself for a main session's work, and the subagent's parent for a subagent's
work. The wake is a post to the messaging socket or the `Stop` hook's
`asyncRewake` waiter.

### Done

This milestone began as confinement detection, shared trees and depth `deep`,
all under the hook. That work is done and stays:

- **The tracked-file comparison**, taken before the reviewer starts and again
  when it exits. A file mutated during a run is named in the summary.
- **`HEAD` detection.** `HEAD` is compared around the reviewer, and a move is
  named in the summary and the blocking reason.
- **The refused calls.** The reviewer's calls that would change what the coding
  agent commits are refused, and the round carries how many were.
- **The process groups.** Each shell tool records its own process group, and the
  round stops every group it recorded, the ones `pi` detached included.
- **Shared-tree detection.** Two live episodes on one toplevel disable the
  comparison for that round, and the summary names the other episodes. The
  snapshot makes it redundant, and M10 removes it.
- **The test command in the prompt.** The configured test command is written
  into the reviewer's prompt at depth `deep`. The configuration still refuses
  `deep`, so no round reaches it yet. M11 grants it.
- **A cut-short review recorded.** A round the time bound cut short says so in
  the summary.

Its criteria that were met:

- [x] A file mutated during a run is named in the summary.
- [x] Two live episodes on one toplevel disable the comparison for that round.
      The round still runs, and the summary names the other episodes in flight.

Its criteria about the 600-second window a hook's round ran in, and the
`timeout` default that differed by path, are moot: no round runs inside a hook
or a shell call. M10 removes what they bound.

### Spikes

Three it rests on are answered:

- **S1**, in #296. A tmux window, a Herdr pane and a detached process each
  outlive every way Claude Code stops the call that made them.
- **S3**, in #296. An `asyncRewake` exit 2 and a post to the messaging socket
  each start a turn in an idle interactive session, ten minutes after its turn
  ended as well as one.
- **S2**, in #295. An interactive `pi` in a pane runs its prompt at once,
  registers the reporting calls, applies the refusals, and exits after
  `finish_review`.

### After the MVP

Two parts of the design wait until the MVP ships, held with `milestone:M9`:

- **Recovering a round whose host died** (#327). Until then a reviewing record
  whose host has gone reads as killed, and nothing stops its orphaned reviewer
  or removes its snapshot.
- **The `Stop` hook's `asyncRewake` waiter** (#334). Until then the round host
  wakes the owner by the messaging socket alone, and a note no socket reached is
  read through `squiz review` or `squiz status`.

### Acceptance criteria

All are met. A live run, recorded in
`docs/notes/a-subagent-works-a-thread-to-exit-0-through-the-skill-with-the-reviewer-in-a-herdr-pane.md`,
showed a subagent whose brief did not name squiz load the skill, run
`squiz review`, and work a planted finding from exit 2 to exit 0 with the
reviewer in a Herdr pane. Exit 3, a disputed thread, and the owner's note and
socket wake are built and tested but were not reached in that run; M9's
dogfooding exercises them.

The findings, each in `docs/notes/` before the part that rests on it is built:

- [x] **What closing a pane reaches.** Which processes Herdr's pane close and
      tmux's window close signal, whether a shell `pi` started in a session of
      its own escapes them, and whether Herdr returns a pane to its shell when
      the agent exits.
- [x] **Whether the socket wake can reach a subagent's parent**, that is,
      whether a `SubagentStop` hook's environment carries the parent's
      `CLAUDE_CODE_MESSAGING_SOCKET`.
- [x] **What a snapshot costs**: how long `git worktree add` and its removal
      take on a large repository.
- [x] **Whether a subagent handed a long exit-2 output works every thread.**

The round host and the reviewer:

- [x] `src/sessions/` starts and finds sessions, closes panes, reads a hook's
      payload, and writes and delivers notes. It imports nothing from the rest
      of `src/`, and a test fails on any import that reaches out of it.
- [x] A trigger that queues a state starts a round host where none is running.
      The host outlives the call that started it, holds `host.lock`, takes
      queued states oldest first, and exits when nothing is left queued or its
      worktree is gone. Two triggers that each start one leave one running.
- [x] Each state's record is queued, reviewing, reviewed, failed or not
      reviewed, as the harness specification's state file sets out.
- [x] Every reviewer, at every depth, reads a worktree of its own, detached at
      the state's head commit, in `.squiz/<number>/rounds/<k>/tree/`. The round
      host removes it when the round ends, whatever the round became.
- [x] The tracked-file comparison, the `HEAD` comparison, the refused calls and
      the shell-group record apply to that snapshot. An edit the coding agent
      makes to its own worktree while the reviewer runs appears in no round's
      comparison.
- [x] Each round's reviewer runs in a tmux pane inside tmux, in a Herdr pane
      inside Herdr, and detached otherwise, and detached where no pane can be
      opened.
- [x] Its pane closes when its review ends. The command that resumes its session
      is in `.squiz/<number>/rounds/<k>/resume.txt` and on its line in
      `squiz status`.
- [x] The reviewer's extension writes every accepted report, every refusal and
      the usage of every assistant message to the round's report file, and the
      round reads that file.
- [x] The extension ends the reviewer after `finish_review`. After
      `agent_settled` with no `finish_review`, it records an unfinished end and
      ends the reviewer.

The bounds:

- [x] A round has at most 30 seconds before the review, the time bound for the
      review, and a posting reserve of 60 seconds, each bounded on its own. No
      call to GitHub takes more than 30 seconds.
- [x] `timeout` defaults to 900 seconds and accepts 60 to 3,600.
- [x] Each round's state records `postingSeconds`.

`squiz review`, `squiz status` and the failure comment:

- [x] `squiz review` waits within one deadline of 540 seconds for the whole
      invocation. It exits 0, 2, 3 and 1 in the cases the harness specification
      gives, and 4 where its deadline arrives first. The next run returns the
      round's result.
- [x] A run on a closed episode runs no round and prints the close. A run on a
      state queued or under review waits for it, and a run on a state already
      reviewed returns its result without queueing anything.
- [x] A new commit, or a new reply on one of the reviewer's threads, is a new
      state and starts a round. A disputed finding with no commit after it is
      ruled `withdrawn` or `open`, and the round counts against the cap.
- [x] A failed state is retried only on a fresh request: a new commit, a new
      reply, or a run of `squiz review`. A hook firing on a failed state queues
      nothing, and a failed state gets one note however many times it fails.
- [x] One review runs per state, whatever number of triggers fire for it. Two
      firings for one state post one set of threads.
- [x] A state queued behind a round is never dropped. It is reviewed, or
      recorded as not reviewed with the reason.
- [x] `squiz status` lists running, finished and failed reviews across
      worktrees, and names each round's reviewer session.
- [x] A round that fails posts a failure comment naming what failed and what
      else it established, and the command prints the same reason on stderr.
      Where GitHub cannot be reached, or the posting reserve is spent, stderr is
      the only channel.
- [x] The plugin ships the review skill. A dispatched subagent whose brief does
      not mention squiz loads it, runs `squiz review`, and works a real pull
      request's threads to exit 0 or 3.
- [x] `squiz init` adds the `AGENTS.md` section once.

The hooks and the report:

- [x] `hooks/hooks.json` registers `squiz hook` on `Stop`, in the background
      with `asyncRewake`, and on `SubagentStop`. A turn ending on a branch with
      a pull request queues its state, from a main session and from a subagent.
- [x] The hook exits 0 whatever it found. It never runs a round and never
      blocks. A turn that pushed nothing, or a firing for a state already
      queued, reviewed or failed, queues nothing.
- [x] The hook records the session that owns the work: the session itself on
      `Stop`, with its messaging socket where it has one, and on `SubagentStop`
      the dispatching session and the subagent.
- [x] When a round records its result, the round host writes a note for that
      owner, under a temporary name and renamed into place. It names the pull
      request, the head commit and, for a subagent's work, the subagent. It
      carries no finding. What its text says depends on the outcome:
  - **Threads open, or the episode closed:** the text says what the review
    found and points to `squiz review` to read it.
  - **Failed:** the text gives the reason, names `squiz status`, and says that a
    new commit, or running `squiz review` once, retries it. A failed state gets
    one note, however many times it fails.
  - **Not reviewed:** the text says why.
  - **Reviewed clean, with the episode open because a later state is queued
    behind it:** no note.
  - **No hook recorded an owner:** no note.
- [x] An idle main session starts a turn with the note's text, by the messaging
      socket. Delivering it moves the note into `delivered/`.
- [x] For a subagent's work, the note reaches the parent session, by the socket
      the hook carries.
- [x] A note no wake reached stays where it was written, and the owner learns
      the result from `squiz review` or `squiz status`.

CI:

- [x] CI installs tmux and tests the tmux and detached sessions there. It does
      not install Herdr, which is before 1.0. Herdr panes are tested where
      Herdr is installed by hand.

## M10 — The subagent-era workarounds removed

The cleanup that follows M7: what reviewer sessions make redundant goes, from
the harness specification and from the code, and nothing of it stays as dead
code. Every issue held while squiz was paused gets a disposition.

The 540-second deadline of `squiz review`, the 30-second and 60-second bounds,
`postingSeconds`, and the 900-second time bound with its 60 to 3,600 range all
stay.

### Acceptance criteria

- [ ] **`src/` and the tests are audited against M7's design.** Every
      implementation the reviewer sessions make redundant is removed, and the
      pull request lists each removed piece. Nothing redundant is left behind.
      The harness specification names these:
  - **The hook-path timing and windows.** The 600-second window a hook's round
    ran in, its 540-second reviewer cap and the per-path `timeout` cap, in
    `src/loop/window.ts`, and the hook's registration test.
  - **The hand-back assumptions.** The hook's exit-2 block and its blocking
    reason in `src/loop/reason.ts`, the table mapping a review's exit to the
    hook's, and the reading that auto mode drops a block after the hand-back.
  - **Duplicate-episode handling.** Shared-tree detection in
    `src/worktree/shared-tree.ts`, the other-episodes and could-not-tell lists
    the state file keeps for it, the Notes items built from them, and the
    comparison switched off in a shared tree.
  - **The reviewer as a child of the hook.** The round started from
    `squiz hook` in `src/hook/hook.ts`, and the reliance on the runtime
    signalling the hook's process tree to stop a reviewer.
  - **The watchdog-driven bounds.** Sizing any bound against the subagent stall
    threshold, and the test holding the hook's window to its declared timeout.
  - **Every test that exists only for one of the above.**
- [ ] The harness specification describes none of what was removed.
- [ ] **Every issue below has its disposition recorded on the issue:**
      implemented, closed with the reason, reassigned to a later milestone, or
      explicitly held with the reason.

### Issues to re-judge

| Issue | What it is | Expected disposition |
|---|---|---|
| #278 | A block reaches no coding agent | Closed: M7's note and wake reach a main session and a subagent's parent, and `squiz review` reaches a subagent |
| #273 | A round that fails leaves no trace on the pull request | Closed by M7's failure comment |
| #265 | A subagent the session never dispatched starts a round of its own | Closed: one review runs per state, and the episode keys on the pull request |
| #297 | A reviewer cut short kept running for nine minutes, and the watchdog cancelled the hook | The watchdog half is moot. Whether a stopped reviewer is gone within the grace is judged against stopping its session and its recorded shell groups |
| #280 | Reviews run to within seconds of the time bound | Judged against the 900-second default. Measuring #281's effect on time may remain |
| #281 | Rewrite the review charter around a defined method | Not caused by the subagent model. Implemented here, or reassigned, by the owner's call |
| #260 | Report a marker a blocked round could not write | Closed: no round blocks |
| #113 | Accept depth `deep` | Reassigned to M11 |
| #244 | Name the reviewer's refused calls in the summary's Notes | Held until M9's dogfooding shows a refused call |
| #293 | Check the DeepSeek balance the reviewer runs on | Needs a person, and depends on nothing here |

## M11 — Depth `deep`

The `bash` grant, on the snapshot M7 gives every reviewer.

The snapshot holds no installed dependencies, so the configured test command
installs or builds what it needs before the tests run. What that adds to a round
is measured before M11 is planned.

### Acceptance criteria

- [ ] Depth `deep` produces a command line with `bash`, and the configured test
      command reaches the reviewer.
- [ ] A write the reviewer makes through the shell is detected on its snapshot
      and named in the summary.
- [ ] A configured test command that works in a fresh checkout runs to
      completion in the snapshot.

## M8 — Episode boundaries

The token bound, and an audit that every failure reaches somewhere a person
reads.

The token bound is 10,000,000 tokens a round. It is read before a round starts
and again when a round records what it spent. A running round is never killed
for its tokens: the bound stops the next round, and the time bound is what caps
a round that runs away.

### Acceptance criteria

- [ ] An episode whose round reached the token bound closes with the findings it
      has, and the summary says the bound was reached.
- [ ] The tokens an attempt that was no round spent count against the bound.
- [ ] No failure path is silent. *Changed by detached sessions: the round host
      has no caller's stderr. The audit names, for each failure path, which of
      the failure comment, `squiz status`, `.squiz/<number>/host.log` and
      `squiz review`'s stderr carries it.*

## M9 — Install and dogfood

The marketplace manifest, a README carrying the getting-started steps,
`/squiz doctor`, and `docs/notes/` consolidated.

### Acceptance criteria

- [ ] `/plugin marketplace add` followed by `/plugin install` works into a fresh
      host project.
- [ ] `/squiz doctor` reports `git`, `gh` and its authentication, `pi`, Claude
      Code, and the Node version, naming whatever is missing. *Changed by
      detached sessions: it also reports whether tmux or Herdr is present.
      Neither is required.* It reports whether the plugin's skill or the
      `AGENTS.md` section tells a coding agent to run `squiz review`, and
      says so where neither does.
- [ ] A subagent there produces a reviewed pull request end to end. *Changed by
      detached sessions: a main session does too, woken by a note.*
- [ ] Squiz reviews its own pull requests in this repository.

### Issues

- #259, have `/squiz doctor` name the reviewer settings squiz overrides in this
  project
- #271, name the reviewer and its model in the summary comment
- #274, look once at whether an interactive session shows a hook's stderr when
  it exits 0
- #276, find out what it would take to show the reviewer as a session a person
  can watch. M7's reviewer sessions are expected to answer it.
- #285, check stale docs and missing tests as pipeline steps of their own
