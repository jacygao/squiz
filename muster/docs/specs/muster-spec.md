# Muster Specification: Triggers, Sessions That Outlive Them, and an Inbox

**Version:** 0.5 (draft)
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

- **Triggers.** When a coding agent ends its turn, or a subagent ends its work,
  muster runs the command a project configured. It works with any agent, through
  a thin adapter where the agent has hooks and through a pull fallback where it
  has only a shell.
- **Sessions.** It starts a command or an agent as a session in a Herdr tab, a
  tmux window, or a detached process. The session outlives the trigger that
  started it. Muster lists, watches and stops it.
- **Messages.** It keeps an inbox of files per address, and wakes the session
  an address belongs to when a message arrives.

Muster lives in squiz's repository for now, in the top-level directory
`muster/`, and moves to a repository of its own later. Nothing here is built.
§ 10 lists what is not established and the spike that settles each.

## 2. Decisions for the owner

| # | Decision | Recommended |
|---|---|---|
| M1 | Where muster's state lives | `.muster/` at the root the command is given, which defaults to the git toplevel of the working directory. A project that uses muster adds `.muster/` to its `.gitignore`, as it does `.squiz/`. The alternative is a directory under the user's state home, keyed by the root, which needs no `.gitignore` entry and is harder to find. |

## 3. The boundary

**Muster and squiz are separate modules, and neither imports the other.**
Muster is a Go module and squiz is a TypeScript package, so the boundary is a
module boundary. Each reaches the other only as a command, or through a file
the other writes. The one place the two languages meet is `pi`'s adapter,
`adapters/pi/extension.ts`, which is TypeScript. A test will read its imports,
and every import under squiz's `src/`, and fail on any that crosses into the
other's tree.

Muster carries no word of squiz's vocabulary. A message's kind and pointer
are strings it stores and delivers without reading. An address is a name it
does not interpret. A trigger's command is a command line it runs.

## 4. Agents

Muster works with any coding agent, in three layers. Only the second knows which
agent it is talking to.

| Layer | What it is | Who sees it |
|---|---|---|
| **The contract** | Events in and wakes out, in muster's own formats | Muster's core, and every program muster runs, squiz included |
| **Adapters** | One per agent, translating that agent's hooks or extensions into the contract | Muster alone |
| **The pull fallback** | The agent runs a command and reads the answer | Any agent with a shell |

**Agent-specific code lives in adapters and nowhere else.** No two agents offer
the same way to be told something while idle, so there is no generic wake to
write against. Muster's core, its triggers, its sessions and its inbox name no
agent.

### The contract

**An event in** says that an agent stopped working. An adapter hands it to
`muster hook` as these fields, and muster passes them to the trigger's command
in its environment:

| Field | Value |
|---|---|
| `MUSTER_EVENT` | `settled`: the agent ended its turn and is waiting for input. `finished`: a subagent ended its work and takes no further input. |
| `MUSTER_AGENT` | The adapter's name, such as `claude-code` or `pi` |
| `MUSTER_SESSION` | The agent's own identifier for the session or subagent |
| `MUSTER_PARENT` | On a `finished` event, the identifier of the session that dispatched the subagent. That session is alive, and is the one muster wakes for it. Absent on `settled`. |
| `MUSTER_CWD` | The working directory the agent was in |
| `MUSTER_ROOT` | The root, as every muster command takes it |
| `MUSTER_WAKE` | How this adapter can wake the session: `push`, `waiter` or `none`, as below |

The agent's own payload goes no further than its adapter.

**A wake out** delivers one message, in the envelope under § 7, to the agent an
address belongs to. The text the agent is shown is the same for every adapter:

```
squiz-reviewer-41 sent threads-open: pr=41 head=3f9c2e0 round=2 threads=PRRT_kwDOL7tYbc5abcd1,PRRT_kwDOL7tYbc5abcd2 next=squiz review 41
```

### Adapters

An adapter lives in `adapters/<name>/` and `internal/adapters/<name>/`, as § 9 lays out, and provides four things:

| | |
|---|---|
| **Registration** | The files that make the agent call muster: a hooks file, an extension, or a plugin manifest. `muster install <name>` puts them in place for a project. A program built on muster calls it from its own install, as squiz's `squiz init` does, and a user may also run it directly. Run again, it checks and changes nothing already in place. |
| **Events** | Which of the agent's own events become `settled` and `finished`, and how its payload becomes the contract's fields, the parent of a subagent included. |
| **Wake** | One of three kinds, declared up front. **push:** something of the agent's own, such as an extension or a socket, takes a message from outside while the agent is idle. **waiter:** a hook the agent runs after its turn may wait, and hand a message back as the agent's next instruction. **none:** the agent is reached only by the pull fallback. |
| **Limits** | What its wake cannot do, such as reach a subagent that has already handed back. Each adapter's row below states them. |

**Adding an agent is adding its two directories, and a row to the table
below.** Nothing in muster's core changes, and nothing in a program that
uses muster changes, because both see only the contract.

**Typing into an agent's terminal is never a wake.** Typed text arrives as
keystrokes in an interface written for a person. The agent's own editor can
split or reorder it, and nothing tells it apart from what a person typed. No
adapter uses it.

### The pull fallback

**Any agent that can run a shell command takes part without an adapter.** Its
instructions tell it to run the command that does the work, and to read what
that prints. For squiz that is `squiz review <n>`, which starts the review and
waits for it. For anything else built on muster it is
`muster wait --inbox <address> [--timeout <seconds>]`, which waits for the next
message on an address, takes it, and prints the text above.

This is the baseline every agent gets. An adapter only makes it faster. It
fires the trigger without the agent having to remember, and it wakes an agent
that is idle rather than one that is waiting. Nothing a program built on muster
relies on may need more than the fallback.

### What each agent offers

| Agent | Events in | Wake out | Established |
|---|---|---|---|
| **Claude Code** (`claude-code`) | `Stop` becomes `settled`. `SubagentStop` becomes `finished`, with `MUSTER_SESSION` from the payload's `agent_id` and `MUSTER_PARENT` from its `session_id`, which is the session that dispatched the subagent. | **waiter:** `muster hook`, registered on `Stop` with `asyncRewake: true`, waits on the addresses bound to its session, then writes the text to stderr and exits 2. **push:** `muster hook` records the session's `CLAUDE_CODE_MESSAGING_SOCKET` against those addresses, and `muster send` posts to it. A subagent itself gets no wake: in auto mode it has handed back before `SubagentStop` runs. Its parent is woken instead. | `session_id` as the dispatching session: measured on 2.1.261. Both wakes are documented. Neither is measured by this project. Spike S3. |
| **`pi`** (`pi`) | Muster's extension turns `agent_settled` into `settled`. | **push:** the extension watches the addresses its trigger named, takes a message, and calls `pi.sendUserMessage(text, { deliverAs: "followUp" })`. | Yes. firstmate's `pi` watcher wakes its first mate this way. |
| **GitHub Copilot CLI** (`copilot`) | Its `agentStop` and `subagentStop` hooks, configured in `.github/hooks/`, would become `settled` and `finished`. Whether `subagentStop`'s `sessionId` names the parent session is not documented, and is spike S9. | **Unknown.** `agentStop` can answer `decision: "block"` with a `reason` that becomes the next turn, so a waiter is possible in shape. But a hook times out after `timeoutSec`, 30 seconds by default with no documented maximum, a timeout lets the agent stop, and the CLI ends the turn after eight consecutive blocks. The documentation read names no way to reach an idle session from outside. Until spike S9 settles it, Copilot's wake is **none**, and it takes part through the pull fallback. | Events: documented, not tried. Wake: unknown. |
| **Herdr** (`herdr`) | A Herdr plugin's `[[events]] on = "pane.agent_status_changed"` becomes `settled` when the status is `done`. It is an extra source for an agent in a Herdr pane, never the only one. It sees panes rather than tasks, so a subagent finishing never fires it, and for Claude Code Herdr reads the status from the screen. Its `done` means idle and not yet seen, which a turn that ended on a question also is. | **none.** Herdr's own `agent prompt` types into the pane. | Documented, not tried. |
| **Any other agent with a shell** | None. | **none.** | The pull fallback. |

## 5. Triggers

### What it runs

`.muster.json`, at the root, names a command for each event in the contract:

```json
{
  "triggers": [
    { "on": ["settled", "finished"], "run": ["squiz", "hook"] }
  ]
}
```

The command runs in `MUSTER_CWD`, with the contract's fields in its environment
and nothing on its standard input.

**A trigger's command may name the addresses a session should be woken
from.** Each line of its standard output of the form `watch <address>` binds one
address to a session that is alive:

- **On `settled`**, to the session that settled.
- **On `finished`**, to the parent in `MUSTER_PARENT`, because the subagent has
  ended.

Where that session's adapter wakes with `push` or `waiter`, muster wakes it when a
message arrives on a bound address. A command that prints no `watch` line asks
for no wake.

A command's exit status is reported on `muster hook`'s stderr where it is not 0,
and never changes the hook's own exit status.

### A turn ending is not work being done

An agent settles whenever a turn ends, including a turn that ended on a
question. Muster fires on every one. Deciding whether a turn finished anything
is the command's job.

## 6. Sessions

### Starting one

```
muster start --name <name> --cwd <dir> [--backend herdr|tmux|detached] [--kind <agent>] [--env KEY=VALUE]... [--keep-pane] -- <command> [args...]
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
the log path, and whether the session is alive, exited or stopped. Every
backend has a log at `.muster/sessions/<name>.log`. A pid with its start time is the
identity: a pid alone is reused.

A name is unique within a root. Starting a session whose name has a live record
fails, and names the live one. A record marked exited or stopped under that name
is replaced.

### When its program exits

**A session's pane closes when its program exits, and its record stays.** The
record is marked exited, with the time and, where the backend reports it, the
exit status. `muster status` and `muster read` answer for it from the record and
the log until `muster prune` removes it. `muster start --keep-pane` leaves the
pane open instead, for a person to read.

Whether the pane closes is muster's to decide. What a program wants a person to
see after its pane is gone, such as how to resume it, is the program's to write
somewhere that outlasts the pane.

| Backend | What happens on exit | What muster does |
|---|---|---|
| tmux | tmux closes the window when its command exits, unless `remain-on-exit` is set. | Muster sets `remain-on-exit on` on its own windows, and a `pane-died` hook that runs `muster closed <name>`. That command writes the pane's last screen to the session's log, records `#{pane_dead_status}` as the exit status, and kills the window. The tmux server runs the hook, so nothing of muster's has to be running. Whether the hook fires reliably is part of spike S4. |
| Herdr | After `herdr agent start`, Herdr's documentation says the pane returns to its idle shell prompt once the agent exits, and clears the agent's name. The pane stays open. This is read from the documentation, not observed, and is part of spike S4. | Muster closes the pane once it sees the agent gone, in `muster wait` and in `muster status`. Before closing it, it writes `herdr pane read --source recent` to the session's log. No exit status is recorded, because Herdr reports none. |
| Detached | There is no pane. | The log already holds the output. The exit is seen as the pid gone, and no exit status is recorded, because the session is not muster's child. |

A program whose outcome matters writes the outcome itself, because two of the
three backends cannot report an exit status.

### Watching one

| Command | Herdr | tmux | Detached |
|---|---|---|---|
| `muster status` | Every record: alive, exited or stopped, and for a live agent Herdr's `agent_status` | Every record: alive, exited or stopped | Every record: alive, exited or stopped |
| `muster attach <name>` | Focuses the tab | Selects the window | Follows the log |
| `muster wait <name>` | `herdr agent wait`, then until the agent is gone from the pane | Until the record is marked exited | Until the pid exits |
| `muster read <name>` | `herdr pane read --source recent` while alive, and the log after | `tmux capture-pane -p` while alive, and the log after | The log's tail |

### Stopping one

`muster stop <name>` stops the session and marks its record stopped.

| Backend | What it sends |
|---|---|
| Herdr | `herdr pane close`. Herdr sends `SIGHUP`, then `SIGTERM`, then `SIGKILL`, 250 ms apart, to every process in the pane shell's process session. |
| tmux | `tmux kill-window`. What reaches the window's processes is spike S4. |
| Detached | `SIGTERM` to the session's process group, where the pid and its start time still match the record, then `SIGKILL` after five seconds to what is left. |

**A process that left the session's process session is not stopped.** A tool
that starts its children in sessions of their own has to stop them itself.
Muster says so rather than hunting for them.

**A record goes only with `muster prune`**, which removes every record marked
exited or stopped, and every record whose process has gone by pid and start
time.

## 7. Messages

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

A message on an address bound to a session reaches that session through its
adapter, as § 4 sets out, or waits for the agent to pull it. A waiter watches
every address bound to its session, including one bound after it started, so a
parent whose subagent finishes while the parent waits is still woken.

**One waiter per session delivers.** An agent may run its hooks once per turn
without deduplicating them, so a session that ends three turns has three
waiters. Each records the turn it was started for, and a waiter whose session
has ended a later turn exits 0 without taking anything. Only the newest takes a
message.

## 8. Commands

| Command | What it does |
|---|---|
| `muster hook` | The trigger entry point every adapter calls. § 4 and § 5. |
| `muster install <adapter>` | Puts an adapter's registration in place for a project. A program's own install calls it, as `squiz init` does, and a user may run it directly. § 4. |
| `muster start`, `status`, `attach`, `wait`, `read`, `stop`, `prune` | § 6. `muster wait --inbox` is the pull fallback, § 4. |
| `muster closed` | Run by tmux's `pane-died` hook, never by a person. § 6. |
| `muster send`, `muster inbox list`, `muster inbox take` | § 7. |

Every command takes `--root <dir>`, which defaults to the git toplevel of the
working directory. Every command prints JSON with `--json`.

## 9. The project

### Language

**Muster's core is Go.** It builds to one static binary per platform.

- **Nothing to install first.** Muster runs beside agents whose users may not
  have Node: Claude Code ships as a native binary, and Codex is written in Rust.
- **Millisecond startup.** Muster runs on every stop of every agent it serves.
- **Direct process control.** `Setsid`, process groups and the double fork that
  lets a session outlive its trigger are calls Go makes directly.
- **Goroutines for waiters.** A waiter that watches several addresses, with a
  poll behind each watch, is a few goroutines.
- **Tools of its kind are Go or Rust.** claude-squad and agent-deck are Go, and
  Herdr is Rust.

### Alternatives considered

| Language | Why not |
|---|---|
| Rust | Slower to build with, and nothing this job needs that Go lacks. |
| TypeScript | It needs Node on every machine muster runs on, and Node has no `fork()`, which the detached backend's double fork needs. |

### Layout

```
muster/
  go.mod                      module github.com/jacygao/muster
  cmd/muster/main.go          the binary, one subcommand each
  internal/
    contract/                 the event fields, the wake kinds, and the text an agent is shown
    triggers/                 .muster.json, running the configured commands, the waiter
    sessions/                 the record, and one backend each for Herdr, tmux and detached
    inbox/                    the envelope, send, take, and the watch with a poll behind it
    adapters/                 one package per agent: reading its payload into the contract, and its wake
  adapters/                   each agent's registration, in that agent's own form
    claude-code/hooks.json    the Stop and SubagentStop hooks, which call muster hook --agent claude-code
    copilot/hooks.json        the agentStop and subagentStop hooks, once spike S9 says they work
    pi/extension.ts           a small TypeScript extension: agent_settled calls muster hook --agent pi, and the push wake
    herdr/                    the plugin manifest, whose command calls muster hook --agent herdr
  docs/specs/                 this document
```

**An adapter has two halves, and both are its own.** The registration under
`adapters/<name>/` is written in whatever form the agent loads: a hooks file for
Claude Code and Copilot, a TypeScript extension for `pi`, a plugin manifest for
Herdr. Each one calls the `muster` binary. The Go package under
`internal/adapters/<name>/` reads that agent's payload into the contract, and
carries its wake. No other package names an agent.

The module path is `github.com/jacygao/muster` from the first commit, so the
move out of squiz's repository renames nothing.

### Living inside squiz, then moving out

**Muster is built inside squiz's repository, and moves out before squiz runs on
it.** The move keeps muster's history, with
`git filter-repo --subdirectory-filter muster` or `git subtree split --prefix muster`.
From then on squiz uses muster as an external tool, installed like `gh` or `pi`.

While it is inside:

- **It has its own CI job**, which runs `go build ./...`, `go test ./...` and
  `go vet ./...` in `muster/`.
- **Squiz's TypeScript checks leave `muster/` out.** `tsc` and squiz's tests do
  not read it.
- **Squiz's plugin manifest registers the Claude Code adapter's hooks.** That is
  packaging, not an import.

## 10. Open questions and spikes

Cheapest first. Each result is written as a finding.

| | Question | Spike |
|---|---|---|
| S1 | Does a tmux window, or a Herdr tab started with `herdr agent start`, created from inside a Claude Code shell call or hook outlive the runtime stopping that call? Does a detached session whose output goes to a log file escape as the measured one with `/dev/null` did? | Rerun the detach probe with each backend as the child. Minutes. |
| S3 | Which wake reaches an idle interactive Claude Code session ten minutes after its turn ended: an `asyncRewake` exit 2, a post to `CLAUDE_CODE_MESSAGING_SOCKET`, or both? In auto mode and outside it? Is an `asyncRewake` hook's exit 2 dropped once it reaches its timeout? Does a `SubagentStop` hook's environment carry the parent session's `CLAUDE_CODE_MESSAGING_SOCKET`, so a subagent's work can push to its parent? | A probe in an interactive session in tmux, since a `-p` session exits at turn end. An hour. |
| S4 | Which processes do Herdr's pane close and tmux's `kill-window` reach? After `herdr agent start`, does the pane return to its shell when the agent exits, as the documentation says? Does tmux's `pane-died` hook fire on every exit, with `remain-on-exit` on, and give the exit status? | A pane whose command starts children in its own group and in a session of their own, each logging the signals it gets, then exits with a known status. An hour. |
| S9 | What does GitHub Copilot CLI offer an adapter? Do its `agentStop` and `subagentStop` hooks fire as documented? What is the largest `timeoutSec` it honours, and does an `agentStop` hook that waits that long and then answers `block` wake the session with its `reason`? Is there any way to reach an idle session from outside, such as its asynchronous `notification` hook, which the documentation lists for the CLI without saying what fires it? Does `subagentStop`'s `sessionId` name the parent session? Which layer does it land in? | Read the hooks reference against an installed CLI, then a probe hook in an interactive session. An hour. |
| S6 | Does `herdr agent start --kind pi` track a `pi` that runs with `--no-extensions`, so that Herdr's own `pi` extension does not load? What status does Herdr show for it? | A Herdr tab. An hour. |

Not established, and not designed around:

- **Linux.** The detach probe ran on macOS alone.
- **A Herdr server that is not running.** The Herdr backend is chosen only from
  inside Herdr, where its server is running. What `herdr tab create` does
  otherwise was not read.
- **Whether a Herdr `settled` event and a Claude Code `settled` event for one
  turn can be told apart.** Both fire for a Claude Code session in a Herdr pane. The command they
  run must treat a second firing for the same state as nothing, which squiz's
  one review per state already does.

## 11. What it rests on

| Source | Version read | What this document uses |
|---|---|---|
| Claude Code | 2.1.288, and the docs at code.claude.com/docs/en/hooks and /cross-session-messaging | `Stop`, `SubagentStop`, `asyncRewake`, `CLAUDE_CODE_MESSAGING_SOCKET`. The kill of a command's tree and group, measured on 2.1.288. |
| `pi` | `earendil-works/pi` at `a276dab` (1.0.0), and 0.85.1 | `agent_settled`, `sendUserMessage` with `deliverAs`. Extensions load in every mode. |
| Herdr | `herdrdev/herdr` at `5da0a01` (0.9.3) | Plugin events on `pane.agent_status_changed`. `tab create`, `agent start`, `agent wait`, `pane run`, `pane read`, `pane close`, and what a pane close signals. Pre-1.0, with breaking changes in minor and patch releases. |
| GitHub Copilot CLI | docs.github.com/en/copilot/reference/hooks-configuration and /how-tos/copilot-cli/customize-copilot/use-hooks, read 2026-10-04. Not installed or run | `agentStop`, `subagentStop`, their `decision` and `reason`, `timeoutSec` defaulting to 30, timeouts failing open, the guard of eight consecutive blocks, and hooks in `.github/hooks/`. |
| firstmate | `kunchenguid/firstmate` at `1f3e769` | The inbox format, and the move into `handled/` as the acknowledgement. |
