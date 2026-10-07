# Milestones

**Version:** 0.34 (draft)
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
| 12 | M11 — One review level | Done |
| 13 | M8 — Episode boundaries | Done |
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

M9 is the last of the fourteen. The P1 and P2 entries of the specification's What ships
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
`deep` was left to M11, in #113. M11 then replaced both depths with one review
level.

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
and the setup check following `reviewer` (#512). M11 then delivered #483. Its open questions about
Copilot are held with `milestone:M9`, and granting `deep` to Copilot is #526,
with M11. M11 then replaced `deep` with one review level, which grants Copilot
the history tools as it does `pi`.

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

## M11 — One review level

**Done.** Its criteria are in #536.

Gave every reviewer one level. Both `pi` and Copilot get the reading tools, the
three reporting calls, and three history tools, `git_log_search`, `git_blame`
and `git_show`, at every review, and no setting changes the grant. It removed
the `depth` and `test` settings, `run_tests`, the process-group record, the
tracked-file and shared-config comparisons, and the scratch `TMPDIR`. `pi`'s
refusal became an allow-list of the grant. The reviewer's reads are confined to
the snapshot, its environment carries no GitHub credentials, and the snapshot is
a clone with its own git directory, outside the repository. M11 also added the
`model` setting (#483), and removed the review skill and the `AGENTS.md` section
`squiz init` wrote (#600).

It began as depth `deep`, a reviewer that also ran the project's tests, and
became one level because #590 measured, over 204 reviews of changes with known
defects, that `deep` found no more of them than `read`.

It left the operating-system sandbox held (#529), needed only if a level that
runs code returns.

## M8 — Episode boundaries

**Done.** Its criteria are in #603.

Bounded an episode by the tokens it spends, at 10,000,000 a round, and gave
every failure a place where a person reads it. An episode that reaches the bound
closes with the findings it has, and its summary says the bound was reached,
including when the close comes before a round (#508, #626). A reviewer that ran
before its start failed, and an attempt the harness throws out of, count against
the bound (#450), and that reviewer is stopped before its spend is read (#625).
A failed last round's comment and owner note no longer promise a retry the
closed episode will not run (#544, #622).

The § 7 audit (#604) gave every failure path in the harness specification the
surface a person reads it on: the failure comment, `squiz status`,
`.squiz/<number>/host.log`, or `squiz review`'s stderr. These closed the silent
paths it found: #357, #406, #414, #425, #511, #605, #606, #607, #608, #609 and
#632.

It left these held, with `milestone:M9`:

- **Removing a round's snapshot before its result is recorded** (#640), which
  delays every waiting `squiz review`.
- **How a close before any review counts a resolved thread** (#627), since
  nothing records whether fixed or withdrawn closed it.
- **Whether the summary counts a ruling GitHub refused** as ruled, or as it
  stands on GitHub (#650).

## M9 — Install and dogfood

The marketplace manifest, a README carrying the getting-started steps,
`/squiz doctor`, and `docs/notes/` consolidated.

### Acceptance criteria

- [ ] `/plugin marketplace add` followed by `/plugin install` works into a fresh
      host project. *Changed by Copilot as a coding agent: so does the plugin
      loaded into Copilot, with `copilot plugin install` or `--plugin-dir`, with
      Copilot's experimental features on as the harness specification's § 9
      says (#602).*
- [ ] `/squiz doctor` reports `git`, `gh` and its authentication, `pi`, Claude
      Code, and the Node version, naming whatever is missing. *Changed by
      detached sessions: it also reports whether tmux or Herdr is present.
      Neither is required.* It reports whether `squiz init`'s link puts this
      squiz on `PATH`. *Changed by Copilot as the reviewer and as a coding
      agent: in place of `pi`, it reports the reviewer `.squiz.json` names, and
      that reviewer's model (#512). It reports the Copilot CLI wherever Copilot
      is the reviewer or a coding agent, and, for a Copilot coding agent,
      whether Copilot's experimental features are on.*
- [ ] A subagent there produces a reviewed pull request end to end. *Changed by
      detached sessions: a main session does too, woken by a note. Changed by
      Copilot as a coding agent: so does a Copilot session, woken through the
      plugin's extension.*
- [ ] Squiz reviews its own pull requests in this repository. *This has held
      all through M11 and M8.*

### Issues

- #259, have `/squiz doctor` name the reviewer settings squiz overrides in this
  project
- #271, name the reviewer and its model in the summary comment
- #274, look once at whether an interactive session shows a hook's stderr when
  it exits 0
