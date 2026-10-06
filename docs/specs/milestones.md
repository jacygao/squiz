# Milestones

**Version:** 0.31 (draft)
**Status:** For review
**Owner:** TBD

---

Fourteen milestones for building squiz, in the order they are done. Each ends in
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
| 9 | M10 — The subagent-era workarounds removed | Done |
| 10 | M12 — Copilot as the reviewer | Done |
| 11 | M13 — Copilot as a coding agent | Done |
| 12 | M11 — Depth `deep` | |
| 13 | M8 — Episode boundaries | |
| 14 | M9 — Install and dogfood | |

**A milestone's number names it, and the table places it.** M10, M12, M13 and
M11 come before M8 and M9 in the order.

**From M7, squiz runs its reviewer as a session of its own, instead of inside a
subagent's hook or shell call.** The review itself stays as it is: findings as
threads on the pull request, verdicts on replies, rounds, a cap, and a summary.
So do the commands the coding agent runs to read and answer it.

**`docs/specs/review-harness-spec.md` specifies the design.** The session,
trigger and wake code lives in `src/sessions/`, which knows nothing about
reviews and imports nothing from the rest of `src/`, so it can be lifted out if
a second tool needs it.

**The first version leaves three things out:** delivering a note when a session
starts, rules for acknowledging a note and retrying one, and messages in both
directions. GitHub Copilot is the one coding agent besides Claude Code that the
first version supports, experimentally, in M13.

M9 is the last of them. The P1 and P2 entries of the specification's What ships
that no milestone here delivers are a second version, and its milestones are
planned once M9 closes. M12 was the exception: it brought forward "a second
reviewer adapter", for GitHub Copilot, because the owner reviews with Copilot
already.

## M0 — Prerequisites spike

**Done.** Its criteria are in #8.

Settled, each as a finding in `docs/notes/`, the facts the specification rested
on and had not established: that `SubagentStop` exit 2 resumes the subagent, the
hook payload's fields and `stop_hook_active`, that `git rev-parse --show-toplevel`
separates two concurrent subagents, the `gh api` request shapes for creating,
replying in, resolving and re-opening a review thread, that `pi --tools`
withholds `edit` and `write`, and when `pi` reports cost. No production code
survived it. It left nothing held.

## M1 — Plugin skeleton, configuration, and the gate

**Done.** Its criteria are in #35.

Made the repository a loadable plugin with a `squiz` binary, a shell shim that
execs `node src/cli.ts`, and a hook that gates on the pull request and exits 0.
It added `tsc --noEmit` and the tests in CI, `.squiz.json` loading with its
defaults and range validation, the top-level trap that turns any throw into
exit 0, and the single-line stderr reporter. It left nothing held.

## M2 — The finding contract and the comment format

**Done.** Its criteria are in #46.

Built, as pure code with no input or output, the finding shape, the three
verdicts and four terminal statuses, severity ordering, the comment renderer,
and the unified-diff parser that decides whether a finding's line is one the
change touched. A finding whose anchor the parser rejects becomes a general
finding carrying its `file:line`. It left nothing held.

## M3 — The GitHub client and the coding agent's commands

**Done.** Its criteria are in #65.

Built everything that shells out to `gh`, each failure returned as a typed error,
and the coding agent's two commands, `squiz threads` and `squiz reply`. It reads
the pull request and its diff, lists review threads, posts anchored threads,
replies in them, resolves and re-opens them, and posts issue-level comments. It
left nothing held.

## M4 — The reviewer

**Done.** Its criteria are in #95.

Built `charter.md`, the `pi` adapter's command line, stream parsing and grants,
and the spawn harness that runs the reviewer at depth `read`: its working
directory and scratch space, `< /dev/null`, the time bound, one parse retry,
cost extraction, and the prompt carrying the pull request and its threads. Depth
`deep` was left to M11, in #113.

## M5 — The round

**Done.** Its criteria are in #146.

Composed M3 and M4 into the round, with episode state under `.squiz/`. A round
gates on the pull request, reviews, posts new findings as threads, and applies
each verdict to the thread it names. It was built as the hook, which then
blocked the coding agent with exit 2 or closed the episode at the cap with
exit 0. M7 moved the round into the round host. It left nothing held.

## M6 — The summary comment

**Done.** Its criteria are in #186.

Classified every thread into its terminal status when an episode closes, and
posted the summary comment once, never edited: the counts, the per-round costs
with the episode total, the needs-a-person list, and Notes. It left nothing
held.

## M7 — The reviewer as a detached session

**Done.** Its criteria are in #299. The criteria of its first scope,
confinement detection and shared trees, are in #225.

Moved the review out of the hook. A trigger queues the pull request's state, and
`squiz host <number>`, one detached round host per episode, runs the round. Each
round's reviewer is a fresh `pi` session reading a snapshot of the head commit,
in a tmux or Herdr pane where one exists and detached otherwise. `squiz review`
queues a state and waits for its round, and the hooks on `Stop` and
`SubagentStop` queue a state and return at once. When a round records its
result, the session that owns the work gets a note and a wake by the messaging
socket. It also built the tracked-file and `HEAD` comparisons, the refused calls,
the shell-group record, `squiz status`, the failure comment, the review skill and
`squiz init`.

It left these held, with `milestone:M9`:

- **Recovering a round whose host died** (#327). Until then a reviewing record
  whose host has gone reads as killed, and nothing stops its orphaned reviewer
  or removes its snapshot.
- **The `Stop` hook's `asyncRewake` waiter** (#334). Until then the round host
  wakes the owner by the messaging socket alone, and a note no socket reached is
  read through `squiz review` or `squiz status`.

The other gaps M7 left are held for after the MVP, labelled `held` and
`milestone:M9`.

## M10 — The subagent-era workarounds removed

**Done.** Its criteria are in #466.

Removed what reviewer sessions made redundant, from the code and the
specification: the hook-path window constants, the blocking reason and the
hook's round reporting, shared-tree detection, and the round's own end decision
beside the round host's. It added a test that a killed reviewer which moved
`HEAD` names the move in the failure comment and on stderr. It cleaned the
specification section by section, and reduced the done milestones here to what
they delivered. Every issue held for it has its disposition recorded on the
issue.

It left these held, with `milestone:M9`: the charter rewrite (#281), naming
refused calls in the summary (#244), and whether a stopped reviewer is gone
within the grace (#297).

## M12 — Copilot as the reviewer

**Done.** Its criteria are in #457.

Added a second reviewer adapter, for the GitHub Copilot CLI, chosen with
`"reviewer": "copilot"` in `.squiz.json`; `pi` stays the default. Copilot runs
from one shell line with its own `COPILOT_HOME`, on the user's default model,
with the charter as a custom agent and the three reporting calls served by an
MCP server that applies the shared report checks. A round records a cost only
where it is exact, in tokens and AI credits. A long pane line runs from a file,
so Copilot starts in a Herdr pane. A live run worked a planted defect to exit 0.

It left these for M9: choosing the reviewer's model in `.squiz.json` (#483),
and the setup check following `reviewer` (#512). Its open questions about
Copilot are held with `milestone:M9`, and granting `deep` to Copilot is #526,
with M11.

## M13 — Copilot as a coding agent

**Done.** Its criteria are in #533.

Let a GitHub Copilot CLI session work its pull request's review the way a Claude
Code session does. Copilot loads the plugin with `--plugin-dir`, and with it the
review skill and the `Stop` and `SubagentStop` hooks. Copilot leaves the
plugin's `bin/` off the shell's `PATH`, so `squiz init` links `squiz` onto it.
The hooks take the pull request from the payload's `cwd`, and the owner from the
payload, never from an inherited Claude Code socket. An extension the plugin
ships, `extensions/squiz-wake/`, listens on a socket in each session's state
directory and turns the round host's post into a turn, so an idle session is
woken as Claude Code's is. A live run on `gpt-6-astra`, given a task that never
named squiz, opened a pull request, ran `squiz review` and worked a finding to
exit 0.

**Its Copilot support ships experimental.** Copilot has no stable way to wake an
idle session, and loads the extension only with its experimental features on,
so setting up Copilot includes turning them on. A Copilot session without them
is unsupported: its reviews still run, and it learns the result only from a
`squiz review` it runs itself.

## M11 — Depth `deep`

The reviewer at `deep` runs the project's tests and reads its history, through
tools that do one thing each, on the snapshot M7 gives every reviewer. It is
granted no shell.

The snapshot holds no installed dependencies, so the configured test command
installs or builds what it needs before the tests run. What that adds to a round
is measured before M11 is planned (#496).

### Acceptance criteria

- [ ] Depth `deep` grants the `read` tools and these, and no shell, for `pi` and
      for Copilot:
  - `run_tests`, which takes no argument and runs the configured test command;
  - `git_log_search`, `git_blame` and `git_show`, which take a term, a file and
    line, and a commit, and run only that `git` subcommand.
- [ ] No argument reaches a shell: each tool runs its command with its arguments
      as separate words.
- [ ] The reviewer's environment carries no GitHub token or `gh` credential.
- [ ] A write the configured test command makes is detected on the snapshot and
      named in the summary.
- [ ] A configured test command that works in a fresh checkout runs to
      completion in the snapshot.
- [ ] The harness specification's § 4 Confinement says what remains: the test
      command runs the project's code at the commit under review with the user's
      access, as the coding agent's own test runs do, and nothing confines it.
      An operating-system sandbox is held as #529.

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
