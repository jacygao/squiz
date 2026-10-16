# 4. The reviewer

The reviewer is a second agent that reads the code the coding agent has just
written and reports what is wrong with it. It has no GitHub access of its own:
it reports each finding as it confirms it, and the harness turns each one into a
comment on the pull request.

## Invocation

The reviewer is a session the round host starts once per round, as The reviewer
session sets out. It reports its findings as it makes them, and a cost where its
CLI reports one. It never edits the code it is reviewing, and it holds no state
between rounds: each round is a fresh session, and everything it knows about
earlier rounds arrives in what it is handed.

Five things are handed to it:

| | |
|---|---|
| **A working directory** | A snapshot of the pull request's head commit, in a clone of its own (The snapshot, below). The reviewer runs with this as its current directory. |
| **The pull request** | Its number, its base and head refs, its description, and the threads the reviewer opened on it, each with its replies and whether it is resolved. The harness fetches all of this and passes it in. |
| **A charter** | The standing instructions describing what a good review is. It ships with the harness and is the same every round. |
| **A thinking level** | How hard the reviewer thinks. The harness sets it every round, so the level never comes from the reviewer CLI's own configuration. The levels are listed under [Configuration](adoption.md#configuration). |
| **A model** | The model the project configured, in the reviewer CLI's own spelling, or none, which leaves the CLI on the user's default. |

The tools it may call are the same every round, as Tools below sets out.

**The prompt tells the reviewer what the history tools are for.** Every prompt
carries this section between the description and the diff:

```markdown
## History

Call `git_log_search`, `git_blame` and `git_show` to find out whether a line was meant: which commit wrote it, and what that commit said it was for.
```

**There is no file-selection or budgeting stage.** The reviewer decides what to
open, one read at a time.

## The reviewer session

**Each round's reviewer runs as a session of its own, where a person can watch
it.** The round host starts it in the first place that applies:

| Where | How the round host starts it |
|---|---|
| Herdr, where `HERDR_SOCKET_PATH` is set | `herdr tab create --cwd <snapshot> --label squiz-41-r2 --no-focus --workspace <id>` gives a pane, in the workspace the state's record names, and in the focused workspace where it names none, and `herdr pane run <pane> '<gated command line>'` types the reviewer's line into the pane's shell once the shell is at its prompt |
| tmux, where `TMUX` is set | `tmux new-window -d -n squiz-41-r2 -c <snapshot> '<command line>'` |
| Neither | As a child of the round host, with no terminal |

The command line is the one the adapter built: `pi`'s, or the Copilot adapter's
shell line, which starts Copilot. Below, "the reviewer" is that command.

**In Herdr, the start returns once the reviewer is running, and the round's
bound is all that limits the review.** `herdr pane run` types a line and returns
at once. The line is the reviewer's behind a gate, each word single-quoted:

```
'/bin/sh' '-c' '<gate>' '/tmp/squiz-gate-Xa81Qe' '400' 'pi' '--session-dir' …
```

**No line over 512 bytes is typed.** A new pane's shell may not have started its
line editor when the line arrives, and macOS then keeps only 1024 bytes of it. A
line cut inside a quoted word runs nothing. A gated line over 512 bytes is
written to a file named `line` in the gate directory before the tab is created,
and the line typed runs that file:

```
'/bin/sh' '/tmp/squiz-gate-Xa81Qe/line'
```

The file removes itself and then execs the gated line, so the gate's pid is
still the typed command's. Copilot's line is about 1.7 KB, and `pi`'s is about
900 bytes from a worktree, so both run from the file. tmux types nothing: the
command line is `new-window`'s own argument.

The gate writes its pid into the gate directory, waits for a `go` file there,
and then becomes the reviewer with the same pid, group and start time. The
round host reads the pid and the reviewer's group while the gate is shut, and
only then writes `go`. So a reviewer that finishes within a second of starting is
still a review that started, and a start that fails never lets the reviewer run.
A gate left waiting gives up on its own after four times the bound on each
program the start runs, without running the reviewer. Where the reviewer's
command is not on the shell's path, the gate says so and the start fails at
once. Where the reviewer has not started 15 seconds after the line was typed,
the start fails.

**A pane's shell reads the line as typed**, so a control character in an
argument would be a key: a newline would end the line, and a tab would complete.
The round host checks the arguments before it creates the tab, and treats such a
command as a pane Herdr refused: nothing opens, and it goes on to tmux or a
child. Neither adapter's line carries one unless a path in it does.

**The variables the round sets reach the reviewer on every backend, over any
value the pane's shell gives them.** They are the adapter's, and the GitHub
variables under Tools, which come last so that no adapter can undo them. A
child is started with them in its environment. A pane starts its shell with the server's environment rather than
the round host's, so they are passed with Herdr's `--env` and tmux's `-e`. The
shell then runs the person's startup files, which can set any of them again: zsh
reads `.zshenv` even for `-c`. So the line typed into a Herdr pane, and the
command of a tmux window, set each variable once more, as `env` arguments in
front of the gate or the reviewer:

```
'/usr/bin/env' 'SQUIZ_REPORTS=…' 'GH_TOKEN=' 'GH_CONFIG_DIR=…' … '/bin/sh' '-c' '<gate>' …
```

`env` sets them and then becomes the gate or the reviewer, so the pid, group and
start time the round reads are still the reviewer's.

**The pane closes when the review ends, and the session stays resumable.** tmux
closes a window when its command exits. Herdr returns the pane to its shell when
`pi` exits, and the round host then closes it with `herdr pane close`. Each
round's `pi` writes its session to `.squiz/<number>/rounds/<k>/session/`, and the
round host writes the command that resumes it to `rounds/<k>/resume.txt`:

```
pi --session-dir .squiz/41/rounds/2/session --session 0193f2c4-7d1e-7b52-9c1a-5e2f4d8a6b31
```

`squiz status` prints it on the round's line. A person runs it from the coding
agent's worktree, which the paths are relative to. The session ran in the
snapshot, which is gone once the round ends, so `pi` does not resume it in place.
It asks to fork the session into the current directory:

```
Fork this session into current directory? [y/N]
```

Answering yes opens the reviewer's conversation in the worktree, with everything
the reviewer read and said. A conversation resumed after the round is not part
of the review. Copilot's resume line is under [The Copilot adapter](adapters.md#the-copilot-adapter).

**What a person types into a `pi` reviewer's pane reaches `pi`.** It can steer
the review, and nothing records it. A Copilot reviewer's pane can be watched and
takes no input.

**The round host stops a reviewer in a pane the way it stops one it started
itself.** At the time bound it signals the reviewer's process group, and then it
closes the pane. It reads the reviewer's group from the backend while `pi` runs:

| Backend | Where the reviewer's group comes from |
|---|---|
| tmux | `tmux display -p -t <pane> '#{pane_pid}'`. The window's command is the one the adapter built, `pi` or the `sh` of the Copilot adapter's line, so this is that command's own pid and leads its group. |
| Herdr | The pid the gate wrote, confirmed as `foreground_process_group_id` from `herdr pane process-info`, before and after its identity is read. Its `shell_pid` is the pane's shell, whose group does not hold the reviewer. |

A pane close is not relied on to stop anything. tmux's `kill-window` sends one
`SIGHUP` to the window's command and nothing more, so a command that ignores it
runs on with the window gone. Herdr's `pane close` sends `SIGHUP`, then `SIGTERM`,
then `SIGKILL`, to every process in the pane's shell session. Neither reaches a
process in a session of its own.

## The snapshot

**Every reviewer reads its own snapshot of the head commit.** The coding agent
may be editing its worktree while a round runs, so the reviewer never reads that
worktree. Before the reviewer starts, the round host clones the
repository into the system's temporary directory and checks out the head commit
of the state under review, detached:

```
git clone --quiet --shared --no-checkout --config remote.origin.pushurl=/dev/null /work/squiz/.git /var/folders/x7/T/squiz-501/5e1f0c2a9b3d7e64-41/rounds/2/tree
git -c core.hooksPath=/dev/null checkout --quiet --detach 3f9c2e07b1d4a8c6e5f0923b7a1d6c4e8b2f5a90
```

The source is the repository's shared git directory, which
`git rev-parse --git-common-dir` names from the coding agent's worktree. The
commit is the one GitHub reports as the pull request's head. Where the
repository does not have it yet, because it was pushed from elsewhere, the round
host fetches it into the repository first, writing no ref and no `FETCH_HEAD`.
The fetch, the clone and the checkout run in the part of the round before the
review, under its 30 seconds ([§ 7 The review budget](failure-modes.md#the-review-budget)).

**The snapshot borrows the repository's objects and shares nothing else.**
`--shared` writes the repository's object directory into the clone's
`objects/info/alternates`, so the clone reads every object the repository has,
without copying one. That includes a head commit the fetch brought, which no ref
points to. The clone's history is the repository's, so `git log`, `git blame`
and `git show` in the snapshot answer as they would in a worktree at the same
commit. Everything else is the clone's own, so the repository's config, hooks
and refs never reach the history tools (Tools):

| The clone's own | What it keeps away |
|---|---|
| Config, `.git/config` | The repository's local config. A diff driver, a `gpg.program` or a `core.fsmonitor` set there is not in the snapshot for a history tool's `git` to read. |
| Hooks, `.git/hooks/` | The repository's hooks, which never run in the snapshot. |
| Refs: branches, tags, `HEAD` | The repository's refs as they move. The snapshot's `HEAD` stays at the commit under review whatever the coding agent's worktree checks out meanwhile. |
| `origin`, which names the repository | The repository itself: its push URL is `/dev/null`, so a push to `origin` fails. |

The clone's refs start as a copy of the repository's branches, under
`refs/remotes/origin/`, and its tags. A branch name given to `git_show` resolves
against those, so it can name a different commit than it would in the coding
agent's worktree. A full commit name or a revision from `HEAD` resolves alike in
both.

The repository's local config reaches the checkout no more than it reaches a
fresh clone's, so a filter or a `core.autocrlf` set there and not in the user's
own config is not applied when the snapshot is checked out.

**The path is `<temporary directory>/squiz-<uid>/<digest>-<number>/rounds/<k>/tree`:**

| Component | What it is |
|---|---|
| `<temporary directory>` | `TMPDIR`, or the system's default where it is unset |
| `squiz-<uid>` | One directory per user, which the round host makes readable and writable by that user alone |
| `<digest>-<number>` | The first 16 hex digits of the SHA-256 of the coding agent's worktree path, and the pull request's number |
| `rounds/<k>/tree` | The round's number within the episode |

Two worktrees reviewing pull requests with the same number never share a path,
and neither do two rounds of one episode. The same worktree, number and round
always give the same path.

**No component the harness adds to the path begins with a dot**, wherever the
coding agent's worktree is. A `TMPDIR` whose own path has such a component is
the user's, and the harness does not change it.

**The round host refuses to make a snapshot where `squiz-<uid>` is not the
user's alone**: a link, a directory another user owns, or one that a group or
other users can write. The temporary directory may be shared, as `/tmp` is, and
another user could make that path first. The round fails before the review, as
any snapshot that cannot be made does.

**The snapshot holds the commit and nothing else.** It carries none of the coding
agent's uncommitted changes, which no state names, and none of its untracked
files, build output or installed dependencies. It is not a worktree of the
repository, so it shows in neither the coding agent's `git status` nor
`git worktree list`.

**The round host removes the snapshot once the round has recorded its result**,
by deleting its directory, whatever the round became. It deletes only a path of
the form above, inside `squiz-<uid>`. It then removes `rounds/<k>/`, `rounds/`
and `<digest>-<number>/` where each is empty. Removal grows with every file in
the snapshot, so it runs after the result rather than before it, and delays nothing a waiting `squiz review`
returns. It takes no part of the round's deadline. The round host takes the next
queued state once it is done. Nothing in the repository refers to the snapshot,
so removing it needs nothing from the repository, and works the same where the
coding agent's worktree has gone.

**A snapshot that cannot be removed stays on disk, and the round's result
stands.** The round host writes a line in `host.log` giving the snapshot's path
and why it could not be deleted. Deleting that directory is how a person gets the
disk back:

```
2026-10-07T04:10:09.623Z round 1: the snapshot at /tmp/squiz-501/44df482132d16163-142/rounds/1/tree could not be removed: EACCES: permission denied, unlink '/tmp/squiz-501/44df482132d16163-142/rounds/1/tree/stuck/left'; it stays on disk until it is deleted
```

**A snapshot a killed round left behind is removed by the recovery that finds
it**, once its reviewer is confirmed gone. The reviewing record names it once the
reviewer has started. Before then, the record's round number gives the same path.

**What it costs:**

- **Time and disk on every round.** Checking out every tracked file grows with
  the size of the repository, not the size of the change. The clone itself, with
  no objects of its own, takes a few hundredths of a second. The disk held at
  once is the checkout's size times the reviews running at once, and it is held
  on the temporary directory's filesystem. Where that filesystem is in memory, as
  `/tmp` is on some Linux systems, so is the snapshot.
- **A snapshot nothing removes stays until the system clears its temporary
  directory, or a person deletes it.** That is a snapshot whose round host was
  killed and which no later trigger or round host for the same episode finds, or
  one its round could not remove.
- **A snapshot that loses its objects if the repository's are pruned.** The
  clone reads the repository's objects in place. A `git gc`, automatic or not,
  keeps an object no ref reaches for two weeks by default, so a head commit the
  fetch brought survives one that runs while the round does. A
  `git gc --prune=now`, a `git prune`, or a `gc.pruneExpire` of `now` deletes it
  at once, and the snapshot then cannot read its own `HEAD`, so the history
  tools fail. The round does not guard against that.
- **A limit on very large repositories.** The checkout runs inside the 30
  seconds before the review, so a repository large enough that it spends them
  cannot be reviewed. A snapshot per round does not scale to such repositories,
  and the first version accepts that.

## Tools

**Every reviewer is granted the same tools, every round.** No setting changes
the grant. It holds three kinds of tool, under each adapter's own names:

| | `pi` | Copilot |
|---|---|---|
| Reading | `read`, `grep`, `find`, `ls` | `view`, `grep`, `glob` |
| Reporting | `report_finding`, `report_verdict`, `finish_review` | `squiz-report_finding`, `squiz-report_verdict`, `squiz-finish_review` |
| History | `git_log_search`, `git_blame`, `git_show` | `squiz-git_log_search`, `squiz-git_blame`, `squiz-git_show` |

The reading tools answer anything the code can be read for. The history tools
answer whether a line was meant: which commit wrote it, and what that commit
said it was for. The reporting calls are how the reviewer returns what it found,
as Findings sets out, and a reviewer with no way to report returns nothing
whatever it read. Copilot names a call an MCP server serves `<server>-<call>`,
and the server the Copilot adapter ships is `squiz`. Nothing else is granted:
no tool that writes, and no shell (Confinement).

**Each history tool runs one `git` subcommand in the snapshot, and no argument
reaches a shell.** Each runs `git` from an argument list, with the reviewer's
arguments as separate words:

| Tool | Takes | Runs |
|---|---|---|
| `git_log_search` | A term | `git log -S<term> HEAD`: the commits that added or removed the term, newest first, each with its message and the files it changed. The term is matched as literal text. |
| `git_blame` | A file and a line | `git blame -L <line>,<line> HEAD -- <file>`: the commit that last changed that line, with its author and date. |
| `git_show` | A commit | `git show` on the one commit the name resolves to: its author, date, message and change. A range, a tree or a file at a revision is refused. |

**The history tools are hardened against the repository they read.** The
snapshot's tracked files are the code under review's to set, so nothing they
hold may turn an argument into an option, make `git` run a program, or put a
file outside the snapshot into what the reviewer reads:

- **No argument reads as an option.** The term is joined to `-S`, a commit is
  resolved to its full name before `git show` is given it, and a file follows
  `--`. An empty argument, and one holding a NUL, are refused.
- **A file is confined to the snapshot.** `git_blame` refuses an absolute path,
  a `..` path that climbs out, and a path whose links resolve outside the
  snapshot.
- **No setting runs a program.** `log` and `show` take `--no-textconv`,
  `--no-ext-diff` and `--no-show-signature`, and `blame` takes `--no-textconv`
  and `--no-ignore-revs-file`. Every call passes `--no-pager` and
  `--literal-pathspecs`, and sets `core.fsmonitor=false`,
  `core.attributesFile=/dev/null`, `log.showSignature=false` and
  `color.ui=false` on its command line.
- **`git_blame` reads the commit, never the working tree**, so no clean filter
  runs and nothing in the snapshot that differs from `HEAD` is blamed.
- **Nothing in the environment names another repository or another config.**
  `git` runs with every inherited `GIT_` variable dropped, and with
  `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_ATTR_NOSYSTEM=1`,
  `GIT_NO_LAZY_FETCH=1`, `GIT_TERMINAL_PROMPT=0` and `GIT_OPTIONAL_LOCKS=0`.
- **Output is bounded.** A call hands back at most 65,536 bytes of `git`'s
  output, followed by a line saying it was cut there. `git` is stopped after
  120 seconds.

A refused argument and a `git` that failed are the call's error, which the
reviewer reads and can call again with something else.

**The reviewer's environment carries no GitHub token and no `gh` login, for
either adapter.** The round sets four variables empty and points `gh` at a
configuration of its own:

| Variable | Value |
|---|---|
| `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN` | The empty string, which `gh` reads as no token |
| `GH_CONFIG_DIR` | `.squiz/<number>/rounds/<k>/gh/`, which the round empties before the reviewer starts |

They are set empty rather than left out because a pane's shell starts with its
server's environment, and only a value the round sets replaces one the server
has (The reviewer session). Everything the reviewer starts inherits them, so a
`gh` that its CLI or a tool starts finds no login: `gh auth status` says none,
and `gh api` refuses to run.

The credential each CLI needs for its model is left alone: `pi`'s provider key,
such as `DEEPSEEK_API_KEY`, and Copilot's login. Copilot looks for that login in
three places:

- **`COPILOT_GITHUB_TOKEN`, which is left set where the round host has it.** A
  user who signs Copilot in that way has no other model credential. Only a
  made-up token has been tried. With `gh` off `PATH`, Copilot refuses it with
  `Error: Authentication token found but could not be validated.`; with `gh` on
  `PATH`, it falls back to `gh`'s login and answers. A valid token is untested.
- **A login of Copilot's own, from its `/login` command.** Untested: no machine
  Squiz has run on has had one. Where Copilot keeps it, and whether a reviewer
  finds it under the adapter's `COPILOT_HOME` (Keeping the project and the user
  out), are not known.
- **`gh`'s login, which Copilot reads by running `gh auth token`.** Tested on
  macOS. `gh auth token` prints the login `gh` keeps in the keychain whatever
  `GH_CONFIG_DIR` names, and the round passes its `PATH` on unchanged, so a
  reviewer that finds `gh` on that `PATH` signs in under the variables above.
  With `gh` off `PATH` and the token variables empty, Copilot exits 1 at once
  with `Error: No authentication information found.`

A user who signs Copilot in through `GH_TOKEN` or `GITHUB_TOKEN` alone has no
model credential in the round, because the round sets both empty, and nothing
here handles that.

**The system's credential store stays readable.** On macOS any process running
as the user can read the keychain, and `gh auth token` prints `gh`'s login from
it whatever `GH_CONFIG_DIR` names. That command is how Copilot reads `gh`'s
login, so that login cannot be closed to the reviewer without being closed to Copilot.
The operating-system sandbox under [§ 8 What ships](project.md#what-ships) is what would close it.

## Confinement

The reviewer must not change anything the coding agent would commit, and must
not read anything outside the code under review. Four things hold it there. None
is configurable, and each holds for both adapters, every round.

**No tool writes, and none is a shell.** The grant under Tools is everything the
reviewer can call, and it leaves out `edit`, `write` and every shell tool.
Nothing the reviewer can call touches the tree, the reporting calls included:
what a report reaches is the round that is reading the reviewer's output, and
nothing on disk.

**The reading tools read the snapshot and nothing outside it.** A path is inside
where its real path, every link resolved, is inside the snapshot's real path. So
an absolute path elsewhere, a `..` path, and a link in the tree under review
that points out are each refused before anything is read. A finding is posted
publicly on the pull request, so a file the reviewer reads can end up there.
Each adapter confines its tools differently:

| Adapter | What refuses a read outside the snapshot |
|---|---|
| `pi` | The extension's `tool_call` handler, for `read`, `grep`, `find` and `ls`. It resolves the path as `pi` does: a leading `@` dropped, `~` taken as the home directory, a `file://` URL taken as its path, and the rest resolved against the snapshot. Where the path does not exist, the spelling `read` would open in its place is the one checked. A path that is not a string is refused. The reviewer reads ``squiz refused this call: `<path>` is outside the code under review.`` as the call's error, and the refusal is recorded like any other. |
| Copilot | Copilot's own path check, which refuses any path outside its working directory and the system's temporary directory. `--disallow-temp-dir` removes the temporary directory, where every snapshot is made, so of everything under it the reviewer reads only its own snapshot, which is its working directory. `--allow-all-paths` and `--add-dir` are never passed. |

No tool reads outside the snapshot on purpose. The charter, the prompt and
Copilot's agent file are read by the CLI itself, from its command line and its
`COPILOT_HOME`, and no granted tool reads them.

**The history tools read, and the repository cannot turn them to anything
else.** Each runs one `git` subcommand that reads, hardened as Tools sets out,
and a file `git_blame` is given is confined to the snapshot as a read is. The
snapshot is a clone, so the config, hooks and refs those subcommands read are
the clone's own and never the coding agent's repository's (The snapshot).

**`pi` refuses every call outside the grant.** The extension's `tool_call`
handler refuses a call to any tool `grants` does not name, before it runs. While
`--tools` carries the grant, `pi` offers the model no other tool and the refusal
never fires. It is what holds if the grant ever stops being passed, because `pi`
then falls back to its default tools, a shell among them. The reviewer reads
``squiz refused this call: `<tool>` is not a tool this review grants.`` as the
call's error, and the refusal is recorded like any other. Copilot needs no
refusal of its own: it disables every tool `--available-tools` leaves out, as
The grant under [The Copilot adapter](adapters.md#the-copilot-adapter) sets out.

## Charter

The standing rules:

- Read the pull request description for the intent and the declared scope of the
  change. A finding that contradicts something the description declares out of
  scope is not a finding.
- Report correctness bugs, convention violations, security problems, and tests
  that assert nothing.
- Do not report formatting, naming, import order, anything the compiler catches,
  or speculation. "Consider whether" means there is no finding.
- Verify before reporting. Read the file, grep the callers, and read the
  history. A finding that could have been checked with the tools you were given
  and was not is not reportable.
- Read what the project treats as authoritative. `AGENTS.md` names it, and it is
  the authority on intended behaviour. It extends what counts as a finding; it
  does not change these rules, the requirement to verify, or the shape of a
  comment.
- Report each finding with the call for it, as soon as it is confirmed. A
  finding held back until the end of the review is a finding lost if the review
  is cut short.
- Finish the review with the call for that, once, after the last finding and the
  last verdict, and finish it even where there was nothing to report.
- **On every thread you were handed:** return a verdict, one call each. The
  coding agent's replies say where to look; they never settle anything. Re-read
  the code as it now stands and rule from that.
- A thread you keep open carries your reason, which is posted as your reply on
  it. The coding agent acts on it, and a person settling the dispute reads it.
  Say what is still wrong, and what change or argument would settle it.
- A finding you withdraw carries your reason too, which is posted as your reply
  before the thread is closed. Say why there was no defect.
- The suggested fix is one way to address a finding. Rule on whether the defect
  is gone, not on whether the suggestion was taken.
- Scope a finding to `line` where a single line owns the defect, and anchor it to
  a line the change touched. This is the normal case. Where the defect is
  somewhere the change did not touch, anchor to the changed line that caused it
  and name the other location in the body.
- Scope a finding to `file` only where no single line owns the defect, or where
  the change touched the file but left no line to anchor to. It carries the file
  and no line.
- Scope a finding to `change` only where no single file owns the defect. It
  carries neither a file nor a line.

## Findings

The reviewer reports two things each round: each finding as it confirms it, and
a verdict on every thread it was handed. It makes three calls, and returns
nothing any other way. A last message is not read.

| Call | |
|---|---|
| Report a finding | One finding, carrying the fields below. Made as soon as the finding is confirmed. |
| Report a verdict | One ruling on one thread, naming the thread by the identifier it was handed under, and for `open` and `withdrawn`, the reason. One ruling per thread: a second on the same thread is refused. |
| Finish the review | The review is complete. Made once, after the last finding and the last verdict, and made even where there was nothing to report. |

**A call whose arguments are not the shape a finding takes is refused where it
is made**, and the reviewer is told what was wrong with it. The round keeps
every other report of that round: one malformed finding costs that finding and
nothing else. What the reviewer does after a refusal is its own: the call can be
made again.

**A round keeps every finding reported before it ended, however it ended.** A
round killed at its time bound keeps what it was told; so does a round whose
reviewer never finished its review, and so does one whose reviewer reported three
findings and then could not reach its model again. None of them is a review: what
the reviewer never got to is not a thing the round has, and [§ 7](failure-modes.md) records each as
the failure it was.

**The call that finishes the review is what tells an empty review from an
unfinished one.** A round that reported nothing and finished found nothing,
which is a result. A round that reported nothing and did not finish reached the
end of nothing, which is a failure. No count of findings separates the two.

The pull request holds the record, so a finding carries only what composes a
comment and what the harness needs in order to route it:

- `scope` — `line`, `file` or `change`, which decides inline, file-level or
  general.
- `file` and `line` — the changed line the comment is anchored to. A finding
  scoped to a file carries the file alone, and one scoped to the change as a
  whole carries neither.
- `severity` — `high`, `medium`, or `low`.
- `headline` — the problem, named in one line.
- `reasoning` — the bullets beneath the headline, one point each.
- `suggestedFix` — what to do about it.
- `reference` — optional. A quoted convention, or something the reviewer could
  not check.

| Severity | |
|---|---|
| `high` | Wrong now, or a security problem, or it breaks a written convention. |
| `medium` | Wrong under conditions this change makes reachable, or a test that would pass with the code under it deleted. |
| `low` | Real, narrow, and survivable. |

Every finding holds the work whatever its severity. Severity orders the
findings; it does not decide whether they count. The order runs `high` to
`low`, and findings of one severity keep the order the reviewer reported them
in.

Every round hands the reviewer the threads the reviewer itself opened, and it
reports one verdict for each. It rules by reading the code as it now stands.

A thread is the reviewer's own when the comment that opened it carries the
reviewer's marker from [§ 2](dependencies.md). A thread a person replied to is still the reviewer's
own, because the comment that opened it is the finding. The reviewer's resolved
threads go over beside its open ones, because re-opening a thread is a verdict
and a verdict only reaches a thread that was handed over.

The threads are the whole of what the reviewer knows about the rounds before it,
so they go over in every round rather than from the second round on. A pull
request carries the threads of every episode that has run on it, and the first
round of a second episode is handed them. The first round of a first episode is
handed none, because there are none yet.

The closing round is the exception. It is handed only the reviewer's threads that
are not resolved, and a finding it reports is never posted ([§ 3 The round cap](loop.md#the-round-cap)).

A thread a person opened is left alone. It is not handed over, no verdict is
applied to it, and nothing in the loop reads or answers it.

A verdict carries three fields:

- `thread` — the identifier the thread was handed over under, copied back.
- `verdict` — `fixed`, `withdrawn` or `open`.
- `reason` — required on `open` and `withdrawn`, and refused on `fixed`. On
  `open` it is the reviewer's feedback to the coding agent: what is still wrong
  in the code as it now stands, and what change or argument would settle it. On
  `withdrawn` it says why there was no defect. A verdict of `open` or
  `withdrawn` with no reason, or with one that is blank, is refused. The shared
  report checks hold this rule, so both reviewers' calls refuse alike.

```json
{
  "thread": "PRRT_kwDOL7tYbc5abcd2",
  "verdict": "open",
  "reason": "`isExpired()` still compares against the local clock with no margin: `clock.ts:12` allows for skew in `now()`, which this path does not call. Call `now()` here, or show where the margin is applied."
}
```

| Verdict | What it means | The harness |
|---|---|---|
| `fixed` | The defect is gone. | Replies on the thread naming the round and the commit, then closes it |
| `withdrawn` | There was no defect. The coding agent's argument was accepted. | Replies on the thread with the reason, then closes it |
| `open` | The defect is still there. | Re-opens the thread, or leaves it open, and replies on it with the reason |

**Every ruling a round gives on a thread is a reply on that thread.** The round
posts the replies in the posting reserve, before the round ends. Each opens with
the reviewer's marker and the verdict, so it is read as the reviewer's own and is
never activity that starts another round. A thread the reviewer keeps open gets
its reason every round it keeps it open, after the thread is put in its state:

```markdown
**Squiz reviewer · still open**

`isExpired()` still compares against the local clock with no margin: `clock.ts:12` allows for skew in `now()`, which this path does not call. Call `now()` here, or show where the margin is applied.
```

A thread the round closes gets its reply before it is resolved. The reply names
the round and the short commit the round reviewed, and a withdrawal carries the
reviewer's reason beneath. The closing round's replies name it as "the closing
round", as `Confirmed in the closing round at 9e01b2c.`:

```markdown
**Squiz reviewer · fixed**

Confirmed in round 2 at 1b86987.
```

```markdown
**Squiz reviewer · withdrawn**

Withdrawn in round 2 at 1b86987.

The retry count is bounded by the caller: `schedule()` in `queue.ts:40` stops at five attempts.
```

A thread that was already resolved when it was handed over gets no reply from a
`fixed` or `withdrawn` verdict. The round still sends the resolve, because the
mutation's report is its only evidence the thread is closed, but it posts
nothing: the thread is handed over and ruled on again every round, and a reply
each time would repeat itself. An attempt that spends no round, such as a setup
problem that salvaged a verdict, names the commit and no round, as
`Confirmed at 1b86987.`, because the next round takes the number it would have
named.

The next `squiz review` prints the replies with the thread's other comments
([§ 6](commands.md)), which is how the coding agent receives a reason.

**A reply that cannot be posted leaves the verdict standing.** The thread is put
in the state the reviewer ruled either way, and a closing reply that fails does
not stop the resolve after it. The round names the thread and what GitHub
answered on `squiz review`'s stderr, and in `squiz status` where the round
reviewed. Where the reply was a reason on a thread kept open, the summary's
Notes name the thread only where the round closes the episode, because the next
round that keeps it open posts a reason of its own. Where the reply was on a
thread the round closed, nothing posts it later: the round's entry in the state
file keeps the line, the summary that closes the episode names it in Notes
([§ 5](summary.md)), and a round that fails lists it in its failure comment instead.

A thread the reviewer returns no verdict for is treated as `open`, where the
reviewer finished its review, and nothing is posted on it, because the reviewer
gave no reason. Where the review did not finish, such a thread is left in the
state it was handed over in. The reviewer was silent about every thread it never
reached, and the default would read that silence as a ruling on code it had not
read.

Every finding posted as a thread ends its episode in one of four states. The
reviewer names the first two; the harness reads the last two off the thread when
the episode closes. A close that runs no reviewer can also find a resolved thread
with none of them, as [§ 5](summary.md) sets out.

| Status | What it means | Needs a person |
|---|---|---|
| `fixed` | The defect was there and is gone. | No |
| `withdrawn` | There was no defect. | No |
| `open` | Still unresolved at the close of the episode, with no reply from the coding agent. | Yes |
| `disputed` | Still unresolved at the close of the episode, and the coding agent replied. There is a disagreement for a person to settle, and the thread carries both sides of it. | Yes |

## The comment format

Every comment follows one template: the marker and a headline naming the problem
with the severity visible, the reasoning as bullets rather than paragraphs, and
a suggested fix.

```markdown
**Squiz reviewer · high — Card can be placed off-screen once the explanation expands**

- `placeCard()` clamps against `window.innerHeight` before the expand animation
  runs, so a card that grows past the fold keeps its pre-expansion offset.
- Triggers at 150% zoom or above, on an entry with three or more senses.

**Suggested fix:** re-run `placeCard()` from the animation's completion
callback, and clamp against the card's measured height rather than its initial
height.

> `AGENTS.md`: re-run placement whenever the card's height changes.
```

The reference at the end is optional: a quoted convention, or a note about
something the reviewer could not check. Delete it and the comment must still
stand.

## Pull request comments

A finding's `scope` decides where its comment goes. The reviewer sets it,
because it is a judgement about what the finding is about rather than about
where a line falls.

- **Inline**, for a finding scoped to `line`. It becomes a review comment thread
  anchored to a file and a line that the change touched. This is the normal case
  and the preferred one.
- **File**, for a finding scoped to `file`. It is about a file rather than any
  line of it, or about a file the diff carries without a line to anchor to. It
  becomes a review comment thread on the file, carrying no line.
- **General**, for a finding scoped to `change`. It is about the change as a
  whole rather than about any line of it — that the feature duplicates one the
  project already has, or that the approach is wrong. It goes into the summary
  comment.

The reviewer reads beyond the diff by design: untouched files, callers, history.
A finding it makes there is still scoped to `line`, and it is anchored to the
changed line that caused it, with the affected file and line named in the body.
The reviewer does not go looking for the affected line to anchor to, and GitHub
would refuse an anchor outside the diff in any case.

An anchor is one line. A finding about several lines names the one a reader
would point at when explaining the defect, which is where it is visible rather
than where the construct begins or ends. The charter carries that instruction,
since it is a judgement the reviewer makes.

An anchor the harness cannot place is posted on the file instead, with
`file:line` written in the text. Where the diff does not carry the file either,
the finding is reported as general and the summary's Notes records that it could
not be anchored.

A finding scoped to `file` is reported general on the same terms: where the diff
does not carry its file, the finding goes to Notes carrying the file alone. What
the diff carries decides where a comment can hang, and the scope the reviewer
chose does not change that.

A file-scoped comment is a thread. It is resolved, re-opened and ruled on the
way an inline one is, and it carries across rounds.

A general finding is reported once and then forgotten. It is a line of text in
the summary comment rather than a thread, so nothing records whether it was
fixed, and no later round rules on it.
