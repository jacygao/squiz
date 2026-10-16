# 6. Commands

Everything the harness ships to be run is a subcommand of one binary, `squiz`,
run from a shell. Squiz ships no slash command: the setup check is
`squiz doctor`.

## The `squiz` binary

A plugin's `bin/` is added to the Bash tool's `PATH` while the plugin is
enabled, so a coding agent in Claude Code runs the binary by name. A command a
person types after `!` in a Claude Code session gets the same `PATH`, so
`! squiz doctor` and `! squiz init` run by name too. Every other coding agent's
shell, Copilot's included, and a person's terminal outside Claude Code get the
`PATH` they were started with, and run `squiz` by name through the link
`squiz init` makes in a directory already on it.

| Command | Run by | What it does |
|---|---|---|
| `squiz review <number>` | The coding agent, a coordinator, a CI job | Reviews pull request `<number>` once for each head commit and each new reply on the reviewer's threads, waits for the review, and prints what is open. |
| `squiz status` | A person, a coordinator | Lists the reviews running and finished in every worktree of the repository. |
| `squiz init` | A person | Links `squiz` onto `PATH`, for coding agents other than Claude Code. |
| `squiz doctor` | A person | Prints a line per dependency, saying it is present or naming what is missing or unauthenticated, and exits 1 where a required one is not usable (The setup check). |
| `squiz hook` | Claude Code | The `Stop` and `SubagentStop` entry point, named in `hooks.json`. Queues the review of the pull request for the payload's `cwd` and returns, as [§ 3](loop.md) sets out. |
| `squiz host <number>` | A trigger, never a person | The round host ([§ 3](loop.md)). |
| `squiz threads` | The coding agent | Lists the open threads on the pull request for the current branch. Each line carries the thread's identifier, where the thread is, and the severity and headline of the finding on it. |
| `squiz reply <id> <text>` | The coding agent | Replies in a thread. |

```
2 open threads on #185
PRRT_kwDOUEd2qM6mPuUP scratch/paging/pages.ts:26 high — pageCount drops the partial last page
PRRT_kwDOUEd2qM6mPuVO scratch/paging/pages.ts:34 high — pageAt starts every page one page too far
```

A thread whose first comment carries none of [§ 2 Identity](dependencies.md#identity)'s markers was opened by
a person rather than by the reviewer. It is no finding, and its line is the
identifier and the location alone.

`<id>` is whatever `squiz threads` printed for that thread. It round-trips
between the two commands, and is short enough for an agent to copy. It leads the
line and is printed undecorated, so a line splits into the identifier and the
rest of it at the first space.

## `squiz review`

`squiz review <number>` runs from the worktree pull request `<number>`'s branch is
checked out in. It acts on the record for the pull request's state as [§ 3 The
state file](loop.md#the-state-file) sets out, and waits for the review within one deadline for the whole
invocation ([§ 7](failure-modes.md)). The exit status says what the coding agent does next:

| Exit | What it means | What the coding agent does |
|---|---|---|
| 0 | Nothing of this review is open. The episode is closed, and its summary is on the pull request. | Finishes. |
| 2 | Threads are open, and rounds remain. | Works the threads, pushes what it changed and replies, and runs the command again. |
| 3 | The round cap or the token bound closed the episode with threads still open, or its closing round left them open, and they are printed. | Finishes, and says what is open. A person takes it from here. |
| 4 | Still reviewing. The run's deadline came before the review of this state was done, before the review of a state queued behind a clean one, or before the review of the state that superseded this one. The round goes on in the round host. | Runs the command again. |
| Anything else | The review could not run. | Reports the lines on stderr. |

Exit 4 is neither an outcome nor a failure: nothing about the pull request was
decided, and nothing went wrong. Exit 1 is the status for a review that could not
run. Every status outside the table reads the same way as 1, so a command that could not be started, or that
crashed past the harness's own trap, is never read as a result.

**stdout carries the outcome and stderr carries what failed.** A run that exits 0,
2, 3 or 4 prints its outcome on stdout, and [§ 7 The command's stderr](failure-modes.md#the-commands-stderr) sets out what
it adds on stderr. A run that exits 1 prints nothing on stdout.

**The first line names a file holding the whole output, and says to read it
where the output is cut.** A run that exits 0, 2, 3 or 4 writes everything it
prints on stdout to `.squiz/<number>/review.txt`, and prints that path first. The
file is replaced on every run. Claude Code can hand the agent less than the
command printed, as [§ 2](dependencies.md) sets out, so several open threads can be missing from
what the agent sees. The first line is the part every cut keeps.

A file that cannot be written leaves the outcome and its status as they are. The
path line still names it, and stderr adds one line:

```
squiz: the output could not be written to /work/squiz/.squiz/41/review.txt: EACCES: permission denied
```

Each open thread is printed as its `squiz threads` line, followed by the thread's
comments indented by two spaces. The first comment is given without its first
line, which the `squiz threads` line already carries.

Threads open, exit 2:

```
Full output, to read where this is cut short: /work/squiz/.squiz/41/review.txt
Squiz reviewed PR #41 at 3f9c2e0: round 2 of 3, 1 new finding.

2 threads are open:

PRRT_kwDOL7tYbc5abcd1 packages/sync/src/queue.ts:134 high — Retry backoff resets on every enqueue
  - `enqueue()` calls `resetBackoff()` on every call, so a busy queue never backs off.
  - Reachable whenever a retry is pending and a new item arrives.

  **Suggested fix:** reset the backoff only when the queue was empty.

PRRT_kwDOL7tYbc5abcd2 packages/sync/src/session.ts:57 medium — Clock skew is read as token expiry
  - `isExpired()` compares the server's `exp` against the local clock with no margin.

  **Suggested fix:** allow the skew the server documents before reading a token as expired.

  **Squiz coding agent**

  The server bounds skew at two seconds, and `clock.ts:12` already allows for it.

  **Squiz reviewer · still open**

  `isExpired()` still compares against the local clock with no margin: `clock.ts:12` allows for skew in `now()`, which this path does not call. Call `now()` here, or show where the margin is applied.

Fix what applies, and reply on each thread with `squiz reply <id> <text>` to say
what you changed or why you disagree. Commit and push what you changed, then run
`squiz review 41` again.
```

A run handed a result it did not produce says so in the line after the path, and
prints the threads as they stand on the pull request now:

```
Full output, to read where this is cut short: /work/squiz/.squiz/41/review.txt
Squiz already reviewed PR #41 at 3f9c2e0: round 1 of 3, 2 new findings.
```

Nothing open, exit 0:

```
Full output, to read where this is cut short: /work/squiz/.squiz/41/review.txt
Squiz reviewed PR #41 at 8d21a4f: round 2 of 3, no new findings.

Nothing is open. The review is closed, and its summary is on the pull request.
```

Closed with threads open, exit 3:

```
Full output, to read where this is cut short: /work/squiz/.squiz/41/review.txt
Squiz reviewed PR #41 at 77e0f19: round 3 of 3, no new findings.

The round cap is reached. The review is closed with 1 thread open, and its summary
is on the pull request. A person takes it from here, so do not run
`squiz review 41` again.

PRRT_kwDOL7tYbc5abcd2 packages/sync/src/session.ts:57 medium — Clock skew is read as token expiry
  …
```

Where the token bound closed the episode, the second paragraph begins "The token
bound is reached" instead.

The closing round ([§ 3 The round cap](loop.md#the-round-cap)) is named as one, in place of a round's
number, and exits 0 or 3 as any close does. Its heading gives no count of new
findings, because it raises none. Nothing open, exit 0:

```
Full output, to read where this is cut short: /work/squiz/.squiz/41/review.txt
Squiz reviewed PR #41 at 9e01b2c: the closing round, after 3 of 3 rounds.

Nothing is open. The review is closed, and its summary is on the pull request.
```

Threads still open, exit 3:

```
Full output, to read where this is cut short: /work/squiz/.squiz/41/review.txt
Squiz reviewed PR #41 at 9e01b2c: the closing round, after 3 of 3 rounds.

The closing round is done. The review is closed with 1 thread open, and its
summary is on the pull request. A person takes it from here, so do not run
`squiz review 41` again.

PRRT_kwDOL7tYbc5abcd2 packages/sync/src/session.ts:57 medium — Clock skew is read as token expiry
  …
```

A finding the reviewer reported in the closing round is a line on stderr, as
[§ 5](summary.md)'s Notes write it:

```
squiz: the closing round did not post this: `src/cache.ts:12` — The cache is never cleared (reported in the closing round, which raises no findings, so it was not posted)
```

Still reviewing, exit 4. A run whose deadline arrived while its state's round
ran:

```
Full output, to read where this is cut short: /work/squiz/.squiz/41/review.txt
Squiz is still reviewing PR #41 at 3f9c2e0. Run `squiz review 41` again to wait for it.
```

A run whose state is queued behind the round of an older one:

```
Full output, to read where this is cut short: /work/squiz/.squiz/41/review.txt
Squiz is reviewing PR #41 at 3f9c2e0 first, and 8d21a4f is next. Run `squiz review 41` again to wait for it.
```

A run whose own state was reviewed clean while a later one was queued, and whose
wait ran out before the episode closed. Exit 0 and the line about the summary
come only with the close itself:

```
Full output, to read where this is cut short: /work/squiz/.squiz/41/review.txt
Squiz found nothing open in PR #41 at 3f9c2e0, and is reviewing 8d21a4f before it closes the review. Run `squiz review 41` again to wait for it.
```

A run whose own state was superseded before a round took it ([§ 3 The state
file](loop.md#the-state-file)), and whose wait ran out before the newer state's round ended. The newer
state is named as the reason for superseding names it:

```
Full output, to read where this is cut short: /work/squiz/.squiz/41/review.txt
Squiz is reviewing PR #41 at 8d21a4f instead of 3f9c2e0. Run `squiz review 41` again to wait for it.
```

A run on an episode that has already closed, exit 0 or 3 as the close was:

```
Full output, to read where this is cut short: /work/squiz/.squiz/41/review.txt
Squiz's review of PR #41 closed after 2 rounds, with nothing open. No round runs again in this worktree.
```

Where it closed with threads open, exit 3, the line counts them and the threads
follow, each as exit 3 prints it. Where the episode ran its closing round, the
line says "closed after 3 rounds and its closing round":

```
Full output, to read where this is cut short: /work/squiz/.squiz/41/review.txt
Squiz's review of PR #41 closed after 3 rounds, with 2 threads open. No round runs again in this worktree.

PRRT_kwDOL7tYbc5abcd2 packages/sync/src/session.ts:57 medium — Clock skew is read as token expiry
  …
```

The review could not run, exit 1, on stderr. Every exit-1 output ends with the
line that tells the coding agent to stop:

```
squiz: put these lines in your report rather than running squiz review again
```

A round that failed prints the reason its failure comment gives, then where the
comment went:

```
squiz: review failed: the reviewer was stopped at the time bound of 900 seconds, after reporting 2 findings
squiz: the failure is posted on PR #41
squiz: put these lines in your report rather than running squiz review again
```

A round that left threads open and has findings that no thread holds keeps exit
2, and prints each on stderr as [§ 5](summary.md)'s Notes write it, after the line counting
any it could not post:

```
squiz: round 1 could not post 1 of its 3 findings to PR #41
squiz: round 1 raised this on no thread: About the change as a whole: The retry queue duplicates the scheduler
squiz: round 1 raised this on no thread: `src/cache.ts:12` — The cache is never cleared (raised, and its comment could not be posted)
```

A round that could post none of its findings prints the same way as a failed
round:

```
squiz: review failed: round 2 found 3 findings and could not post them to PR #41
squiz: the failure is posted on PR #41
squiz: put these lines in your report rather than running squiz review again
```

A run that failed before any round, or could not reach GitHub, prints one line
saying why, then the line to stop. The lines saying why:

```
squiz: no review ran: PR #41's head is "feature-a", and "/work/squiz" has "main" checked out
squiz: no review ran: PR #41 is closed
squiz: no review ran: whether round host 4242 for PR #41 is still running could not be told: ps did not answer within 2000ms
```

A round host whose start cannot be told started or not is waited on once a live
process holds `.squiz/<number>/host.lock`. Where none holds it within 10 seconds
of the start, or by the run's deadline where that comes first, the run exits 1
with a second line saying where to look:

```
squiz: no review ran: whether the round host for PR #41 started could not be told, and none has taken the review since: the intermediate process exited 1: spawn node ENOENT
squiz: `squiz status 41` shows whether one takes it later, and .squiz/41/host.log holds what the host wrote
squiz: put these lines in your report rather than running squiz review again
```

Every number and every thread in the output is computed from what the round read
back from the pull request, so the coding agent can check each one there.

## `squiz status`

`squiz status` lists every review recorded in any worktree of the repository,
one line per pull request state, newest first. It starts nothing and asks
nothing of GitHub.

```
PR    Commit   Replies  State      Started           Elapsed  Result                                      Session           Worktree                          Resume
#41   9e01b2c  OmQx7a   queued     —                 —        —                                           —                 .claude/worktrees/agent-a5336e10  —
#41   8d21a4f  OmQx7a   reviewing  07:13:05          3m 12s   —                                           tmux squiz-41-r3  .claude/worktrees/agent-a5336e10  —
#41   3f9c2e0  OmQx7a   reviewed   07:06:02          2m 40s   1 thread open                               tmux squiz-41-r2  .claude/worktrees/agent-a5336e10  pi --session-dir .squiz/41/rounds/2/session --session 0193f2c4-7d1e-7b52-9c1a-5e2f4d8a6b31
#38   a1b2c3d  —        failed     2026-10-04 06:40  8m 00s   the reviewer was stopped at the time bound  detached          .claude/worktrees/agent-a077fff7  pi --session-dir .squiz/38/rounds/1/session --session 0193f1a0-2c4b-7e9d-8f3a-1b6c5d7e9f02
```

Each column holds:

- **Replies:** the latest activity the state was read with, as the last six
  characters of its identifier, or `—` for none.
- **State:** the record's state, with two readings of a reviewing record. One
  whose round host has gone, by its pid and start time, is `killed` until a
  recovery records it failed. One whose host cannot be told running or gone is
  `reviewing`, and its Result is "the round host could not be checked:", then
  why. A state the episode closed before reviewing is `not reviewed`.
- **Started:** when the round started, in local time. A round started today
  shows the time of day, and one started on another day shows the date and the
  minute. A reviewing record shows its reviewer's start once the reviewer has
  started, and its round host's start before then.
- **Elapsed:** the time so far for a review that is running, and the time from
  start to end for one that finished. A killed review, and a record that holds
  no round times, show `—`.
- **Result:** for a failed state, the reason its failure comment gives. For a
  state not reviewed, why not. For a reviewed state, how many of the reviewer's
  threads it left open, and "review closed" where it closed the episode. Where
  the round cap or the token bound closed it with threads open, "review closed
  at the round cap" or "at the token bound". The closing round's record says
  "review closed by the closing round". Where GitHub refused some of the
  round's findings, the count follows, as "2 of 5 findings not posted".
- **Session:** the backend and the label of the reviewer's tab or window,
  `squiz-<number>-r<k>` as [§ 4 The reviewer session](reviewer.md#the-reviewer-session) opens it, with `k` the
  round's number its record keeps. A record that keeps no `k` shows the backend
  alone. A detached reviewer is `detached`, and a state with no reviewer
  started is `—`.
- **Worktree:** the worktree's path relative to the main worktree, `.` for the
  main worktree itself.
- **Resume:** the content of the round's `rounds/<k>/resume.txt` once the round
  is over, or `—`.

The order is newest first by what the records carry, because a queued record
carries no time:

1. Episodes with a state queued or under review come first.
2. Then episodes by the latest start or end time any of their records carries.
3. Then by the higher pull request number.

Within an episode, the newest state comes first, in the reverse of the order the
state file keeps them.

Every cell is one line. A line break in a reason, with the whitespace around it,
is printed as one space, so each state keeps its one line.

**A reviewed state's problems follow its line, one line each, indented by two
spaces.** These are what failed without changing the round's outcome, such as a
summary that could not be posted. A failed closing round's line is followed the
same way by each finding it did not post. Each is one line by the same rule as a cell,
and none of them widens a column. A reviewed state with no problems, no
unposted findings and no closing bound prints as the table above shows:

```
PR    Commit   Replies  State     Started           Elapsed  Result                                                                       Session   Worktree                          Resume
#39   77e0f19  —        reviewed  2026-10-04 07:20  4m 05s   1 thread open, review closed at the token bound, 2 of 5 findings not posted  detached  .claude/worktrees/agent-a3c91e07  pi --session-dir .squiz/39/rounds/3/session --session 0193f1b2-4d6e-7a1c-9b3f-2c8d5e7f9a14
  the review of PR #39 closed without its summary: gh: HTTP 502 Bad Gateway
```

The record keeps how many findings were not posted, and not which. Where the
round closed the episode, its summary's Notes lists each one, as [§ 5](summary.md) sets out.
Where the round left threads open and the episode with them, nothing lists them.

A state file that cannot be read gets a line of its own on stderr, naming the
pull request, the worktree and what was wrong, and every other worktree is still
listed. A worktree git lists that is gone from disk holds no records and prints
nothing. Where nothing is recorded anywhere, stdout says so:

```
No review is recorded in any worktree of this repository.
```

That line is printed only where every state file was read. Where one could not
be and no other state was listed, stdout is empty, so an unread record is never
taken for none.

## `squiz init`

`squiz init` links `squiz` into a directory already on `PATH`, so that a coding
agent whose shell does not have the plugin's `bin/` on its `PATH` runs `squiz` by
name. Only Claude Code puts the plugin's `bin/` there, and only for its Bash
tool and the commands typed after `!` (The `squiz` binary). It prints a line
for what it did, and exits 0 where the link is in place afterwards and 1
otherwise, with the line on stderr. It writes nothing in
the repository it is run from, and runs outside one as well.

- **The link's target is this squiz:** the real path of the `bin/squiz` that is
  running, every symlink resolved, so the link holds an absolute path.
- **The directory is `~/.local/bin`, or else `~/bin`:** the first of the two
  that is on `PATH`, is a directory, and can be written to. No other directory
  on `PATH` is used, even a writable one. `squiz init` creates no directory and
  edits no shell startup file.
- **Every `squiz` already on `PATH` is read first,** in each of its
  directories, with an empty or relative entry read from the working directory
  as a shell would. One person may run several coding agents on one machine, and
  none of them may change which `squiz` another runs. So nothing named `squiz`
  that is not this squiz is replaced, or shadowed by a link put ahead of it:

| Already on `PATH` | `squiz init` |
|---|---|
| A link to this squiz | Changes nothing, and says so |
| A link to another version of the same plugin-cache install, `plugins/cache/<marketplace>/squiz/<version>/bin/squiz`, whether or not that version is still there | Moves the link to this version, wherever it is on `PATH` |
| This squiz's own `bin/` | Ignores it, as only Claude Code's shell has it |
| A link to another squiz checkout or install | Makes no link, names it, and says to remove it and run `squiz init` again to use this one |
| Another squiz's own `bin/`, as Claude Code puts an enabled plugin's | Makes no link, and says to run `squiz init` by name in that session, so the link points at the squiz Claude Code uses |
| Anything else named `squiz`, or a link to something missing | Makes no link, names it, and leaves it alone |
| Nothing, and neither directory can take the link | Makes no link, and says to add `~/.local/bin` to `PATH` |

A squiz is a `bin/squiz` whose plugin's `.claude-plugin/plugin.json` names it
`squiz`.

```
squiz: linked /Users/ana/.local/bin/squiz to /Users/ana/.claude/plugins/cache/tools/squiz/0.2.0/bin/squiz
squiz: /Users/ana/.local/bin/squiz already links to this squiz; nothing changed
squiz: linked /Users/ana/.local/bin/squiz to /Users/ana/.claude/plugins/cache/tools/squiz/0.2.0/bin/squiz, in place of /Users/ana/.claude/plugins/cache/tools/squiz/0.1.0/bin/squiz, an earlier version of this install
squiz: made no link: /Users/ana/.local/bin/squiz links to another squiz, /Users/ana/dev/squiz/bin/squiz. To use this one instead, remove /Users/ana/.local/bin/squiz and run squiz init again
squiz: made no link: neither /Users/ana/.local/bin nor /Users/ana/bin is a directory on PATH that you can write to. Add /Users/ana/.local/bin to PATH, creating it if it does not exist, then run squiz init again
```

## The setup check

`squiz doctor` is run by a person, from a shell. It prints one line per
dependency on stdout, saying it is present or naming what is wrong with it, and
a line naming the project's `pi` settings a review does not use, where it has
any:

```
git 2.51.0
gh 2.97.0, signed in as ana
Claude Code 2.4.1
copilot 1.0.92, experimental features on
Node 24.6.0
tmux: not found. Not required: without tmux or Herdr, reviews run detached
Herdr 0.9.3
squiz link: /Users/ana/.local/bin/squiz already links to this squiz
Reviewer pi 0.85.1, model deepseek/deepseek-v4-pro, pi's default
```

It exits 0 where every required dependency is usable and 1 otherwise. It runs
outside a repository as well. Every tool it starts, it starts in the directory
it was run from, except Copilot's sign-in prompt. That prompt runs in a temporary
directory, which is the only thing the check writes and which it removes once
the prompt ends.

Each line is one row of a list, in the order printed. A row is at one of three
levels, and only `failed` changes the exit status:

| Level | Meaning | Example |
|---|---|---|
| present | Usable, or an optional tool that is absent | `tmux: not found. Not required: without tmux or Herdr, reviews run detached` |
| warning | Something a person should see, which squiz runs without | `tmux: warning: could not be run: tmux exited 134: dyld: Library not loaded` |
| failed | A required dependency is missing, unusable or unauthenticated | `gh 2.97.0: not signed in. Run gh auth login` |

The rows, in the order they print:

| Row | Required | Read from |
|---|---|---|
| `git` | Yes | `git --version` |
| `gh`, and its sign-in | Yes | `gh --version`, then `gh auth status --json hosts --active` |
| Claude Code | Where `copilot` is missing or cannot be run | `claude --version` |
| Copilot, and its experimental features | No, and printed only where `copilot` is on `PATH` | `copilot --version`, then `<COPILOT_HOME>/settings.json` |
| Node | Yes | The Node running squiz |
| tmux | No | `tmux -V` |
| Herdr | No | `herdr --version` |
| The `squiz` link | No | What `squiz init` finds on `PATH` |
| Copilot's copies of squiz | No, and printed only where `copilot` is on `PATH` and has squiz installed | `.claude-plugin/plugin.json` in each copy under `<COPILOT_HOME>/installed-plugins/` |
| The reviewer, its model, and Copilot's sign-in | Yes | `.squiz.json`, then `pi --version` or `copilot --version`, then the reviewer CLI's own settings, then for Copilot one prompt |
| The project's `pi` settings a review does not use | No | The repository's root, where the reviewer is `pi` |

**Each tool is found on `PATH` and started once to ask its version.** What
starting it came to decides the line, and only a version read from its output
makes it present:

| Starting it | The line |
|---|---|
| No directory on `PATH` holds it | `git: not found` |
| It exits non-zero | `git: could not be run: git exited 1: xcrun: error: invalid active developer path`, with the first line it printed |
| It does not answer within 15 seconds | `git: could not be run: git did not answer within 15 seconds` |
| It prints no version | `Claude Code: could not be run: claude printed no version: hello` |

An optional tool that could be found but not run is a warning rather than a
failure.

**`gh` is signed in where `gh auth status --json` reports an account whose check
succeeded.** That command exits 0 whatever the login's state, and reports each
host's active account with the outcome of checking it against GitHub. `gh auth
token` is not used, because it can print a token from the system's credential
store that `gh` itself does not use.

```
gh 2.97.0, signed in as ana
gh 2.97.0, signed in as ana on github.example.com
gh 2.97.0: not signed in. Run gh auth login
gh 2.97.0: not signed in: the login ana on github.com failed its check: non-200 OK status code: 401 Unauthorized
gh 2.20.0: its sign-in could not be checked: gh exited 1: unknown flag: --json
```

**The Node reported is the one running squiz**, which is the `node` that
`bin/squiz` found on `PATH`. Every subcommand runs on that one, so it is the
version [§ 8 Language](project.md#language) requires. A version below 24 fails:

```
Node 23.6.0: too old. Squiz needs Node 24 or later
```

A Node too old to strip types cannot load squiz at all, and fails before the
check prints anything.

**The `squiz` link row reads `PATH` as `squiz init` reads it** ([§ 6 `squiz
init`](#squiz-init)), measured against the squiz that is running, and names what it finds in
`squiz init`'s words. It is never a failure. Claude Code's own shell runs squiz
with no link, so no link is present rather than missing. Anything `squiz init`
would refuse or change is a warning, as an optional tool that cannot be run is.
Where `PATH` holds more than one `squiz`, the row names the one `squiz init`
would act on: the first that is not squiz or not this squiz, then the first
other version of this install, then a link to this squiz.

| Already on `PATH` | Level | The line |
|---|---|---|
| A link to this squiz | present | `squiz link: /Users/ana/.local/bin/squiz already links to this squiz` |
| No link, or only this squiz's own `bin/` | present | `squiz link: none on PATH. Not required in Claude Code, whose own shell runs squiz; for another coding agent, run squiz init` |
| A link to another version of the same plugin-cache install | warning | `squiz link: warning: /Users/ana/.local/bin/squiz links to /Users/ana/.claude/plugins/cache/tools/squiz/0.1.0/bin/squiz, another version of this install. Run squiz init to move it to this one` |
| A link to another squiz, another squiz's own `bin/`, anything else named `squiz`, or a link to something missing | warning | `squiz link: warning: ` followed by the reason `squiz init` gives, such as `/Users/ana/.local/bin/squiz links to another squiz, /Users/ana/dev/squiz/bin/squiz. To use this one instead, remove /Users/ana/.local/bin/squiz and run squiz init again` |

This squiz's own `bin/` on `PATH`, which Claude Code's Bash tool has, is no
link: another agent's shell does not have it. The squiz that is running is the
real path of its `bin/squiz`, so `squiz doctor` run through the link still
finds the link pointing at itself.

**Each copy of squiz that Copilot keeps is compared with the squiz that is
running.** Copilot's hook runs its own copy ([§ 9 Installing](adoption.md#installing)), and `squiz review`
run by name runs the one `squiz init` linked. Where the two are different
versions, both write one `.squiz/<number>/state.json`. The row prints one line
per copy, and nothing where `copilot` is not on `PATH` or Copilot has no copy.
None of its lines changes the exit status.

The copies are the directories under `<COPILOT_HOME>/installed-plugins/`, with
`COPILOT_HOME` read as for experimental features:

- `<marketplace>/squiz`, for each marketplace squiz was installed from
- `_direct/<name>`, for a direct install, where its `plugin.json` names squiz,
  or where it has no readable `plugin.json` and holds `bin/squiz`

A copy's version is `version` in its `.claude-plugin/plugin.json`, and this
squiz's is the same field in its own. A directory whose `plugin.json` names
another plugin is not a copy. A plugin installed from a local marketplace is
loaded from that directory and has no copy, so it is not compared.

| Found | Level | The line |
|---|---|---|
| The same version | present | `Copilot's squiz: /Users/ana/.copilot/installed-plugins/squiz/squiz is 0.2.0, as this squiz is` |
| A different version | warning | `Copilot's squiz: warning: /Users/ana/.copilot/installed-plugins/squiz/squiz is 0.1.0, and this squiz at /Users/ana/.claude/plugins/cache/squiz/squiz/0.2.0 is 0.2.0. Copilot's hook runs its own copy, so two versions write one state file. Update Copilot's copy, which is older` |
| A `plugin.json` that cannot be read, is not JSON, is not an object, or names no plugin or no version | warning | `Copilot's squiz: warning: the version of /Users/ana/.copilot/installed-plugins/squiz/squiz could not be read: /Users/ana/.copilot/installed-plugins/squiz/squiz/.claude-plugin/plugin.json is not JSON: Unexpected token` |
| This squiz's own version that cannot be read | warning | `Copilot's squiz: warning: /Users/ana/.copilot/installed-plugins/squiz/squiz is 0.1.0, and the version of this squiz at /Users/ana/dev/squiz could not be read: /Users/ana/dev/squiz/.claude-plugin/plugin.json names no version` |
| An `installed-plugins`, or a `_direct` in it, that exists and cannot be listed. The marketplace copies are still compared where only `_direct` cannot be | warning | `Copilot's squiz: warning: /Users/ana/.copilot/installed-plugins could not be read: EACCES: permission denied, scandir '/Users/ana/.copilot/installed-plugins'` |

The older version is the one whose dotted numbers are lower, read as numbers,
so `0.9.0` is older than `0.10.0`. The line ends `Update this squiz, which is
older` where this squiz is. Where either version is more than dotted numbers,
such as `0.2.0-beta.1`, it ends `Update the older one`.

**The reviewer is the one `reviewer` names in `.squiz.json`** at the root of the
repository the check is run in, which `git rev-parse --show-toplevel` gives.
Outside a repository, or in one with no `.squiz.json`, it is the default, `pi`.
It is outside a repository only where git says `not a git repository`, read
with `LC_ALL=C` so the message is not translated. Where git is missing, or
refuses for any other reason, the row fails with that reason, because a round
would stop on it too:

```
Reviewer: the repository could not be found: git exited 128: fatal: detected dubious ownership in repository at '/work/app'
```

The file is read as a round reads it ([§ 9 Configuration](adoption.md#configuration)). A file that reading
refuses fails the row, with the reason it was refused:

```
Reviewer: .squiz.json refused: /work/app/.squiz.json: "reviewer" is "claude", but it must be "pi" or "copilot"
```

Otherwise the reviewer's CLI is started for its version, as every tool is, and a
missing one fails the row by name:

```
Reviewer pi: not found
Reviewer copilot: not found
```

**The model named is the one a round would run on.** It is `model` from
`.squiz.json` where the file sets it. Otherwise it is the user's default, as
the reviewer CLI's own settings give it:

| Reviewer | The user's default |
|---|---|
| `pi` | `defaultProvider` and `defaultModel`, as `provider/id`, in `settings.json` under `PI_CODING_AGENT_DIR`, or under `~/.pi/agent` where that is unset |
| `copilot` | `COPILOT_MODEL`, or else `model` in the user's own `settings.json`, as `confine` reads it ([§ 4 The Copilot adapter](adapters.md#the-copilot-adapter)) |

A project's own `.pi/settings.json` is not read, because a review runs `pi`
with the project untrusted ([§ 4 The `pi` adapter](adapters.md#the-pi-adapter)), and Copilot does not use a
project's `.github/copilot/settings.json` for the model. Where neither
`.squiz.json` nor the CLI's settings name a model, the model is unknown:

```
Reviewer pi 0.85.1, model openai/gpt-5-mini, from .squiz.json
Reviewer pi 0.85.1, model deepseek/deepseek-v4-pro, pi's default
Reviewer pi 0.85.1, model unknown: neither .squiz.json nor pi's settings name one
Reviewer pi 0.85.1: warning: model unknown: pi's settings /Users/ana/.pi/agent/settings.json are not JSON: Unexpected token
Reviewer copilot 1.0.93, model gpt-6-astra, Copilot's default. Signed in; the check spent one request on gpt-5-mini
Reviewer copilot 1.0.93: model unknown: the user's Copilot settings /Users/ana/.copilot/settings.json are not an object
```

Settings that cannot be read are a warning for `pi`, which starts without them,
and a failure for Copilot, whose round fails on them before it starts (The
Copilot adapter).

**Copilot's sign-in is checked with one prompt, which spends one request.** No
`copilot` command reports whether it is signed in without reaching the model.
Where `.squiz.json` names Copilot as the reviewer, and its settings do not
already fail the row, the row runs:

```
copilot -p "Reply with the single word OK." --model gpt-5-mini --no-ask-user
```

It runs with the variables a round gives a Copilot reviewer, so it signs in the
way a round does. `COPILOT_HOME` and `GH_CONFIG_DIR` name empty directories in
the prompt's temporary directory, and `COPILOT_ALLOW_ALL` and the four `gh`
token variables are empty ([§ 4 Tools](reviewer.md#tools), [The Copilot adapter](adapters.md#the-copilot-adapter)). A relative or
empty `PATH` entry is read from the directory the check was run in, so the
prompt reaches the `copilot` whose version the row names. The model is
`gpt-5-mini` whatever model a round would run on. On Copilot CLI 1.0.93 the
prompt cost 0.35 AI credits and took 13 seconds. It is bounded at 60 seconds
rather than the 15 a version is given.

| The prompt | Level | The line ends |
|---|---|---|
| Exits 0 | present | `. Signed in; the check spent one request on gpt-5-mini` |
| Exits non-zero | failed | `. Its sign-in check failed: copilot exited 1: Error: No authentication information found.`, with the first line Copilot printed and the indented lines under it |
| Does not answer within 60 seconds | failed | `. Its sign-in check failed: copilot did not answer within 60 seconds` |
| Its temporary directory cannot be made | failed | `. Its sign-in could not be checked: ` followed by the reason |

Copilot exits 1 before any request when it finds no login, and prints one of
these first:

```
Error: No authentication information found.
Error: Authentication token found but could not be validated.

  Failed to fetch PAT user login (401): GitHub returned: Bad credentials
```

For the second, the line ends `. Its sign-in check failed: copilot exited 1:
Error: Authentication token found but could not be validated. Failed to fetch
PAT user login (401): GitHub returned: Bad credentials`.

No prompt is sent where the reviewer is `pi`, or for Copilot as a coding agent.

**Claude Code is required only where Copilot cannot be the coding agent
instead.** Either can be ([§ 2](dependencies.md)), so where `claude` is not on `PATH` and
`copilot` answers with its version, the row is present. Where `copilot` is
missing too, or cannot be run, the row fails. A `claude` that is installed and
cannot be run fails the row either way.

```
Claude Code: not found. Not required: copilot is installed, and either can be the coding agent
Claude Code: not found
```

**Copilot is reported as a coding agent wherever `copilot` is on `PATH`,** since
`.squiz.json` names the reviewer and nothing names the coding agents. Where it
is not on `PATH`, the check prints nothing about it. Every line of this row is
present or a warning, and none changes the exit status.

The row says whether experimental features are on, because a Copilot session
without them is never woken by its review ([§ 9 Getting started](adoption.md#getting-started)). They are on
where `"experimental"` is `true` in the user's own `<COPILOT_HOME>/settings.json`,
under `COPILOT_HOME` or `~/.copilot` where that is unset. The file is read as
the reviewer's model is read from it, with Copilot's `//` lines removed. They
are off where the file is missing, sets no `"experimental"`, or sets it to
`false`. A repository's `.github/copilot/settings.json` is not read, because it
turns nothing on.

| Found | Level | The line |
|---|---|---|
| `"experimental": true` | present | `copilot 1.2.0, experimental features on` |
| No file, no key, or `false` | warning | `warning: copilot 1.2.0 has experimental features off. If Copilot writes your code, it is never woken when a review finishes. Run /experimental on in Copilot, or start it once with copilot --experimental` |
| A file that cannot be read, is not JSON, or is not an object | warning | `warning: copilot 1.2.0: whether experimental features are on is unknown: the user's Copilot settings /Users/ana/.copilot/settings.json are not JSON: Unexpected token` |
| `"experimental"` set to anything else | warning | `warning: copilot 1.2.0: whether experimental features are on is unknown: "experimental" is "yes" in /Users/ana/.copilot/settings.json` |
| A `copilot` that cannot be run | warning | `copilot: warning: could not be run: copilot exited 139: segfault` |

A second line follows where the extension's socket path is too long to listen
on. The path is `<COPILOT_HOME>/session-state/<session id>/squiz.sock`, and a
session id is a 36-character UUID. Its length in bytes is measured against 104
on macOS and 108 on Linux, and a longer one is a warning:

```
warning: copilot's extension cannot listen: its socket /Users/ana/work/tools/copilot-home-of-ana-1/session-state/<session id>/squiz.sock is 105 bytes, over the 104 macOS allows. Set COPILOT_HOME to a shorter directory
```

**Where Copilot is both a coding agent and the reviewer, both rows print, and
each says what the other does not.** The coding agent's row says whether its
experimental features are on and whether its socket fits. The reviewer's row
says its model and its sign-in. A round runs the reviewer under a
`COPILOT_HOME` of its own, so neither the features nor the socket bear on it.

```
copilot 1.0.92, experimental features on
Reviewer copilot 1.0.92, model gpt-6-astra, Copilot's default. Signed in; the check spent one request on gpt-5-mini
```

`copilot --version` is started once, however many rows read it.

**Where the reviewer is `pi`, the row after it names the project's own `pi`
settings, which a review does not use.** A round runs `pi` with `--no-approve`
([§ 4 The `pi` adapter](adapters.md#the-pi-adapter)), and `pi` takes none of these from a project it does not
trust:

- `.pi/settings.json`, named with its top-level keys where it is a JSON object
- `.pi/extensions`, `.pi/skills`, `.pi/prompts` and `.pi/themes`
- `.pi/SYSTEM.md` and `.pi/APPEND_SYSTEM.md`
- `.agents/skills`

In their place the review takes the user's own `pi` settings, the ones under
`PI_CODING_AGENT_DIR` or `~/.pi/agent`. The row ends with the context file that
still reaches the reviewer, where the root holds one. `pi` loads a context file
whatever the trust, and only one from a directory: the first of
`AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md` and `CLAUDE.MD` that
is there.

```
pi project settings: a review does not use .pi/settings.json (defaultModel, retry), .pi/SYSTEM.md or .agents/skills, and takes your own pi settings instead. AGENTS.md still reaches the reviewer
pi project settings: a review does not use .pi/APPEND_SYSTEM.md, and takes your own pi settings instead
```

The row prints nothing where the root holds none of these, as for a bare `.pi`
directory. Nor does it print where the reviewer is Copilot, outside a
repository, or where the reviewer's row failed on the repository or its
`.squiz.json`. It reads the root the reviewer's row found, and git is not asked
for it again.

**The row reports configuration, not that a review leaves it unused.** It
establishes that the files are there for `pi` to find. It does not establish:

- That `pi` honours `--no-approve`. The flag is on squiz's own command line, so a
  row that checked for it would restate squiz's assumption. A `pi` that renamed
  the flag would leave the row unchanged.
- That a round reads these files at all. The row reads the working tree at the
  repository's root, and a round reads a snapshot of the head commit ([§ 4 The
  snapshot](reviewer.md#the-snapshot)), so a file not committed there is named all the same.
- That the list is `pi`'s whole list. It is the list `pi` 0.85.1 requires trust
  for, read from its code, and a later `pi` may add to it.
