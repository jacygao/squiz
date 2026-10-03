# Muster Specification: Triggers, Sessions That Outlive Them, and an Inbox

**Version:** 0.1 (draft)
**Status:** For review
**Owner:** TBD

---

## 1. Purpose

**Muster runs a command when a coding agent finishes, starts agent
sessions that outlive whatever started them, and carries short messages
between sessions.** It knows nothing about code review, pull requests or any
one tool that uses it. Squiz is its first user, and `docs/specs/session-interface.md`
in the squiz repository says what squiz asks of it.

It does three jobs:

- **Triggers.** When a Claude Code session or subagent ends its turn, or a `pi`
  session settles, muster runs the command a project configured.
- **Sessions.** It starts a command or an agent as a session in a Herdr tab, a
  tmux window, or a detached process. The session outlives the trigger that
  started it. Muster lists, watches and stops it.
- **Messages.** It keeps an inbox of files per address, and wakes the session
  an address belongs to when a message arrives.

Muster lives in squiz's repository for now, in the top-level directory
`muster/`, and moves to a repository of its own later. Nothing here is built.
§ 9 lists what is not established and the spike that settles each.

## 2. Decisions for the owner

| # | Decision | Recommended |
|---|---|---|
| M1 | Where muster's state lives | `.muster/` at the root the command is given, which defaults to the git toplevel of the working directory. A project that uses muster adds `.muster/` to its `.gitignore`, as it does `.squiz/`. The alternative is a directory under the user's state home, keyed by the root, which needs no `.gitignore` entry and is harder to find. |

## 3. The boundary

**Muster imports nothing from squiz, and squiz imports nothing from
muster.** Nothing under `muster/` imports a module under squiz's `src/`, and
nothing under `src/` imports a module under `muster/`. Each calls the other
only as a command. A test in the repository will read every import in both
trees and fail on any that crosses.

Muster carries no word of squiz's vocabulary. A message's kind and pointer
are strings it stores and delivers without reading. An address is a name it
does not interpret. A trigger's command is a command line it runs.

## 4. Triggers

### What fires one

| Event | Source | Fires when |
|---|---|---|
| `stop` | Claude Code `Stop` hook | A main session's turn ends |
| `subagent-stop` | Claude Code `SubagentStop` hook | A subagent's turn ends |
| `pi-settled` | Muster's `pi` extension, on `agent_settled` | A `pi` session settles, and will not continue on its own |
| `herdr-done` | Muster's Herdr plugin, on `pane.agent_status_changed` | Herdr reports an agent in one of its panes as `done` |

Every source runs `muster hook`, which reads the event and its payload and runs
the commands configured for it.

**The Herdr plugin is an extra source, never the only one.** Herdr runs a
plugin's command on `[[events]] on = "pane.agent_status_changed"`, from its own
server. The event names a pane and a status, not a task. A subagent finishing
changes nothing on screen, so it never fires for `SubagentStop`'s case, and for
Claude Code Herdr reads the status from the screen. Herdr's `done` means idle
and not yet seen, which a turn that ended on a question also is. It fires only
inside Herdr. The Claude Code registration:

```json
"Stop": [
  { "hooks": [ { "type": "command", "command": "<muster>/bin/muster hook", "asyncRewake": true, "timeout": 86400 } ] }
],
"SubagentStop": [
  { "hooks": [ { "type": "command", "command": "<muster>/bin/muster hook" } ] }
]
```

### What it runs

`.muster.json`, at the root, names a command for each event:

```json
{
  "triggers": [
    { "on": ["stop", "subagent-stop", "pi-settled"], "run": ["squiz", "hook"] }
  ]
}
```

The command runs in the working directory the event fired in. It gets the event
in `MUSTER_EVENT`, the root in `MUSTER_ROOT`, and the runtime's own payload on
its standard input, unchanged.

**A trigger's command may name the addresses its session should be woken
from.** Each line of its standard output of the form `watch <address>` adds one.
For a `stop` or a `pi-settled` event, `muster hook` then waits on those
addresses and wakes the session when a message arrives, as § 6 sets out. A
command that prints no `watch` line asks for no wake. For `subagent-stop`
nothing waits: a subagent in Claude Code's auto mode has already handed back by
the time its stop hook runs, and nothing reaches it.

A command's exit status is reported on `muster hook`'s stderr where it is not 0,
and never changes the hook's own exit status.

### A turn ending is not work being done

Claude Code fires `Stop` whenever a turn ends, including a turn that ended on a
question. Muster fires on every one. Deciding whether a turn finished
anything is the command's job.

## 5. Sessions

### Starting one

```
muster start --name <name> --cwd <dir> [--backend herdr|tmux|detached] [--kind <agent>] [--env KEY=VALUE]... -- <command> [args...]
```

`--kind` names an agent Herdr knows, such as `pi` or `claude`. Without
`--backend`, muster picks the first that applies:

1. **Herdr**, where `HERDR_SOCKET_PATH` or `HERDR_PANE_ID` is set.
2. **tmux**, where `TMUX` is set.
3. **Detached**, otherwise.

| Backend | How it starts the session |
|---|---|
| Herdr | `herdr tab create --cwd <dir> --label <name> --no-focus --env …` gives a pane. Where `--kind` is given, `herdr agent start <name> --kind <kind> --pane <pane> -- <args>` starts the agent in it and returns once the agent is ready for input. Otherwise `herdr pane run <pane> <command>` runs the command. |
| tmux | `tmux new-window -d -n <name> -c <dir> -e KEY=VALUE … '<command>'`, which takes the command as an argument rather than typing it. |
| Detached | A double fork with `setsid` between the forks. The session leads a process session of its own, is a child of pid 1, and has its standard input on `/dev/null` and its output in `.muster/sessions/<name>.log`. |

**A session outlives the trigger that started it.** A trigger runs inside a
Claude Code shell call or hook, and Claude Code stops one by signalling both the
command's process tree and its process group. On Claude Code 2.1.288 on macOS,
a double fork with `setsid` between the forks escaped that, and nothing weaker
did. In Herdr and tmux the session is a child of the multiplexer's server, which
was already running, so it is outside the command's tree and group from the
start. That is not measured, and it is spike S1.

### The record

`.muster/sessions/<name>.json` records the backend, the backend's identifier
for the tab, pane or window, the session's pid and its start time, the command,
and the log path where there is one. A pid with its start time is the
identity: a pid alone is reused.

A name is unique within a root. Starting a session whose name has a live record
fails, and names the live one.

### Watching one

| Command | Herdr | tmux | Detached |
|---|---|---|---|
| `muster status` | Every record, with alive or exited, and for an agent Herdr's `agent_status` | Every record, alive or exited | Every record, alive or exited |
| `muster attach <name>` | Focuses the tab | Selects the window | Follows the log |
| `muster wait <name>` | `herdr agent wait`, or until the pane's process exits | Until the window's process exits | Until the pid exits |
| `muster read <name>` | `herdr pane read --source recent` | `tmux capture-pane -p` | The log's tail |

### Stopping one

`muster stop <name>` stops the session and removes its record.

| Backend | What it sends |
|---|---|
| Herdr | `herdr pane close`. Herdr sends `SIGHUP`, then `SIGTERM`, then `SIGKILL`, 250 ms apart, to every process in the pane shell's process session. |
| tmux | `tmux kill-window`. What reaches the window's processes is spike S4. |
| Detached | `SIGTERM` to the session's process group, where the pid and its start time still match the record, then `SIGKILL` after five seconds to what is left. |

**A process that left the session's process session is not stopped.** A tool
that starts its children in sessions of their own has to stop them itself.
Muster says so rather than hunting for them.

A record whose process has gone, by pid and start time, is an exited session.
`muster status` shows it, and `muster prune` removes every such
record.

## 6. Messages

### The envelope

A message is an envelope of four fields the sender sets, and two muster
adds:

```
schema=muster-envelope.v1
at=2026-10-03T08:14:02Z
from=squiz-reviewer-41
to=squiz-coder-41
kind=threads-open
pointer=pr=41 head=3f9c2e0 round=2 threads=PRRT_kwDOL7tYbc5abcd1,PRRT_kwDOL7tYbc5abcd2 next=squiz review 41
```

- `from` and `to` are addresses: names of at most 64 characters from
  `[A-Za-z0-9._-]`.
- `kind` is a word the sender's own protocol defines.
- `pointer` is one line of at most 1,024 bytes. It says where to look, and the
  thing itself lives elsewhere.
- `schema` and `at` are muster's.

Muster reads none of `kind` or `pointer`.

### The inbox

```
muster send --from <address> --to <address> --kind <kind> --pointer <line>
muster inbox list <address>
muster inbox take <address>
```

Each address has a directory, `.muster/inbox/<address>/`, with one file per
message, numbered in the order they were sent:

```
.muster/inbox/squiz-coder-41/0004.msg
.muster/inbox/squiz-coder-41/handled/0003.msg
```

- **A message is written whole or not at all.** `muster send` writes it under a
  temporary name and renames it into place.
- **Moving a message into `handled/` is the acknowledgement.** `muster inbox
  take` prints the oldest message and moves it there in one rename, so two
  readers never both take one.
- **A message nobody has taken stays.** The next wait on its address delivers it
  first.

This is firstmate's steering-inbox format and rule. Muster does not use
firstmate's code.

### Waking a session

Muster delivers a message into the agent the address belongs to through
that agent's runtime. It never types into a terminal.

| Runtime | How it is woken | Established |
|---|---|---|
| `pi` | Muster's `pi` extension watches the addresses its trigger named. On a message it takes it, and calls `pi.sendUserMessage(text, { deliverAs: "followUp" })`. | Yes. firstmate's `pi` watcher wakes its first mate this way. |
| Claude Code, by `asyncRewake` | `muster hook`, registered on `Stop` with `asyncRewake: true`, waits on the addresses after the trigger's command returns. On a message it takes it, writes the text to stderr, and exits 2. Claude Code documents this as waking the session and showing it the stderr. | Documented. Not measured by this project. Spike S3. |
| Claude Code, by its messaging socket | `muster hook` records the session's `CLAUDE_CODE_MESSAGING_SOCKET` against the addresses it was asked to watch. `muster send` to one of them posts to that socket. An idle session starts a turn with the message. | Documented since Claude Code 2.1.224. Whether a post from a detached process is accepted as the session's own is not established. Spike S3. |

The text a session is shown:

```
squiz-reviewer-41 sent threads-open: pr=41 head=3f9c2e0 round=2 threads=PRRT_kwDOL7tYbc5abcd1,PRRT_kwDOL7tYbc5abcd2 next=squiz review 41
```

**One waiter per session delivers.** Claude Code does not deduplicate
background hooks, so a session that ends three turns has three waiters. Each
records the turn it was started for, and a waiter whose session has ended a
later turn exits 0 without taking anything. Only the newest takes a message.

## 7. Commands

| Command | What it does |
|---|---|
| `muster hook` | The trigger entry point, for Claude Code's hooks and the `pi` extension. § 4. |
| `muster start`, `status`, `attach`, `wait`, `read`, `stop`, `prune` | § 5. |
| `muster send`, `muster inbox list`, `muster inbox take` | § 6. |

Every command takes `--root <dir>`, which defaults to the git toplevel of the
working directory. Every command prints JSON with `--json`.

## 8. The project

```
muster/
  bin/muster                  a shell shim that execs src/cli.ts
  hooks/hooks.json            the Stop and SubagentStop registrations
  herdr-plugin/               the Herdr plugin manifest and its command, for herdr-done
  extensions/pi.ts            the pi extension: the pi-settled trigger and the pi wake
  src/
    cli.ts                    one subcommand each
    triggers/                 reading an event, running the configured commands, the waiter
    sessions/                 the record, and one backend each for Herdr, tmux and detached
    inbox/                    the envelope, send, take, and the watch with a poll behind it
  docs/specs/                 this document
```

It is TypeScript run by Node with its types stripped, with no runtime
dependencies, as squiz is. While it lives in squiz's repository, squiz's plugin
manifest registers its hooks. That is packaging and not an import, so the
boundary under § 3 holds.

## 9. Open questions and spikes

Cheapest first. Each result is written as a finding.

| | Question | Spike |
|---|---|---|
| S1 | Does a tmux window, or a Herdr tab started with `herdr agent start`, created from inside a Claude Code shell call or hook outlive the runtime stopping that call? Does a detached session whose output goes to a log file escape as the measured one with `/dev/null` did? | Rerun the detach probe with each backend as the child. Minutes. |
| S3 | Which wake reaches an idle interactive Claude Code session ten minutes after its turn ended: an `asyncRewake` exit 2, a post to `CLAUDE_CODE_MESSAGING_SOCKET`, or both? In auto mode and outside it? Is an `asyncRewake` hook's exit 2 dropped once it reaches its timeout? | A probe in an interactive session in tmux, since a `-p` session exits at turn end. An hour. |
| S4 | Which processes do Herdr's pane close and tmux's `kill-window` reach? | A pane whose command starts children in its own group and in a session of their own, each logging the signals it gets. An hour. |
| S6 | Does `herdr agent start --kind pi` track a `pi` that runs with `--no-extensions`, so that Herdr's own `pi` extension does not load? What status does Herdr show for it? | A Herdr tab. An hour. |

Not established, and not designed around:

- **Linux.** The detach probe ran on macOS alone.
- **A Herdr server that is not running.** The Herdr backend is chosen only from
  inside Herdr, where its server is running. What `herdr tab create` does
  otherwise was not read.
- **Whether a `herdr-done` event and a `stop` event for one turn can be told
  apart.** Both fire for a Claude Code session in a Herdr pane. The command they
  run must treat a second firing for the same state as nothing, which squiz's
  one review per state already does.

## 10. What it rests on

| Source | Version read | What this document uses |
|---|---|---|
| Claude Code | 2.1.288, and the docs at code.claude.com/docs/en/hooks and /cross-session-messaging | `Stop`, `SubagentStop`, `asyncRewake`, `CLAUDE_CODE_MESSAGING_SOCKET`. The kill of a command's tree and group, measured on 2.1.288. |
| `pi` | `earendil-works/pi` at `a276dab` (1.0.0), and 0.85.1 | `agent_settled`, `sendUserMessage` with `deliverAs`. Extensions load in every mode. |
| Herdr | `herdrdev/herdr` at `5da0a01` (0.9.3) | Plugin events on `pane.agent_status_changed`. `tab create`, `agent start`, `agent wait`, `pane run`, `pane read`, `pane close`, and what a pane close signals. Pre-1.0, with breaking changes in minor and patch releases. |
| firstmate | `kunchenguid/firstmate` at `1f3e769` | The inbox format, and the move into `handled/` as the acknowledgement. |
