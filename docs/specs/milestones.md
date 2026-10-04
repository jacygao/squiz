# Milestones

**Version:** 0.19 (draft)
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
| 8 | M7 — The reviewer as a detached session | In progress. Its confinement work is done |
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

**The trigger, session and wake code lives in a folder of its own under `src/`,
and knows nothing about reviews.** Nothing in it imports the review's code, so it
can be lifted out if a second tool needs it.

**The first version leaves three things out:** delivering a note when a session
starts, rules for acknowledging a note and retrying one, and messages in both
directions. Hooks for agents other than Claude Code, GitHub Copilot's among them,
come after M9.

**The harness specification does not yet describe the reviewer as a session.**
It is revised before the rest of M7 is planned.

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

A round runs in a round host: one detached process per episode, outside the
process tree of whatever started it. Each round's reviewer is a fresh `pi`, run
as a session of its own, which reads a worktree of its own at the head commit.
It runs in a tmux or Herdr pane where one exists, and detached otherwise.

The coding agent reaches a review two ways:

- **`squiz review`**, which starts the round host and waits for the outcome
- **Squiz's hooks**, on Claude Code's `Stop` for a main session as well as on
  `SubagentStop`, which start the review and return at once

So no stall watchdog, hook timeout or hand-back bounds the review. The outcome
goes to the session that owns the work: the session itself for a main session's
work, and the subagent's parent for a subagent's work. It arrives as a short
note in `.squiz/<number>/`, addressed to that session's id, and a wake, by an
`asyncRewake` waiter or a post to the messaging socket.

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
  snapshot worktree makes it redundant, and M10 removes it.
- **The test command in the prompt.** The configured test command is written
  into the reviewer's prompt at depth `deep`. The configuration still refuses
  `deep`, so no round reaches it yet. M11 grants it.
- **A cut-short review recorded.** A round the time bound cut short says so in
  the summary.

Its criteria that were met:

- [x] A file mutated during a run is named in the summary.
- [x] Two live episodes on one toplevel disable the comparison for that round.
      The round still runs, and the summary names the other episodes in flight.

Its criteria that detached sessions make moot, which M10 removes:

- One deadline bounds each invocation, waiting included. `squiz review` now only
  waits, and its wait is its bound.
- A round runs inside a 540-second window from `squiz review` and a 600-second
  one from the hook, with a 30-second cap on pre-review calls, a 60-second
  posting reserve, and a `timeout` default per path.
- Each round's state records `postingSeconds`.

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

### Acceptance criteria

The findings:

- [ ] **S4 has a finding in `docs/notes/`.** It says which processes Herdr's
      pane close and tmux's `kill-window` reach. It also says whether a pane
      returns to its shell when an agent started by `herdr agent start` exits,
      and whether tmux's `pane-died` hook fires on every exit and gives the exit
      status.
- [ ] Whether a wake started from a `SubagentStop` hook reaches the subagent's
      parent, and by which of the two routes, has a finding in `docs/notes/`.
- [ ] The harness specification's remaining prerequisite for `squiz review`,
      whether a subagent handed a long exit-2 output works every thread, has a
      finding in `docs/notes/`.

The session and its reviewer:

- [ ] The trigger, session and wake code lives in its own folder under `src/`
      and imports nothing of the review's. A test holds this.
- [ ] The round host outlives the call that started it. It runs a round for each
      state it is asked to review, records each outcome, and ends when the
      episode closes or its worktree is gone.
- [ ] A state records whether it is being reviewed, reviewed, or failed.
- [ ] Every reviewer, at every depth, reads a worktree of its own, detached at
      the state's head commit. Nothing else writes to it, and the round removes
      it afterwards.
- [ ] The tracked-file comparison, the `HEAD` comparison and the refused calls
      apply to that snapshot. An edit the coding agent makes to its own
      worktree while the reviewer runs appears in no round's comparison.
- [ ] Each round's reviewer runs in a tmux pane inside tmux, in a Herdr pane
      inside Herdr, and detached otherwise.
- [ ] Its pane closes when its review ends. The command that resumes its session
      is in `.squiz/<number>/rounds/<k>/resume.txt` and on its line in
      `squiz status`.
- [ ] The reviewer's extension writes every accepted report, every refusal and
      the usage of every assistant message to a report file. The round reads
      that file, and a test holds it equal to the JSON stream on a recorded run.
- [ ] The extension ends the reviewer after `finish_review`. After
      `agent_settled` with no `finish_review`, it records an unfinished end and
      ends the reviewer.
- [ ] A reviewer stopped from outside has its session stopped and every shell
      group it recorded signalled.

`squiz review`, `squiz status` and the failure comment:

- [ ] `squiz review` exits 0, 2, 3 and 1 in the cases the harness specification
      gives, and 4 when its wait runs out. A rerun attaches to the same round.
- [ ] A run on a closed episode runs no round and prints the close. A run on a
      state under review waits for that review, and a run on a state already
      reviewed returns its result without a round.
- [ ] A new commit, or a new reply on one of the reviewer's threads, starts a
      round. A disputed finding with no commit after it is ruled `withdrawn` or
      `open`, and the round counts against the cap.
- [ ] A failed review, or one whose round host has died, is retried by the next
      `squiz review` or trigger. A reviewed state is never reviewed again.
- [ ] One review runs per state, whatever number of triggers fire for it. Two
      firings for one state post one set of threads.
- [ ] `squiz status` lists running, finished and failed reviews across
      worktrees, and names each round's reviewer session.
- [ ] A round that fails posts a failure comment naming what failed and what
      else it established. Where GitHub cannot be reached, stderr carries it
      instead.
- [ ] The plugin ships the review skill. A dispatched subagent whose brief does
      not mention squiz loads it, runs `squiz review`, and works a real pull
      request's threads to exit 0 or 3.
- [ ] `squiz init` adds the `AGENTS.md` section once, and `/squiz doctor`
      reports whether the skill or the section is there.

The triggers and the report:

- [ ] A main session's turn ending on a branch with a pull request starts a
      review of its state, and so does a subagent's.
- [ ] A turn on a branch with no pull request starts nothing. A turn on a state
      already reviewed or under review starts no second review.
- [ ] The hook returns without waiting for the round, and no longer runs a round
      as its child.
- [ ] When a round ends, the round host writes the note to the session that owns
      the work. It names the pull request, the head commit, the outcome, the
      open threads, and the command that reads them.
- [ ] An idle main session is woken with the note. It works the threads to exit
      0 or 3 without running `squiz review` itself.
- [ ] For a subagent's work, the parent session is woken with the note.
- [ ] A note whose session was never woken loses nothing: `squiz review` reads
      the same outcome from the pull request and the recorded state.

CI:

- [ ] CI installs tmux and tests the tmux and detached sessions there. It does
      not install Herdr, which is before 1.0. Herdr panes are tested where
      Herdr is installed by hand.

## M10 — The subagent-era workarounds removed

What was there only because the reviewer ran inside a hook or a shell call goes,
and nothing of it stays as dead code. Every issue held while squiz was paused is
built or closed.

### Acceptance criteria

- [ ] **`src/` and the tests are audited against M7's design.** Every
      implementation the detached sessions make redundant is removed, and the
      pull request lists each removed piece. Nothing redundant is left behind.
      The candidates found so far:
  - the round's windows and their shares, `src/loop/window.ts`, and the test
    that holds the hook's registered timeout to its window
  - the hook-path timing that differs from the command path's, including the
    480-second ceiling on the time bound, which becomes a wall-clock guard on a
    runaway round, with no ceiling
  - the bounds that exist to stay under the stall watchdog, wherever
    `src/reviewers/deadline.ts` serves only them
  - the blocking reason, `src/loop/reason.ts`, the hook's exit 2, and every
    assumption that a block reaches the agent a subagent handed back to
  - the reviewer run as a child of the hook, in `src/hook/hook.ts`
  - the episode keyed on the subagent's `agent_id`, in `src/hook/payload.ts`,
    and the handling of a duplicate episode for a firing the session never
    dispatched
  - shared-tree detection and the round-in-flight marker,
    `src/worktree/shared-tree.ts` and `unmarkedBy` in `src/hook/hook.ts`, which
    the snapshot worktree makes redundant
  - every test that exists only for one of the above
- [ ] The harness specification no longer describes anything removed.
- [ ] Every issue below is built or closed, with the reason on the issue.

### Issues to re-judge

| Issue | What it is | Expected here |
|---|---|---|
| #278 | A block reaches no coding agent | Closed by M7's wake for a main session and a subagent's parent, and by `squiz review` for a subagent |
| #273 | A round that fails leaves no trace on the pull request | Closed by M7's failure comment |
| #265 | A subagent the session never dispatched starts a round of its own | Moot once one review runs per state and the episode keys on the pull request |
| #297 | A reviewer cut short kept running for nine minutes, and the watchdog cancelled the hook | The watchdog half is moot. Whether a stopped reviewer is gone within the grace is re-judged against stopping its session and its recorded shell groups |
| #280 | Reviews run to within seconds of the time bound | Re-judged once the ceiling goes. Measuring #281's effect on time may remain |
| #281 | Rewrite the review charter around a defined method | Not caused by the subagent model. Built here or after, by the owner's call |
| #260 | Report a marker a blocked round could not write | Moot once no round blocks and the marker is gone |
| #113 | Accept depth `deep` | Built in M11 |
| #244 | Name the reviewer's refused calls in the summary's Notes | Still held until dogfooding shows a refused call |
| #293 | Check the DeepSeek balance the reviewer runs on | Needs a person, and depends on nothing here |

## M11 — Depth `deep`

The `bash` grant, behind the tracked-file comparison that M7 takes on the
reviewer's own worktree.

A snapshot worktree has no installed dependencies. What it costs to install them
before the tests run, on this repository and a larger one, is measured before
M11 is planned.

### Acceptance criteria

- [ ] Depth `deep` produces a command line with `bash`, and the configured test
      command reaches the reviewer.
- [ ] A write the reviewer makes through the shell is detected on its snapshot
      and named in the summary.

## M8 — Episode boundaries

The token bound, enforced while a round runs, and an audit that every failure
reaches somewhere a person reads. It needs M7's round host and extension.

### Acceptance criteria

- [ ] An episode whose round reached the token bound closes with the findings it
      has, and the summary says the bound was reached. *Kept.*
- [ ] The reviewer's extension stops a round once it reaches the token bound.
      *Added, because from M10 no window bounds a round. Whether an extension
      can stop a turn in flight, or only between messages, is recorded as a
      finding first. Where it is only between messages, the finding says how
      far past the bound a round runs, and this criterion is held to that.*
- [ ] No failure path is silent. *Changed by detached sessions: the round host
      has no caller's stderr. The audit names, for each failure path, which of
      the failure comment, `squiz status`, the round host's log and
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
      Neither is required.*
- [ ] A subagent there produces a reviewed pull request end to end. *Changed by
      detached sessions: a main session does too, woken rather than running
      `squiz review` itself.*
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
