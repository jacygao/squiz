# Milestones

**Version:** 0.14 (draft)
**Status:** For review
**Owner:** TBD

---

Fifteen milestones for building squiz and muster, in the order they are done.
Each ends in something that can be run or seen, never in a module written.

| Order | Milestone | Project | State |
|---|---|---|---|
| 1 | M0 — Prerequisites spike | squiz | Done |
| 2 | M1 — Plugin skeleton, configuration, and the gate | squiz | Done |
| 3 | M2 — The finding contract and the comment format | squiz | Done |
| 4 | M3 — The GitHub client and the coding agent's commands | squiz | Done |
| 5 | M4 — The reviewer | squiz | Done |
| 6 | M5 — The round | squiz | Done |
| 7 | M6 — The summary comment | squiz | Done |
| 8 | M7 — Confinement detection, shared trees, and depth `deep` | squiz | Done in part. Its unmet criteria are M14's |
| 9 | M10 — Muster's spikes | muster | |
| 10 | M11 — Muster's sessions and their backends | muster | |
| 11 | M12 — Muster's triggers, through an adapter per agent | muster | |
| 12 | M13 — Muster's inbox | muster | |
| 13 | M14 — Squiz on muster | squiz | |
| 14 | M8 — Episode boundaries | squiz | |
| 15 | M9 — Install and dogfood | squiz | |

**A milestone's number names it, and the table places it.** M10 to M14 come
before M8 and M9 in the order.

**Squiz gains no feature between M7 and M14.** Its issues held in that time are
listed under M14, and each is built or closed there.

**Muster is a session manager that knows nothing about code review.** It runs a
command when a coding agent finishes, starts agent sessions that outlive
whatever started them, and carries short messages between sessions.
`muster/docs/specs/muster-spec.md` specifies it, and
`docs/specs/session-interface.md` says what squiz asks of it. Both arrive with
pull request #294, and until it merges they exist only there.

**Muster lives in `muster/` in this repository** until it moves to a repository
of its own. Nothing under `muster/` imports a module under squiz's `src/`, and
nothing under `src/` imports a module under `muster/`. Each calls the other only
as a command. M11 builds the test that holds this.

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
      the same every time that subagent stops. M14 rekeys the episode on the
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
M14.

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
comparison that detects what `bash` can do is M7's, and the `bash` grant is
M14's.

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

Everything here was built as the hook. M14 moves the round into a round host
that `squiz review <number>` and muster's triggers reach, keys the episode on the
pull request's number, and replaces the hook's exit 2 with a message to the
coding agent.

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

## M7 — Confinement detection, shared trees, and depth `deep`

**Done in part.** What it delivered stays. Its unmet criteria moved to M14, and
M14 lists its open issues.

It delivered, all under the hook:

- **The tracked-file comparison**, taken before the reviewer starts and again
  when it exits. A file mutated during a run is named in the summary.
- **`HEAD` detection.** `HEAD` is compared around the reviewer, and a move is
  named in the summary and the blocking reason.
- **The refused calls.** The reviewer's calls that would change what the coding
  agent commits are refused, and the round carries how many were.
- **The process groups.** Each shell tool records its own process group, and the
  round stops every group it recorded, the ones `pi` detached included.
- **Shared-tree detection.** Two live episodes on one toplevel disable the
  comparison for that round, and the summary names the other episodes.
- **The test command.** The configured test command reaches the reviewer.
- **A cut-short review recorded.** A round the time bound cut short says so in
  the summary.

### Acceptance criteria met

- [x] The specification's prerequisites for `squiz review` each have a finding in
      `docs/notes/`, and any that contradicts the specification is reconciled
      there before the command is built.
- [x] A file mutated during a run is named in the summary.
- [x] Two live episodes on one toplevel disable the comparison for that round.
      The round still runs, and the summary names the other episodes in flight.

### Acceptance criteria moved to M14

Each is restated there, against the round host.

- `squiz review` exits 0, 2, 3, 4 and 1 in the cases the specification gives.
  M14 changes what exit 4 means: the wait ran out, and a rerun attaches.
- A run on a closed episode, on a state under review, and on a state already
  reviewed.
- A new commit, or a new reply on one of the reviewer's threads, starts a round,
  and a dispute counts against the cap.
- Two firings for one state post one set of threads.
- `squiz status` lists running, finished and failed reviews across worktrees.
- A round that fails posts a failure comment.
- The plugin ships the review skill, and a dispatched subagent loads it.
- `squiz init` adds the `AGENTS.md` section once, and `/squiz doctor` reports it.
- Depth `deep` produces a command line with `bash`. Half of this criterion, the
  test command reaching the reviewer, was met.

### Acceptance criteria muster makes moot

M14 removes what these bound, and checks that each is gone.

- One deadline bounds each invocation, waiting included. Under M14 `squiz review`
  only waits, and its wait is its bound.
- A round runs inside a 540-second window from `squiz review` and a 600-second
  one from the hook, with a 30-second cap on pre-review calls, a 60-second
  posting reserve, and a `timeout` default per path.
- Each round's state records `postingSeconds`.

## M10 — Muster's spikes

The four questions muster's specification leaves open, cheapest first, each run
against throwaway scaffolding. No production code survives this milestone. The
findings do, in `muster/docs/notes/`.

### Acceptance criteria

A written finding for each of:

- [ ] **S1.** Whether a tmux window, and a Herdr tab started with
      `herdr agent start`, created from inside a Claude Code shell call or hook,
      outlives the runtime stopping that call. Whether a detached session whose
      output goes to a log file escapes as the measured one with `/dev/null` did.
- [ ] **S3.** Which wake reaches an idle interactive Claude Code session ten
      minutes after its turn ended: an `asyncRewake` exit 2, a post to
      `CLAUDE_CODE_MESSAGING_SOCKET`, or both. In auto mode and outside it.
      Whether an `asyncRewake` hook's exit 2 is dropped once it reaches its
      timeout.
- [ ] **S4.** Which processes Herdr's pane close and tmux's `kill-window` reach.
      Whether a pane returns to its shell once an agent started by
      `herdr agent start` exits. Whether tmux's `pane-died` hook fires on every
      exit with `remain-on-exit` on, and gives the exit status.
- [ ] **S6.** Whether `herdr agent start --kind pi` tracks a `pi` that runs with
      `--no-extensions`, and what status Herdr shows for it.

The owner decides where muster's state lives, the one decision muster's
specification leaves open, before M11 starts.

A result that contradicts muster's specification is reconciled in that
specification, not worked around.

## M11 — Muster's sessions and their backends

Muster becomes a project in `muster/` with a `muster` binary that starts,
watches and stops sessions in a Herdr tab, a tmux window, or a detached process.
It is usable on its own: a person can start a session with `muster start` and
manage it, with no trigger and no message.

Covers `muster/bin/muster` and `muster/src/cli.ts`, the import-boundary test,
`tsc --noEmit` and muster's tests in CI, the state directory, the session
record, the three backends, and `start`, `status`, `attach`, `wait`, `read`,
`stop`, `prune` and `closed`.

### Acceptance criteria

- [ ] `muster` resolves, every command takes `--root`, which defaults to the git
      toplevel of the working directory, and every command prints JSON with
      `--json`.
- [ ] The import-boundary test reads every import under `muster/` and `src/` and
      fails on one that crosses. It runs in CI.
- [ ] CI runs `tsc --noEmit` and muster's tests green, with no runtime
      dependencies.
- [ ] Without `--backend`, `muster start` picks Herdr inside Herdr, tmux inside
      tmux, and detached otherwise.
- [ ] A session started from inside a Claude Code shell call outlives the
      runtime stopping that call, on every backend S1 found it does.
- [ ] A session's record carries the backend and its identifier for the tab,
      pane or window, the pid and its start time, the command, the log path,
      and whether it is alive, exited or stopped.
- [ ] Starting a session under the name of a live one fails and names the live
      one. Starting one under the name of an exited or stopped one replaces it.
- [ ] A session's pane closes when its program exits, and its record is marked
      exited, with the exit status where the backend reports one.
      `--keep-pane` leaves the pane open.
- [ ] `muster status` and `muster read` answer for an exited session from its
      record and its log until `muster prune` removes it.
- [ ] `muster status`, `attach`, `wait` and `read` behave on each backend as
      muster's specification tabulates.
- [ ] `muster stop` stops a session on each backend as muster's specification
      tabulates, and marks its record stopped. A detached stop signals the
      process group only while the pid and its start time still match the
      record.
- [ ] `muster prune` removes every record marked exited or stopped, and every
      record whose process is gone by pid and start time.

The Herdr and tmux backends need their multiplexer installed to test against.
Whether CI installs either is not decided.

## M12 — Muster's triggers, through an adapter per agent

When an agent finishes, muster runs the command `.muster.json` configures for
the event. Each agent reaches muster through an adapter of its own:

- **Claude Code**, through `Stop` and `SubagentStop` hooks registered in
  `muster/hooks/hooks.json`.
- **`pi`**, through muster's `pi` extension on `agent_settled`.
- **Herdr**, through a plugin on `pane.agent_status_changed`, as an extra source
  beside the two above and never in place of one.

An agent no adapter covers uses the pull fallback: it runs a muster command
itself when it finishes, and that fires the same configured commands an
adapter's event does. Muster's specification does not yet name that command,
and names it before this milestone builds it.

GitHub Copilot is an adapter to come, and is not built here. Until it is, a
Copilot session uses the pull fallback.

A trigger command's `watch` lines, and the wake they ask for, are M13's.

### Acceptance criteria

- [ ] `muster hook` runs every command `.muster.json` configures for the event,
      in the working directory the event fired in, with the event in
      `MUSTER_EVENT`, the root in `MUSTER_ROOT`, and the runtime's payload on
      its standard input unchanged.
- [ ] With muster's hooks loaded in Claude Code, a main session's turn ending
      fires `stop`, and a subagent's fires `subagent-stop`.
- [ ] A `pi` session with muster's extension fires `pi-settled` once each time
      it settles.
- [ ] The pull fallback fires the configured commands from an agent with no
      adapter.
- [ ] Inside Herdr, an agent whose status becomes `done` fires `herdr-done`.
- [ ] A turn that ended on a question fires as any other turn does.
- [ ] A configured command's exit status, where it is not 0, is reported on
      `muster hook`'s stderr and never changes the hook's own exit status.

## M13 — Muster's inbox

Messages between sessions, and the wake that delivers one into the agent an
address belongs to. Covers the envelope, `muster send`, `muster inbox list` and
`muster inbox take`, the `watch` lines and the waiter, the `pi` wake, and the
Claude Code wake S3 chose.

### Acceptance criteria

- [ ] `muster send` writes an envelope with its four fields and muster's two,
      and refuses an address outside `[A-Za-z0-9._-]` or longer than 64
      characters, and a pointer longer than 1,024 bytes or than one line.
- [ ] A message is written whole or not at all.
- [ ] `muster inbox take` prints the oldest message and moves it into
      `handled/` in one rename. Two readers taking at once never both take one
      message.
- [ ] A message nobody has taken is delivered first by the next wait on its
      address.
- [ ] Muster reads neither `kind` nor `pointer`: any of each a sender gives
      comes back byte for byte.
- [ ] A trigger command's `watch <address>` lines make `muster hook` wait on
      those addresses for a `stop` or `pi-settled` event. Nothing waits for
      `subagent-stop`.
- [ ] A message sent to an address a settled `pi` session watches starts a turn
      in that session, with the text muster's specification shows.
- [ ] A message sent to an address an idle interactive Claude Code session
      watches starts a turn in it ten minutes after its last turn ended, by the
      wake S3 chose.
- [ ] A session that ended three turns has a message taken once, by the waiter
      for its newest turn.
- [ ] An agent no wake reaches, a Claude Code subagent among them, reads its
      messages with `muster inbox take` and loses none.

## M14 — Squiz on muster

Squiz runs its reviewer as a muster session, `squiz review` becomes its one
entry point, and the limits that came from running the reviewer inside a coding
agent's hook or shell call go. `docs/specs/session-interface.md` governs, and
this milestone is steps 2 to 5 of its migration:

- the report file the reviewer's extension writes
- the round host, `squiz host <number>`, run as a detached muster session per
  episode
- each round's reviewer as a muster session of its own, in a pane where Herdr or
  tmux is present
- `squiz review` as the harness specification sets it out, changed as the
  session interface changes it: it sends a message to the round host and waits
  on the record
- `squiz hook` as the command muster's triggers run, with squiz's plugin
  manifest registering muster's hooks in place of its own
- `"reviewer": "session"` as the default

### Acceptance criteria

- [ ] Squiz's spikes S5, S7 and S8, and S2's open remainder, each have a finding
      in `docs/notes/`, and the owner has decided D2 to D11 before what each
      decides is built. D10 waits for S6.
- [ ] The reviewer's extension writes every accepted report, every refusal and
      the usage of every assistant message to the report file. A test holds the
      file equal to the JSON stream on a recorded run.
- [ ] `squiz host <number>` takes requests from `squiz-reviewer-<number>`, runs a
      round for each, records the outcome, and sends the coding agent
      `threads-open`, `closed` or `failed`. It ends when the episode closes, when
      a `stop` message arrives, or when its worktree is gone.
- [ ] Each round's reviewer runs as the muster session `squiz-<number>-r<k>`,
      with the command line the session interface gives. Its pane closes when
      its review ends, and the command that resumes it is in
      `.squiz/<number>/rounds/<k>/resume.txt` and on its line in
      `squiz status`.
- [ ] The extension ends the reviewer after `finish_review`, and after
      `agent_settled` with no `finish_review`, recording an unfinished end.
- [ ] `squiz review` exits 0, 2, 3 and 1 in the cases the harness specification
      gives, and 4 when its wait runs out. A rerun attaches to the same round,
      and `--no-wait` exits 4 at once.
- [ ] A run on a closed episode runs no round and prints the close. A run on a
      state under review waits for that review, and a run on a state already
      reviewed returns its result without a round.
- [ ] A new commit, or a new reply on one of the reviewer's threads, starts a
      round. A disputed finding with no commit after it is ruled `withdrawn` or
      `open`, and the round counts against the cap.
- [ ] One review runs per state, whatever number of triggers fire for it, and
      two firings for one state post one set of threads.
- [ ] `squiz status` lists running, finished and failed reviews across
      worktrees, and names each round's reviewer session.
- [ ] A round that fails posts a failure comment naming what failed and what
      else it established. Where GitHub cannot be reached, stderr and the round
      host's log carry it instead.
- [ ] A main Claude Code session or a `pi` coding agent that ends its turn on a
      pull request is woken with the outcome, and works the threads to exit 0
      or 3 without running `squiz review` itself.
- [ ] The plugin ships the review skill, and a dispatched subagent whose brief
      does not mention squiz loads it, runs `squiz review`, and works a real
      pull request's threads to exit 0 or 3.
- [ ] `squiz init` adds the `AGENTS.md` section once, and `/squiz doctor`
      reports whether the skill or the section is there.
- [ ] Depth `deep` produces a command line with `bash`, and the reviewer runs it
      in the snapshot worktree D4 gives, so the tracked-file comparison reads
      only the reviewer.
- [ ] The subagent-era workarounds are gone from the code and from the harness
      specification:
  - the 540- and 600-second round windows, their three shares, and the timing
    that differs between the hook path and the command path
  - the 480-second ceiling on the time bound, which becomes the wall-clock guard
    D5 gives
  - the hook's exit-2 blocking reason, and every assumption that a block reaches
    the agent a subagent handed back to
  - duplicate-episode handling for a firing the session never dispatched, where
    keying the episode on the pull request's number makes it moot
- [ ] Every issue below is built or closed, with the reason on the issue.

### Issues to re-judge

Each was held while muster was built.

| Issue | What it is | Expected here |
|---|---|---|
| #278 | A block reaches no coding agent | Closed by the wake for full sessions, and by `squiz review` for subagents |
| #273 | A round that fails leaves no trace on the pull request | Built, as the failure comment |
| #265 | A subagent the session never dispatched starts a round of its own | Moot once one review runs per state and the episode keys on the pull request |
| #297 | A reviewer cut short kept running for nine minutes, and the watchdog cancelled the hook | The watchdog half is moot. That a stopped reviewer is gone within the grace is re-judged against muster's stop and the recorded shell groups |
| #280 | Reviews run to within seconds of the time bound | Re-judged once D5 removes the ceiling. Measuring #281's effect on time may remain |
| #281 | Rewrite the review charter around a defined method | Not caused by the subagent model. Built here or after, by the owner's call |
| #260 | Report a marker a blocked round could not write | Moot once no round blocks |
| #113 | Accept depth `deep` | Built on D4's snapshot worktree, after S7 |
| #244 | Name the reviewer's refused calls in the summary's Notes | Still held until dogfooding shows a refused call |
| #293 | Check the DeepSeek balance the reviewer runs on | Needs a person, and depends on nothing here |

## M8 — Episode boundaries

The token bound, enforced while a round runs, and an audit that every failure
reaches somewhere a person reads. It needs M14's round host and extension.

### Acceptance criteria

- [ ] An episode whose round reached the token bound closes with the findings it
      has, and the summary says the bound was reached. *Kept.*
- [ ] The reviewer's extension stops a round once it reaches the token bound.
      *Added by muster's design, under D5. Where S5 finds that an extension can
      stop a round only between messages, the finding says how far past the
      bound a round runs, and this criterion is held to that.*
- [ ] No failure path is silent. *Changed by muster: the round host has no
      caller's stderr. The audit names, for each failure path, which of the
      failure comment, `squiz status`, the round host's log and `squiz review`'s
      stderr carries it.*

## M9 — Install and dogfood

The marketplace manifest, a README carrying the getting-started steps,
`/squiz doctor`, and `docs/notes/` consolidated. Squiz installs with muster
inside it while muster lives in this repository.

### Acceptance criteria

- [ ] `/plugin marketplace add` followed by `/plugin install` works into a fresh
      host project. *Changed by muster: the install also registers muster's
      hooks and puts `muster` on the Bash tool's `PATH`.*
- [ ] `/squiz doctor` reports `git`, `gh` and its authentication, `pi`, Claude
      Code, and the Node version, naming whatever is missing. *Changed by
      muster: it also reports `muster`, and whether Herdr or tmux is present,
      neither of which is required.*
- [ ] A subagent there produces a reviewed pull request end to end. *Changed by
      muster: a main session does too, woken rather than running
      `squiz review` itself.*
- [ ] Squiz reviews its own pull requests in this repository.

### Issues

- #259, have `/squiz doctor` name the reviewer settings squiz overrides in this
  project
- #271, name the reviewer and its model in the summary comment
- #274, look once at whether an interactive session shows a hook's stderr when
  it exits 0
- #276, find out what it would take to show the reviewer as a session a person
  can watch. M14's reviewer sessions are expected to answer it.
- #285, check stale docs and missing tests as pipeline steps of their own
