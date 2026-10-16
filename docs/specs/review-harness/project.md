# 8. The project

Squiz is its own repository, not a directory inside a host project.

## Language

Squiz is written in TypeScript and runs on Node. Node strips the types and runs
the `.ts` files as they are, so there is no build step and no compiled output.

- **Erasable syntax only.** No `enum`, no parameter properties, no namespaces. A
  union of string literals stands where an enum would.
- **Types are checked by `tsc --noEmit` in CI.** Stripping does not check them.
- **Node 24 or later.** The setup check reports the version.
- **macOS and Linux.** Squiz detaches its round host, finds its processes again
  and stops them through Unix process calls: `ps`, `setsid`, process groups and
  signals. On Windows it runs under WSL.
- **`bin/squiz` is a shell shim.** Node decides to strip types from the `.ts`
  extension, so the entry point cannot be an extensionless Node file. The shim
  execs the real one.

The Copilot extension is the one file in JavaScript, because Copilot starts only
an `extension.mjs`. It imports nothing but Node's own modules and the
`@github/copilot-sdk/extension` that Copilot supplies.

There are no runtime dependencies. Everything outside the process is a
subprocess: `git`, `gh`, `ps`, and the reviewer's own CLI. `ps` answers two
questions the runtime has no call for: when a process started, and what is
running in a process group.

## Structure

The layout is a Claude Code plugin, which is also how it is distributed. The
plugin is the package, so there is no separate packaging step.

```
.claude-plugin/plugin.json   manifest: name, version, description, and the Copilot extensions directory
.claude-plugin/marketplace.json  the marketplace named squiz, listing this repository's root as the one plugin
hooks/hooks.json             the Stop and SubagentStop registrations, the Claude Code and Copilot triggers
extensions/squiz-wake/       extension.mjs, the Copilot extension the round host wakes a Copilot session through
bin/                         the CLI, on Claude Code's Bash tool PATH while enabled, and linked onto PATH for other agents by squiz init
charter.md                   the standing review instructions, shipped as one file
src/
  cli.ts                     the entry point bin/squiz execs, one subcommand each
  config/                    .squiz.json, its defaults and its ranges
  review/                    the squiz review entry point, what it prints and exits with, squiz status, squiz init, and squiz doctor
  hook/                      the Stop and SubagentStop trigger, which resolves the pull request and queues the review
  host/                      the round host, which takes queued states and runs their rounds
  sessions/                  starting and finding a session, closing its pane, reading a hook's payload, the note and its wake, and the user's Copilot settings; no review knowledge
  loop/                      episode state, round cap, verdict decisions
  worktree/                  toplevel resolution and the reviewer's snapshot
  reviewers/                 one adapter per reviewer CLI, pi/ and copilot/, what each hands its CLI, and the report checks they share
  github/                    the pull request, threads, replies, resolve and re-open, summary
  findings/                  the finding contract, how one is read as the reviewer reports it, severity, the anchor validator, and where a finding's comment goes
  measure/                   the rig that runs the real reviewer once over a change with known defects, the changes it runs over, and its summary; no command reaches it
docs/specs/review-harness/   this specification, one file per section
docs/notes/                  durable facts learned by building
```

`src/` is organised by what a thing is about rather than by which command
reaches it. Several commands share `github/`, and `cli.ts` maps a subcommand to
the directory that does the work.

**`src/sessions/` knows nothing about reviews.** It starts a command as a
session, finds it again by pid and start time, closes its pane, reads a hook's
payload into the session that stopped and the session that owns it, writes
and delivers a note, and reads the user's Copilot settings. Nothing in it names
a pull request, a round or a finding, and it imports nothing from the rest of
`src/`, so it can be lifted out whole if a second tool needs it. A test will
read its imports and fail on any that reaches into the rest of `src/`.

A test sits beside the code it tests, named for it: `src/config/config.ts` is
tested by `src/config/config.test.ts`. One `include` then covers the code and
its tests together.

## What ships

**P0** has to exist for the harness to do its job at all. **P1** is expected,
and the loop works without it. **P2** is possible, and nothing is built for it
until something asks.

| | | |
|---|---|---|
| **P0** | The command and the loop | `squiz review <number>`, the pull request gate, the record per head commit and latest reply, the round cap, the exit statuses and what is printed with each, and the time bound on the reviewer |
| **P0** | The Claude Code hooks | The `Stop` and `SubagentStop` registrations, which resolve the pull request for their worktree, queue the review and return |
| **P0** | The round host | `squiz host`, started by a double fork, which runs an episode's rounds one at a time and is found again by pid and start time |
| **P0** | The reviewer session | A fresh reviewer per round in a tmux or Herdr pane, or detached, whose pane closes at the end and whose session stays resumable |
| **P0** | The report | The note for the session that owns the work, and its wake by the messaging socket or the `asyncRewake` waiter |
| **P1** | The Copilot wake | The extension that wakes an idle Copilot session, through the same post as Claude Code's socket. It runs only with Copilot's experimental features on, so squiz's Copilot support is experimental |
| **P0** | The `pi` adapter | The command line, the extension the reviewer reports through and the report file it writes, the read of that file, and the grant |
| **P0** | The charter | The standing rules handed to the reviewer every round |
| **P0** | The finding contract | `file`, `line`, `severity`, the body fields, the rule routing a finding inline, onto its file, or general, and the per-thread verdicts |
| **P0** | The GitHub client | Finding the pull request whose head is a branch, creating a thread anchored to a file and a line or to a file as a whole, reading the threads already on a pull request with their replies and resolved state, resolving and re-opening through GraphQL, and posting the summary comment |
| **P0** | The coding agent's commands | `squiz threads` and `squiz reply`, which are how the coding agent works the threads |
| **P0** | The summary comment | The counts, the cost, what needs a person, and the notes, composed when the episode closes |
| **P0** | The failure comment | What failed and the salvaged findings no thread holds, posted by a round that fails, with the same reason the command prints |
| **P0** | The command's stderr | The one line that carries a failure GitHub could not be told about. Without it a round that cannot reach GitHub says nothing about why |
| **P0** | The episode state file | Round count, per-round cost, what the episode spent on attempts that were no round, whether its close has been reported, keyed by the pull request's number and living in the worktree |
| **P1** | The history tools | `git_log_search`, `git_blame` and `git_show`, granted to every reviewer, each running one `git` subcommand that reads, with no argument reaching a shell and nothing in the repository able to make `git` run a program |
| **P1** | `squiz status` | The reviews running and finished in every worktree, for a person and a coordinator |
| **P1** | The token bound | 10,000,000 tokens a round, read before a round starts and again when one records what it spent |
| **P1** | The setup check | `squiz doctor`, run from a shell, which names which of the dependencies is missing or unauthenticated, and whether `squiz init`'s link puts this squiz on `PATH` |
| **P1** | `squiz init` | Links `squiz` onto `PATH` without replacing another, for coding agents other than Claude Code |
| **P1** | A second reviewer adapter | The Copilot adapter: its shell line, the reporting server, the custom agent that carries the charter, the grant, the read of its usage line in tokens and AI credits, and `reviewer` in configuration |
| **P1** | The reviewer's model in configuration | A `model` setting, so a project chooses the model its reviewer runs on, defaulting to the user's default |
| **P1** | A finding anchored to a range | `start_line` alongside `line`, so a finding about several lines highlights all of them. The anchor validator would have to hold each hunk's span, which it does not today, and the reviewer would have to return a range worth reading |
| **P2** | A GitHub App identity | The harness posts as its own bot rather than as the account that authenticated `gh`. Configured by the host project, which installs the App and holds its key |
| **P2** | An operating-system sandbox | The reviewer, and every process it starts, inside a boundary the operating system enforces: writes only to its round, network only to the model and the package registries, none of the user's credentials. A review level that runs the project's code would need it first (#529) |
| **P2** | Tracking findings scoped to the change as a whole | Today they are reported in the summary comment and carried no further |
| **P2** | A record other than a pull request | The pull request is one implementation behind an interface, and the identity a comment is posted under is the one whatever holds the record supplies |
| **P2** | A person in the review cycle | What the loop does with a thread a person opened, beyond leaving it alone |
| **P2** | A check that says a review is in progress | A status on the pull request that is not green while an episode is running, so the change does not read as ready to merge mid-review |

## Prerequisites

Facts the design rests on that have not been established. Each is settled before
the part that rests on it is built, and each result is written as a finding in
`docs/notes/`.

- **Linux.** The detach and pane probes ran on macOS alone, and so did every
  Copilot run, whose credential was `gh`'s login in macOS's keychain.
- **A Copilot login from `/login`.** Every Copilot run signed in through `gh`'s
  login. Whether a login from Copilot's own `/login` reaches a reviewer under the
  adapter's `COPILOT_HOME` has not been run.
