# Milestones

**Version:** 0.16 (draft)
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

**Muster is written in Go**, as the module `github.com/jacygao/muster`. It is
built in `muster/` in this repository, with a CI job of its own that runs
`go build`, `go test` and `go vet`. Squiz's TypeScript checks ignore `muster/`.

**The boundary between them is hard.** Nothing under `muster/` imports anything
under squiz's `src/`, and nothing under `src/` imports anything under `muster/`.
Each calls the other only as a command. M11 builds the test that holds this.

**Muster moves to a repository of its own, with its history, as the first step
of M14.** From then on squiz uses muster as an external tool, installed the way
a user installs it.

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
- **The test command in the prompt.** The configured test command is written
  into the reviewer's prompt at depth `deep`. The configuration still refuses
  `deep`, so no round reaches it yet.
- **A cut-short review recorded.** A round the time bound cut short says so in
  the summary.

### Acceptance criteria met

- [x] A file mutated during a run is named in the summary.
- [x] Two live episodes on one toplevel disable the comparison for that round.
      The round still runs, and the summary names the other episodes in flight.

### Acceptance criteria moved to M14

Each is restated there, against the round host.

- The specification's prerequisites for `squiz review` each have a finding in
  `docs/notes/`. Five do. The sixth, whether a subagent handed a long exit-2
  output works every thread, has none.
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
- Depth `deep` produces a command line with `bash`, and the configured test
  command reaches the reviewer.

### Acceptance criteria muster makes moot

M14 removes what these bound, and checks that each is gone.

- One deadline bounds each invocation, waiting included. Under M14 `squiz review`
  only waits, and its wait is its bound.
- A round runs inside a 540-second window from `squiz review` and a 600-second
  one from the hook, with a 30-second cap on pre-review calls, a 60-second
  posting reserve, and a `timeout` default per path.
- Each round's state records `postingSeconds`.

## M10 — Muster's spikes

The five questions muster's specification leaves open, cheapest first, each run
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
- [ ] **S9.** What GitHub Copilot CLI offers an adapter. Whether its
      `agentStop` and `subagentStop` hooks fire as documented. The largest
      `timeoutSec` it honours, and whether an `agentStop` hook that waits that
      long and then answers `block` wakes the session with its `reason`. Whether
      anything reaches an idle session from outside, such as its asynchronous
      `notification` hook. Which of muster's three layers Copilot lands in.
- [ ] **S6.** Whether `herdr agent start --kind pi` tracks a `pi` that runs with
      `--no-extensions`, and what status Herdr shows for it.

The owner decides where muster's state lives, the one decision muster's
specification leaves open, before M11 starts.

A result that contradicts muster's specification is reconciled in that
specification, not worked around.

## M11 — Muster's sessions and their backends

Muster becomes a Go module in `muster/` with a `muster` binary that starts,
watches and stops sessions in a Herdr tab, a tmux window, or a detached process.
It is usable on its own: a person can start a session with `muster start` and
manage it, with no trigger and no message.

It starts from the Go skeleton and muster's CI job. It also covers the
import-boundary test, the state directory, the session record, the three
backends, and `start`, `status`, `attach`, `wait`, `read`, `stop`, `prune` and
`closed`.

### Acceptance criteria

- [ ] `muster/go.mod` declares `github.com/jacygao/muster`, and `go build`
      produces the `muster` binary.
- [ ] A CI job of muster's own runs `go build`, `go test` and `go vet` green.
      Squiz's type check and tests ignore `muster/`.
- [ ] The import-boundary test fails on anything under `muster/` that imports
      from squiz's `src/`, and on anything under `src/` that imports from
      `muster/`. It runs in CI.
- [ ] Every command takes `--root`, which defaults to the git toplevel of the
      working directory, and prints JSON with `--json`.
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

CI installs tmux, and tests the tmux and detached backends there. It does not
install Herdr, which is before 1.0. The Herdr backend is tested where Herdr is
installed by hand.

## M12 — Muster's triggers, through an adapter per agent

When an agent stops working, muster runs the command `.muster.json` configures
for the event. Muster's core sees only its contract: a `settled` event, when an
agent ended its turn and waits for input, and a `finished` event, when a
subagent ended its work. Each agent reaches the contract through an adapter of
its own, in `muster/adapters/<name>/`:

- **`claude-code`**: `Stop` becomes `settled`, and `SubagentStop` becomes
  `finished`.
- **`pi`**: muster's extension turns `agent_settled` into `settled`.
- **`herdr`**: a plugin turns `pane.agent_status_changed` to `done` into
  `settled`. It is an extra source beside the adapters above, never the only one.

An agent no adapter covers takes part through the pull fallback. It runs the
command that does the work and reads what that prints, so nothing fires for it.
The fallback's own muster command, `muster wait --inbox`, reads messages and is
M13's.

GitHub Copilot CLI is an adapter to come, and is not built here. S9 says what it
can offer. Until it is built, a Copilot session takes part through the pull
fallback.

A trigger command's `watch` lines, and the wake they ask for, are M13's.

### Acceptance criteria

- [ ] `muster hook` runs every command `.muster.json` configures for the event,
      in `MUSTER_CWD`, with the contract's fields in its environment and
      nothing on its standard input.
- [ ] Each event carries `MUSTER_EVENT`, `MUSTER_AGENT`, `MUSTER_SESSION`,
      `MUSTER_CWD`, `MUSTER_ROOT` and `MUSTER_WAKE`. An agent's own payload goes
      no further than its adapter.
- [ ] No code outside `muster/adapters/` names an agent.
- [ ] `muster install <name>` puts an adapter's registration in place for a
      project.
- [ ] With the `claude-code` adapter installed, a main session's turn ending
      fires `settled`, and a subagent's fires `finished`.
- [ ] A `pi` session with the `pi` adapter fires `settled` once each time it
      settles.
- [ ] Inside Herdr, an agent whose status becomes `done` fires `settled` through
      the `herdr` adapter.
- [ ] A turn that ended on a question fires as any other turn does.
- [ ] A configured command's exit status, where it is not 0, is reported on
      `muster hook`'s stderr and never changes the hook's own exit status.

## M13 — Muster's inbox

Messages between sessions, and the wake that delivers one into the agent an
address belongs to. Covers the envelope, `muster send`, `muster inbox list` and
`muster inbox take`, `muster wait --inbox`, the `watch` lines, and each
adapter's wake: `push` for `pi`, and for Claude Code the `waiter`, the `push`, or
both, as S3 found.

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
- [ ] `muster wait --inbox <address>` waits for the next message on the address,
      takes it, and prints the same text a wake shows. With `--timeout`, it
      gives up after that many seconds and takes nothing.
- [ ] A trigger command's `watch <address>` lines ask for a wake on those
      addresses, where the adapter's wake is `push` or `waiter`. A `finished`
      event asks for none.
- [ ] A message sent to an address a settled `pi` session watches starts a turn
      in that session, with the text muster's specification shows.
- [ ] A message sent to an address an idle interactive Claude Code session
      watches starts a turn in it ten minutes after its last turn ended, by the
      wake S3 chose.
- [ ] A session that ended three turns has a message taken once, by the waiter
      for its newest turn.
- [ ] An agent no wake reaches, a Claude Code subagent among them, loses no
      message sent to it, and reads each with `muster wait --inbox` or
      `muster inbox take`.

## M14 — Squiz on muster

Squiz runs its reviewer as a muster session, `squiz review` becomes its one
entry point, and the limits that came from running the reviewer inside a coding
agent's hook or shell call go. `docs/specs/session-interface.md` governs, and
this milestone is steps 2 to 5 of its migration, after one step of its own:

- muster moved to its own repository, with its history, and installed into
  squiz's development the way a user installs it
- the report file the reviewer's extension writes
- the round host, `squiz host <number>`, run as a detached muster session per
  episode
- each round's reviewer as a muster session of its own, in a pane where Herdr or
  tmux is present
- `squiz review` as the harness specification sets it out, changed as the
  session interface changes it: it sends a message to the round host and waits
  on the record
- `squiz hook` as the command muster's triggers run, with muster's adapters,
  installed by `muster install`, in place of squiz's own hook
- `"reviewer": "session"` as the default

### Acceptance criteria

- [ ] Muster is in its own repository, `github.com/jacygao/muster`, with the
      history it had in `muster/`, and `muster/` is gone from this repository.
      Squiz is developed and tested against a `muster` installed the way a user
      installs it. This is done before anything else in the milestone.
- [ ] Squiz's spikes S5, S7 and S8, S2's open remainder, and the harness
      specification's remaining prerequisite for `squiz review`, whether a
      subagent handed a long exit-2 output works every thread, each have a
      finding in `docs/notes/`, and the owner has decided D2 to D11 before what each
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
- [ ] Depth `deep` produces a command line with `bash`, the configured test
      command reaches the reviewer, and the reviewer runs
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
`/squiz doctor`, and `docs/notes/` consolidated. Muster is installed on its own,
from its own repository.

### Acceptance criteria

- [ ] `/plugin marketplace add` followed by `/plugin install` works into a fresh
      host project. *Changed by muster: the getting-started steps also install
      `muster` and its adapters, and say how.*
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
