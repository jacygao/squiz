# Review Harness Specification: A Local Review Loop That Lives on the Pull Request

**Version:** 1.36 (draft)

## 1. Purpose

**Squiz automates code review between agents.** Whenever a coding agent
finishes a piece of work, a reviewer agent reviews it. The reviewer can run a
different model from the coding agent, and a different harness. The two agents
work through the findings over as many rounds as it takes to settle them.
Everything they say to each other is kept as review comments on the pull
request, or in the worktree under the local venue (§ 4).

## 2. Dependencies

Squiz runs on the developer's machine. The GitHub venue needs all three of
these. The local venue needs `git` in place of the GitHub repository (§ 4).

| Dependency | Supported | Needed for |
|---|---|---|
| GitHub repository | `git`, and `gh` signed in | Holds the pull request the review is recorded on. |
| Runtime | Claude Code / GitHub Copilot CLI | Runs the coding agent, and starts a review when the agent finishes its work. |
| Reviewer | `pi` / GitHub Copilot CLI | Reviews the change. Only the one the `reviewer` setting names has to be installed. |

### GitHub access

Squiz does all of this through `gh`:

- Read a pull request: its description, its base and head refs, and the commit
  each names
- List its review threads, and whether each one is resolved
- Post a review comment anchored to a file and a line, or to a file with no line
- Reply inside a review thread
- Resolve a review thread, and re-open one
- Post an issue-level comment on the pull request, for the summary and for a
  round that failed

### Identity

Every comment is posted with the credentials `gh` holds. The reviewer, the
coding agent and the harness all post as the one account `gh` authenticated.

Each comment's first line opens a bold span with its author's marker:

| Written by | Begins |
|---|---|
| The reviewer | `**Squiz reviewer · ` |
| The coding agent | `**Squiz coding agent` |
| The harness, at close | `**Squiz review — ` |
| The harness, when a round fails | `**Squiz review failed — ` |

A comment that carries none of these markers is read as written by a person.

## 3. The loop

A trigger queues a state of the pull request, a round host reviews it in a round,
and the session that owns the work is told the result. That session works the
threads, and the next trigger queues the next state, until the episode closes.

### Terminology

| Term | What it is |
|---|---|
| **Episode** | One review of one pull request in one worktree, from its first round to its close. A worktree holds one live episode per pull request at a time, and keeps the episodes before it. |
| **Round** | One review of one state of the pull request (The state file). |

An episode closes for one of three reasons: a round leaves nothing open, the
round cap is spent, or a round reaches the token bound (§ 8 The review budget).
A close is **clean** where its
round left nothing open and no state behind it not reviewed. Every other close is
at the round cap or the token bound, and stays closed.

### The state file

**An episode's state lives in `.squiz/<number>/` inside the worktree, keyed by
the pull request's number:**

```
.squiz/
  .gitignore              *
  41/
    state.json            the state file: one record for each state
    host.log              the round host's output (The round host)
    notes/<session id>/   the owner's notes (The report)
    rounds/<k>/           each round's reviewer session (§ 5 The reviewer session)
    episodes/<n>/         each closed episode a later one replaced, from 1
```

Wherever squiz makes an episode directory and `.squiz/.gitignore` is missing, it
writes one holding `*`. An existing one is left as it is.

**A state of the pull request is two things:**

- **The head commit.**
- **The latest activity on the reviewer's threads:** the newest reply, by anyone
  other than the reviewer, on a thread the reviewer opened. Replies on a thread a
  person opened are no activity. Editing a reply changes nothing. Deleting one can
  change which reply is newest, and that is a change like any other.

Each state's record has one of five statuses:

| Status | What it records |
|---|---|
| Queued | A trigger asked for a review of this state, and no round has taken it. |
| Reviewing | A round host is running its round, and the record names the host. |
| Reviewed | The round's exit status and the threads it left open. A round that left nothing open while a later state was queued records *reviewed clean, episode open*, with no exit status. |
| Failed | Why the round failed. |
| Not reviewed | Why no round reviewed it: the episode closed first, or a later state superseded it. |

**A trigger acts on the record of the pull request's current state:**

| Record | What the trigger does |
|---|---|
| None | Queues the state, and starts a round host where none runs. |
| Queued | Starts a round host where none runs. |
| Reviewing, by a host that is running | Nothing. |
| Reviewing, by a host that has gone | Nothing. The round is killed (The round host). |
| Reviewing, by a host that cannot be told running or gone | Nothing. `squiz review` exits 1 naming the host it could not check, and a hook returns. |
| Failed | A hook queues nothing. `squiz review` queues the state again. |
| Reviewed, or not reviewed | Nothing. `squiz review` returns that result, with the threads as they stand now. |

**Only `squiz review` retries a failed state, never a hook.** The retry is queued
behind every state already queued or recorded. A retry that fails again posts its
failure comment and exits 1, writes no second note to the owner, and its stderr
tells the coding agent not to run the command again (§ 7 `squiz review`).

**Each state gets at most one review.** Repeated triggers for a state already
queued or under review post one set of threads and at most one summary. An
episode runs one round at a time, oldest queued state first. Only a trigger
queues a state, never the round host, and every queued state ends reviewed or
with a result of its own.

**A round closes the episode only when nothing is queued behind it, except at the
round cap or the token bound.** Say state A's round ends and state B is queued:

| A's round ends with | What happens |
|---|---|
| Threads open, rounds remaining | B is reviewed next. |
| Nothing open, rounds remaining | A is recorded *reviewed clean, episode open*: no exit status, no summary and no note for its owner. B is reviewed next. A `squiz review` waiting on A returns the result of the state the queue ends on: 0 or 3 with the close, or 2 where B left threads open. It exits 4 where its wait runs out first. |
| The round cap or the token bound reached, by a review or by a failure (§ 6) | The episode closes. The summary's Notes name the bound and each state left not reviewed, and B is recorded not reviewed. A `squiz review` waiting on B exits 3 with a line saying why, and B's owner gets a note saying the same. |

A state left not reviewed is named by its short head commit, followed by "with
different replies" where the state the closing round reviewed, or one queued
ahead of it, has the same commit:

```
Squiz did not review PR #41 at 3f9c2e0 with different replies: the episode closed at the round cap, after reviewing 3f9c2e0.
```

**A round reviews only the pull request's newest state.** A state the pull
request has moved past by the time its round starts is superseded: nothing is
reviewed or posted for it, and it is recorded not reviewed, naming the state that
superseded it:

```
superseded by 8d21a4f
superseded by 3f9c2e0 with different replies
```

A `squiz review` waiting on a superseded state returns the superseding state's
result. Where that state has no record, the run reads the pull request afresh and
acts on its record as any trigger does. It exits 4 where its wait runs out first.

Where A was reviewed clean with B queued, and B is then superseded by A, as when
the reply that made B is deleted, B is recorded superseded and the episode stays
open for the next commit or reply.

**A close at the round cap or the token bound stays closed in its worktree.** A
new commit or reply queues nothing, and `squiz review` prints the close. A second
episode on that pull request needs another worktree on the same branch.

**After a clean close, a trigger acts on each state as follows:**

- **No record, on a head other than the one the close reviewed:** the state starts
  a new episode in the same worktree, and `squiz review` waits on it as on any
  state.
- **A record the closed episode wrote, on another head:** `squiz review` answers
  from that record, naming its own head.
- **New replies on the head the close reviewed, and a failed record the closed
  episode wrote:** nothing is queued, and `squiz review` prints the close.
- **A record queued after the close:** the trigger acts on it as on any record.

The new episode has its own round cap and token bound, and posts its own summary.
The reviewer's rulings carry over, and the closed episode's threads are part of
it. The closed episode moves to `episodes/<n>/`, numbered from 1 in the order the
episodes closed, and `host.log` says where:

```
2026-11-08T09:14:02.511Z a new episode starts on a state the clean close never recorded: the closed one is in /work/squiz/.squiz/41/episodes/1
```

Where a round of the closed episode is still recorded under review, no new
episode starts. Each state queued after the close is recorded failed, and
`squiz review` retries it as any failed state:

```
no review ran: round 1 of the closed episode is still recorded under review by round host 4242
```

### A round, step by step

1. **Gate on the pull request.** A trigger reviews pull request `<number>` only
   where it is open, is not a draft, and has its head branch checked out in the
   directory the trigger ran in, not another branch and not a detached HEAD. The
   round host checks again that it is open and checked out when the round
   starts. Where a check fails, no review runs, nothing is posted and nothing is
   written to `.squiz/`. Where the pull request is not open or not checked out,
   `squiz review` exits 1, and stderr names what it found:

   ```
   squiz: no review ran: PR #41's head is "feature-a", and "/work/squiz" has "main" checked out
   ```

   § 7 `squiz review` gives what a draft prints.
2. **Gate on the episode.** The record of the state decides whether it is queued,
   as The state file sets out.
3. **Run the reviewer** on a snapshot of the state's head commit (§ 5).
4. **Post the findings and apply the verdicts** (§ 5 Findings).
5. **Hand back the open threads**, where rounds remain, to the session that owns
   the work (The report).
6. **Or close the episode**, and post the summary (§ 6).

Only a reviewer's verdict resolves a thread. The coding agent replies on a
thread, to say what it changed, to disagree or to ask, and never resolves one.

### The round cap

**A round cap (`rounds`, § 10 Configuration) of R allows R rounds**, so open
threads go back to the coding agent at most R−1 times. Every round counts against
it, whether a commit or a reply started it, a failed round included. A run that
returns a recorded result is no round and spends nothing.

**The round that spends the last of the round cap or the token bound closes the
episode, whether it reviewed or failed.** Any other failed round closes nothing.
§ 6 says what a failed round's close posts.

**A reply with no commit after it is ruled on.** A reply on a reviewer's thread
starts a round on a new state, which rules on the thread: `withdrawn` where the
argument holds, `open` where it does not.

**Round R is the closing round.** It reviews as any round does, then closes the
episode whatever is open, posts the summary and hands nothing back. With a cap of
1 the first round is the closing round.

### What starts a round

**A round starts only from a trigger:** the plugin's `Stop` and `SubagentStop`
hooks, under Claude Code and Copilot alike, or `squiz review <number>`, which a
coordinator or a CI job can run from a checkout of the pull request's branch. In
a runtime with no hook, only `squiz review` starts one.

### The round host

**The rounds of one episode run one at a time in a round host, `squiz host
<number>`, outside every trigger's process.** Its output is in
`.squiz/<number>/host.log`. A trigger that queues a state starts one where none
runs, detached so that it outlives the shell call or hook that started it. A
person never starts one. At most one runs per episode. It exits when nothing is
left queued or its worktree is gone, and after it dies the next trigger starts a
host for any queued state.

**A round whose round host died is not recovered.** Nothing its reviewer reported
is posted, and its reviewer and its snapshot are left as they are. Its record
stays under review, `squiz status` shows it `killed`, and `squiz review` exits 1
saying the round host stopped before its round ended (#327).

### The hooks

**`hooks/hooks.json` registers `squiz hook` on `Stop`, `SubagentStop`,
`SessionStart`, `SubagentStart` and `UserPromptSubmit`.** The plugin root is
quoted, so a path with a space stays one word under `/bin/sh` and `/bin/bash`.
Every event has the same entry:

```json
"Stop": [
  { "hooks": [ { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/bin/squiz\" hook" } ] }
]
```

Only the two stop firings, and `squiz review`, start a round. `SessionStart` and
`SubagentStart` record the base under the local venue (§ 4 The base).

**Every hook takes its worktree from the payload's `cwd`**, never from its own
directory. A stop whose payload has no `cwd`, a relative one, or one in no git
worktree queues nothing and says so on stderr.

**A stop firing resolves the pull request whose head is the branch checked out in
`cwd`, records the session that owns the work, queues the state, and returns at
once.** It never runs a round or blocks the agent, and exits 0 whatever it found,
an unreadable payload included. A stop that finds no pull request writes the line
step 1 gives, naming the branch and the directory.

| Event | The owner of the work |
|---|---|
| `Stop` | The session itself |
| `SubagentStop` | The session that dispatched the subagent, with the subagent's `agent_id` |

**A stop that is not the coding agent's work queues nothing:**

- a `SubagentStop` whose `agent_type` is empty;
- a Copilot `Stop` whose `session_id` is not the session its `transcript_path`
  names. A Claude Code `Stop` is never dropped by this rule.

**`UserPromptSubmit` hands the payload's `prompt` to the venue, and does nothing
else.** The GitHub venue does nothing with it, and the local venue records it as
the change's description (§ 4 The record). It prints nothing on stdout.

- A payload with a non-empty `agent_id`, or whose `cwd` is in no git repository,
  records nothing and says nothing.
- A payload with no `prompt`, or an empty one, records nothing and says so on
  stderr.
- A recording that fails writes `no prompt was recorded:` and the reason on
  stderr.

Neither stderr line carries the prompt.

### The report

**When a round records its result, the round host writes one note for the
session that owns the work and is still alive**, as a file in
`.squiz/<number>/notes/<session id>/`. A subagent's work is reported to the
session that dispatched it. A failed state gets one note however many times it
fails, a state not reviewed gets one saying why, and a state with no recorded
owner gets none.

**A note for open threads gives them, each as `squiz review` prints it (§ 7):**

```
Squiz reviewed PR #41 at 3f9c2e0, the work of subagent a402ef8f56c1b2ed1: 2 threads are open:

PRRT_kwDOL7tYbc5abcd1 packages/sync/src/queue.ts:134 high — Retry backoff resets on every enqueue
  - `enqueue()` calls `resetBackoff()` on every call, so a busy queue never backs off.

  **Suggested fix:** reset the backoff only when the queue was empty.

PRRT_kwDOL7tYbc5abcd2 packages/sync/src/session.ts:57 medium — Clock skew is read as token expiry
  - `isExpired()` compares the server's `exp` against the local clock with no margin.

  **Suggested fix:** allow the skew the server documents before reading a token as expired.

Fix what applies in /work/squiz, and reply on each thread with
`(cd '/work/squiz' && squiz reply <id> <text>)` to say what you changed or why
you disagree. Commit and push what you changed, then run `squiz review 41` again.
```

- **The episode closed with threads open:** the first line ends `the episode has
  closed with 2 threads open:`, and the threads end the note.
- **The episode closed with nothing open:** the note says so.
- **The round failed:** the note gives the reason and names `squiz status`. It
  says whether a new commit, or running `squiz review` once, retries the state,
  or which bound closed the review.
- **More than 10 threads:** the note prints the first 10, then
  ``3 more threads are open. `squiz review 41` prints them all.``
- **The threads cannot be listed, or the listing holds none the round left
  open:** the note counts them and points to `squiz review`, as
  ``Squiz reviewed PR #41 at 3f9c2e0: 2 threads are open. Run `squiz review 41` to read them.``
  `host.log` says which case it was, and for a failed listing, why.

**Squiz wakes an idle owner with its note.**

- **Claude Code:** where the hook recorded the session's messaging socket, the
  round host moves the note into `delivered/` and posts its text to the socket as
  one line, and an idle session starts a turn with it.
- **Copilot:** the plugin ships `extensions/squiz-wake/extension.mjs`, which
  Copilot starts in each session. It listens on `squiz.sock` in the session's
  state directory, which the hook records, and turns each post into a turn.

A post that finds nothing listening fails, and is not retried. The note goes back
to `.squiz/<number>/notes/<session id>/`, where it was written, or stays in
`delivered/` where that move fails, and `host.log` gives both reasons.

**An owner no wake reaches learns the result from `squiz review` or `squiz
status`.** That includes a Copilot owner with no socket. One `squiz review` run
in the background wakes a Copilot owner when it exits. `host.log` says when no
wake reached the owner, or a note could not be written.

### Parallel coding agents

**Each worktree is reviewed on its own.** `squiz review` resolves the worktree
with `git rev-parse --show-toplevel` from the directory it runs in, and the hook
from the payload's `cwd`, which for a subagent is fixed when it is dispatched.
One worktree, one branch, one pull request, one live episode per pull request.

**Squiz never removes a worktree.** Whatever created it removes it, and the
episode's state goes with it.

**Where a tree's `HEAD` moved to another branch while an episode was live, each
pull request's episode keeps its state under its own number**, and each reviewer
reads a snapshot of its own pull request's head.

**Two coding agents on one branch in one tree share one episode and one round
cap**, and nothing detects it (#924).

## 4. The venue

**The venue is where a review happens.** It supplies the change under review and
keeps the record of the review. Squiz has two:

| Venue | The change | The record |
|---|---|---|
| `github` | A pull request, at its head commit | Review threads and comments on the pull request |
| `local` | The working tree, against the commit its work started from | Files in `.squiz/local/` in the worktree |

The loop is the same in both venues: the state file, the hooks, the queue, the
round host, the owner's note and its wake, the round cap and the budget. § 3
describes it in the GitHub venue's terms, and The local venue below says what
each of those terms means there.

### Choosing the venue

**The venue is the `venue` setting in `.squiz.json`, `github` or `local`, and
`github` where the file does not set it.** § 10 Configuration says which
`.squiz.json` each process reads. No environment variable plays a part, so a
round host started with an empty environment chooses the same venue as the hook
that started it.

**A `.squiz.json` that cannot be read, or whose `venue` is neither `github` nor
`local`, chooses no venue, and squiz does not review under GitHub in its place.**
`squiz review` exits 1, and a hook writes one line on stderr and exits 0:

```
squiz: no base was recorded: /work/squiz/.squiz.json: "venue" is "lcoal", but it must be "github" or "local"
```

A stop writes the reason after `squiz: nothing was queued:`, and a command after
its own prefix, such as `squiz: no threads listed:`.

### The contract

**Each venue names its change, the command that reviews it again, and where its
summary is, and every message uses the venue's words:**

| | GitHub | Local |
|---|---|---|
| The change | `PR #41` | `the working tree` |
| The command that reviews it again, from any directory | `squiz review 41` | `(cd '/work/squiz-a' && squiz review)` |
| Where the summary is | `on the pull request` | `in /work/squiz-a/.squiz/local/summary.md` |
| The key that names the episode | The pull request's number | `local` |

A summary and a failure comment have the same markdown body in both venues.

The commands name a change from its key:

- `squiz threads` and `squiz reply` call a GitHub change `#41`, and a local
  change `the working tree`.
- A bare `squiz review` takes the key `local` under the local venue, so a
  worktree with no recorded base gets the no-base line of The base below. Under
  the GitHub venue it prints its usage line.
- `squiz status` prints a numeric key as `#41`, and any other key as it is.

### The GitHub venue

**The GitHub venue's change is the pull request, and it is the only venue that
runs `gh`.** The base, the head and the description come from the pull request,
and the run's prompt never stands in for the description. Threads, replies,
resolves and re-opens are review threads on the pull request, with `PRRT_` ids,
listed in the order each was opened. Whether a thread is outdated, and who wrote
a comment, are what GitHub reports.

Where `squiz review` is given a number and the pull request checked out has
another, there is nothing to review, and it exits 1.

### The local venue

**The local venue reviews the working tree against the commit its work started
from.** It needs `git`, and no `gh`, remote, pull request or issue. Everything it
writes is in `.squiz/local/` in the worktree, and none of it becomes part of the
change.

| § 3 says | In the local venue |
|---|---|
| The pull request | The working tree's change against its base, under The base below |
| Its head commit | The commit built from the working tree, under The change below |
| Its description | `description.md`, else `prompt.md`, under The record below |
| The pull request's number, wherever it names the episode | `local`, so the episode directory is `.squiz/local/` |
| A review thread, its replies, resolving and re-opening it | An entry in `threads.json`, under The record below |
| The summary comment | `.squiz/local/summary.md` |
| A failure comment | `.squiz/local/failure-<k>.md`, numbered from 1 in the order written, and on from the highest present. The line that reports it reads `squiz: the failure is posted on the working tree`. |
| A draft, and a branch that is not the pull request's | No such case: the working tree is never held |
| The owner's note | As § 3 sets out, written in `.squiz/local/notes/` |

**The paragraph after the open threads names the worktree, and asks for no
commit or push.** Every command it gives runs in the reviewed worktree, inside a
subshell:

```
Fix what applies in /work/squiz-a, and reply on each thread with
`(cd '/work/squiz-a' && squiz reply <id> <text>)` to say what you changed or why
you disagree. Then run `(cd '/work/squiz-a' && squiz review)` again.
```

#### The base

**The first session or subagent to start in a worktree records its base in
`.squiz/local/base.json`.** An existing record is kept, so a resumed session, a
second session, and a subagent sharing its parent's directory all keep the first
one. A person never sets the base.

```json
{
  "commit": "7c1e0d3f2a4b5c6d7e8f90a1b2c3d4e5f6a7b8c9",
  "branches": ["refs/heads/main", "refs/remotes/origin/main"]
}
```

`commit` is the worktree's `HEAD` when the record is written. `branches` are the
branches, local and remote-tracking, that point at that commit then, the one
checked out included.

**The base is the newest of the recorded commit and the merge-base of `HEAD` with
each recorded branch as it stands now.** Three kinds of recorded branch are left
out:

- The branch checked out now, and every remote-tracking branch of the same name,
  such as `origin/work` for `work`. An upstream with another name is kept.
- A branch that no longer exists.
- A branch whose merge-base does not descend from the recorded commit.

Of what remains, the base is the one every other is an ancestor of, and the
recorded commit where there is none. A worktree rebased onto a branch that has
moved on gets that branch's commit as its base.

With no `base.json`, or with a recorded commit the repository does not have,
there is nothing to review:

```
squiz: no review ran: /work/squiz has no recorded base, which squiz records when a session or subagent starts there
squiz: no review ran: the recorded base 7c1e0d3f2a4b5c6d7e8f90a1b2c3d4e5f6a7b8c9 is not a commit in /work/squiz
```

#### The change

**The head is a commit built from the working tree on every trigger, before the
state is read.** It holds what `git add --all` in the worktree would take: every
tracked file, a tracked file that `.gitignore` names included, and every
untracked file that `.gitignore` does not exclude.

- Building it changes neither the worktree's index nor the working tree, and
  writes no object or ref into the repository. Its objects go into
  `.squiz/local/objects/`.
- A worktree of the same repository nested in the working tree, such as a
  subagent's under `.claude/worktrees/`, is left out unless the base has its
  path. A submodule, or a separate repository, stays in the tree as a gitlink.
- Two builds of the same tree against the same base give the same commit, so an
  unchanged tree is an unchanged state and is not reviewed again.

The reviewer's snapshot holds the built head and the base, and the change is the
diff from the base to the head. A working tree identical to its base is still
reviewed, as a round whose change lists no files.

#### The record

**`.squiz/local/` holds the live episode and the closed ones**, beside the files
that belong to the worktree:

```
.squiz/local/
  base.json  objects/  prompt.md  description.md  threads.json  failure-1.md …
  state.json  rounds/  notes/  summary.md       the live episode, as under § 3
  episodes/1/  state.json  rounds/  summary.md  a closed episode
```

When a new episode starts, `summary.md` moves into the closed one. `base.json`,
`objects/`, `prompt.md`, `threads.json` and the failure files stay in place, and
thread and comment ids keep counting across episodes.

**The change's description is `.squiz/local/description.md` where it exists, even
empty, else `.squiz/local/prompt.md`, else none.** Squiz never writes
`description.md`. It reads both files on every trigger, so a `description.md`
written later wins. The reviewer is handed the one chosen.

**`prompt.md` is the first prompt any session in the worktree was given**, exactly
as the payload carried it. A later prompt, session or resume never overwrites it.

**`threads.json` holds every thread:**

```json
{
  "threads": [
    {
      "id": "T1",
      "path": "packages/sync/src/queue.ts",
      "anchor": { "at": "line", "line": 134 },
      "isResolved": false,
      "comments": [
        { "id": "C1", "body": "**Squiz reviewer · high — Retry backoff resets on every enqueue**\n\n- …" },
        { "id": "C3", "body": "**Squiz coding agent**\n\nThe backoff now resets only when the queue was empty." }
      ]
    }
  ]
}
```

- Thread ids are `T1`, `T2`, … and comment ids `C1`, `C2`, … across all threads,
  in the order written. Ids start from `T1` in every worktree.
- A thread's anchor is a line of the head, `{ "at": "line", "line": n }`, or the
  file as a whole. The local venue never refuses a line, and always returns the
  thread's id.
- A thread's URL is the `file://` URL of `threads.json` followed by `#` and its
  id, such as `file:///work/squiz-a/.squiz/local/threads.json#T1`.
- A thread is never outdated, and every comment's author is `local`.

**After the run, `.squiz/local/` holds its outcome.** `threads.json` gives each
finding with its replies and whether it is resolved. `summary.md` counts them as
§ 6 sets out, with a thread still open that has a coding-agent reply counted
`disputed`. A run that ended before the episode closed has no `summary.md`, and
`squiz status` shows where it stopped.

#### The hooks

**`Stop` and `SubagentStop` build the worktree's head, then queue the state and
record its owner.** A subagent in a worktree of its own is reviewed in that
worktree's `.squiz/local/`, and its result wakes the session that dispatched it.
A Claude Code subagent dispatched into its own worktree has no description there
unless its dispatcher writes `description.md`.

Under `claude -p` or `copilot -p` the review still runs, its threads and summary
are written, and its note waits in `.squiz/local/notes/`. Nothing hands the
findings on after the run exits.

#### The commands

**`squiz review` takes no pull request number.** Given one, it exits 1:

```
squiz: no review ran: the local venue reviews the working tree, and takes no pull request number
```

Any key but `local` is not reviewable.

**`squiz reply <id> <text>` adds the coding agent's reply to the thread in that
worktree's `threads.json`**, and refuses an id it does not hold:

```
squiz: nothing replied in T9: threads.json holds no thread "T9"
```

**`squiz doctor` does not require `gh`.** A missing `gh` is a row at level
`present`, which does not fail the check, reading `gh: not found. Not required
under the local venue`. A `gh` that cannot be used is a warning.

## 5. The reviewer

The reviewer is a second agent that reads the change and reports what is wrong
with it. It has no GitHub access of its own. Its findings, its verdicts and its
finish reach squiz through three calls, `report_finding`, `report_verdict` and
`finish_review`, and squiz posts them. Its last message is not read.

### Invocation

**Each round starts one fresh reviewer session.** It holds no state between
rounds, and it never edits the code under review. It is handed five things:

| | |
|---|---|
| **A working directory** | The round's snapshot of the head commit (The snapshot, below). |
| **The change** | Its name, `PR #41` or `the working tree`, the short sha of the base, its description, the files it touches, and the threads the reviewer opened on it, each with its replies and whether it is resolved. |
| **The charter** | The standing rules for a review. It ships with squiz and is the same every round. |
| **A thinking level** | `thinking` from `.squiz.json` (§ 10 Configuration), set on every run, so it never comes from the CLI's own configuration. |
| **A model** | `model` from `.squiz.json`, in the CLI's spelling, or none, which leaves the CLI on the user's default. |

**The prompt never carries the diff, and its size does not grow with it.** After
the description come a `## History` section, which points the reviewer to the
history tools, and a `## Changes` section, which lists the changed files one a
line as `git_diff` lists them: the status, the path, `old -> new` for a rename,
and `+N -M`, or `binary` for a binary file. The threads come last:

````markdown
# Review PR #41

## Description

Clamp the card's placement after the explanation expands.

## History

Call `git_log_search`, `git_blame` and `git_show` to find out whether a line was meant: which commit wrote it, and what that commit said it was for.

## Changes

The diff is not in this prompt. Call `git_diff` with a file's path to read that file's change. The change touches these files, each with its status and the lines it adds and removes:

```
M  src/reviewers/prompt.ts            +12 -3
A  docs/specs/review-harness/loop.md  +755
D  docs/specs/review-harness-spec.md  -3899
R  src/old.ts -> src/new.ts           +1 -1
```

## Threads already on this change

…
````

The reviewer reads each file's change with `git_diff`. No stage selects or
budgets the files it opens.

### The reviewer session

**The reviewer runs where a person can watch it**, in the first place that
applies:

| Where | How the round host starts it |
|---|---|
| Herdr, where `HERDR_SOCKET_PATH` is set | One `layout.apply` request on Herdr's socket opens an unfocused tab labelled `squiz-<number>-r<k>`, whose one pane runs the reviewer in the snapshot |
| tmux, where `TMUX` is set | `tmux new-window -d -n squiz-41-r2 -c <snapshot> -- <program> <argument>…` |
| Neither | Detached, as a child of the round host with no terminal, and a log holds its progress |

The reviewer here is the command the adapter builds: `pi` and its arguments, or
the Copilot adapter's `sh` line, which starts Copilot. No shell stands between
the backend and that command, so every argument reaches it byte for byte, and no
shell's startup files run.

**The Herdr tab opens in the coding agent's workspace.** A trigger records the
`HERDR_WORKSPACE_ID` in its environment where the value has the shape
`w<number>`, such as `w2`. The tab opens in the focused workspace where none was
recorded, or where Herdr answers `workspace_not_found` for it.

**Where a pane cannot be opened, the round host falls through** to tmux or a
detached child, and the round goes on. `squiz status` then shows the session as
`detached` (§ 7 `squiz status`). A Herdr socket nothing answers on is a pane
Herdr refused, and so is a reviewer program found nowhere on the round host's
`PATH`.

**The variables the round sets reach the reviewer on every backend**, over any
value the backend's own environment gives them. They are the adapter's, then the
GitHub variables under Tools, last. The reviewer runs on the round host's
`PATH`, not the Herdr server's. Everything else in its environment is the Herdr
or tmux server's.

**Each round keeps its reviewer session, and the command that resumes it**, in
`.squiz/<number>/rounds/<k>/resume.txt`. Its paths are relative to the coding
agent's worktree, and `squiz status` prints it:

```
pi --session-dir .squiz/41/rounds/2/session --session 0193f2c4-7d1e-7b52-9c1a-5e2f4d8a6b31
COPILOT_HOME=.squiz/41/rounds/2/session copilot --resume=99b4a257-0666-4e1f-a9a2-94d9c79b14be
```

A conversation resumed after the round is not part of the review.

**What a person types into a `pi` reviewer's pane reaches `pi`**, and nothing
records it. A Copilot reviewer's pane takes no input.

**A reviewer in a pane is stopped as a detached one is.** At the time bound
(§ 8 The review budget) the round host signals the reviewer's process group, and
then closes the pane.

### The snapshot

**The reviewer never reads the coding agent's worktree.** Before it starts, the
round host clones the repository into the system's temporary directory and
checks out, detached, the head commit of the state under review. Under the
GitHub venue that is the commit GitHub reports as the pull request's head. The
snapshot holds that commit alone: none of the coding agent's uncommitted
changes, untracked files, build output or installed dependencies. It appears in
neither `git status` nor `git worktree list`.

The path is `<temporary directory>/squiz-<uid>/<digest>-<number>/rounds/<k>/tree`,
where `<digest>` is the first 16 hex digits of the SHA-256 of the coding agent's
worktree path. **The round host refuses to make a snapshot where `squiz-<uid>`
is a link, is owned by another user, or is writable by group or others**, and
the round fails before the review.

**The change's diff is read from the snapshot.** It is byte for byte the diff
GitHub serves for the pull request, and no size of change is refused. A diff
that cannot be read fails the round before the review, and the snapshot is
removed:

```
no review ran: the diff of PR #142 could not be read: git exited 128: fatal: 7c1e0d3f2a4b5c6d7e8f90a1b2c3d4e5f6a7b8c9...HEAD: no merge base
```

**The round host removes the snapshot once the round has recorded its result**,
whatever the result, and before it takes the next queued state. It removes
nothing but the snapshot and the directories that removing it emptied, and it
does not need the coding agent's worktree to exist.

**A snapshot that cannot be removed stays on disk, and the round's result
stands.** `host.log` names its path and why:

```
2026-10-07T04:10:09.623Z round 1: the snapshot at /tmp/squiz-501/44df482132d16163-142/rounds/1/tree could not be removed: EACCES: permission denied, unlink '/tmp/squiz-501/44df482132d16163-142/rounds/1/tree/stuck/left'; it stays on disk until it is deleted
```

### Tools

**Every reviewer is granted the same tools, every round**, and no setting
changes them:

| | `pi` | Copilot |
|---|---|---|
| Reading | `read`, `grep`, `find`, `ls` | `view`, `grep`, `glob` |
| Reporting | `report_finding`, `report_verdict`, `finish_review` | `squiz-report_finding`, `squiz-report_verdict`, `squiz-finish_review` |
| History | `git_log_search`, `git_blame`, `git_show`, `git_diff` | `squiz-git_log_search`, `squiz-git_blame`, `squiz-git_show`, `squiz-git_diff` |

Nothing else is granted. Under `pi`, a call to any other tool is refused before
it runs. Copilot disables every other tool, `skill` and every shell tool among
them.

**Each history tool runs in the snapshot:**

| Tool | Takes | Returns |
|---|---|---|
| `git_log_search` | A term, matched as literal text | The commits that added or removed it, newest first, each with its message and the files it changed |
| `git_blame` | A file and a line | The commit that last changed that line, with its author and date, read from the commit and never the working tree |
| `git_show` | One commit | Its author, date, message and change. A range, a tree or a file at a revision is refused. |
| `git_diff` | A path, a `from`, or nothing | The pull request's own base...head range, and no other. With no path, the changed-file list the prompt carries, from file 1 or from `from`. With a changed file's path, under either name of a rename, that file's diff. With any other path, a line saying so. |

**The history tools are hardened against the repository they read.** No
argument reaches a shell or reads as an option. An empty argument, and one
holding a NUL, are refused. `git_blame` refuses an absolute path, a `..` path
out of the snapshot, and a path whose links resolve outside it. No config,
attribute or environment setting in or around the repository makes a history
tool run a program, read another repository or read another config.

**The reviewer has no GitHub credential of its own.** Under either adapter, the
round sets these before the reviewer starts:

| Variable | Value |
|---|---|
| `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN` | The empty string |
| `GH_CONFIG_DIR` | `.squiz/<number>/rounds/<k>/gh/`, emptied before the reviewer starts |

A `gh` the reviewer starts finds no login in its variables or its
configuration. `gh auth token` can still read the login in the system's
keychain, which is the login Copilot's last fallback signs in with (#529).

**Each CLI's model credential is left alone.** Copilot signs in from the first
of these it finds:

1. `COPILOT_GITHUB_TOKEN`, set from the token file where one is in use, over the
   round host's value.
2. A login of its own, from `copilot login`.
3. `gh`'s login.

**The token file is the `copilotTokenFile` that `.squiz.json` names, or else
`~/.config/squiz/copilot-token`**, where `~` is the home directory of the user
squiz runs as. A file cannot be used where it cannot be read, is empty, or holds
anything but one token.

| File | Where it cannot be used |
|---|---|
| The named `copilotTokenFile` | The round fails at setup, with a reason naming the file |
| The default file | The round runs as if the file did not exist. A default file that does not exist is passed over without a word. `squiz doctor` warns of one that cannot be used (§ 7 The setup check). |

**The token reaches only the environment of the Copilot it signs in.** The
reviewer's arguments carry the file's path, never the token, and no log, record,
reason, summary or failure comment holds it.

### Confinement

**The reviewer can change nothing the coding agent would commit, and read
nothing outside the code under review.** Each of these holds under both
adapters, every round, with no setting to change it:

- No granted tool writes, and none is a shell.
- A reporting call writes nothing on disk that the coding agent would commit.
- A reading tool refuses a path whose real path, every link resolved, is
  outside the snapshot's. Under Copilot the reviewer can read nothing else in
  the temporary directory.

**Nothing from the tree under review or the repository's local config reaches
the reviewer but `AGENTS.md`**, and for `pi`, `CLAUDE.md`. That leaves out:

- the repository's hooks, filters and `core.autocrlf`;
- the tree's `.pi/` configuration;
- the tree's Copilot hooks, MCP servers, instruction files, skills and agents.

No `pi` extension and no MCP server runs but squiz's own, and Copilot's
built-in GitHub MCP server is off. The charter is the Copilot reviewer's system
prompt, which a same-named agent in the tree cannot override. Of the user's own
Copilot configuration, only the default model and the signed-in user reach the
reviewer.

### Adapters

An adapter drives one reviewer CLI. `reviewer` in `.squiz.json` chooses `pi` or
Copilot.

**The reviewer runs at the thinking level `thinking` sets**, on every run, and
never at the CLI's own setting. `pi` runs a model that lacks the level at
another, which `squiz doctor` names (§ 7 The setup check). Copilot takes it as
its reasoning effort, with `off` as `none`.

**The reviewer runs on the configured `model`, in its CLI's spelling, or else on
the user's default.** Each adapter spells it and finds the default as its own
section says. A model the CLI does not offer fails the round at setup, with no
review run and nothing spent, and the reason names `model` and its value:

```
"model" in .squiz.json is "openai/gpt-5", which is not a model pi offers; it must be a provider and model as pi --list-models lists them, such as "openai/gpt-5-mini"
```

With no `model`, the reviewer's command line and environment are what they are
without the setting.

**A run that completed no message has a reason that adds what the reviewer said
on stderr**, in a pane as detached. Where the adapter recognises the cause, the
reason is the adapter's alone. The Copilot adapter recognises a reviewer that is
not signed in: a run whose stderr holds `Error: No authentication information
found.` gets a reason that quotes the line and names no model:

```
the reviewer is not signed in to Copilot: it said "Error: No authentication information found."
```

Where Copilot words it any other way, and under `pi`, the round gives its
ordinary reason, with what the reviewer said. That reason adds the model the run
was handed, configured or the user's default:

```
the reviewer completed no message; "model" in .squiz.json is "gpt-5-nano", which the reviewer's CLI may not offer
the reviewer completed no message; .squiz.json sets no "model", and the user's default, "gpt-6-astra", may not be one the reviewer's CLI offers
```

**Squiz checks every reporting call itself, whatever CLI serves it.** A
malformed call is refused when it is made, and the reviewer gets the reason as
the call's error, so it can call again. Every other report of the round stands.

**A round counts as reviewed only where the reviewer made the finish call**,
whatever ended the run afterwards, the time bound included. The CLI's exit
status is not read for how the run ended.

- A round that reported nothing and finished found nothing.
- A round with no finish failed.
- Reports arriving after the finish and before the CLI exits count.
- In a round its host ended, the findings reported before the ending are posted
  and its verdicts applied. What a round whose host died reported is not posted
  (§ 3 The round host).

A failed round stays failed. It hands no threads back, and it closes the episode
only where it spent the last of the round cap or the token bound (§ 3
Terminology, § 8 The review budget).

**Stopping the reviewer stops every process it started**, the history tools'
`git` included.

**Each round records its tokens and cost as its CLI reports them.** The models a
round names are the ones its run reported, in the order it first named each.

### The `pi` adapter

The adapter `reviewer` chooses by default.

**A configured model is `provider/id`, exactly as `pi --list-models` lists it**,
such as `openai/gpt-5-mini`. A bare id listed under one provider is refused, and
the reason gives its full name. A `pi` that cannot list its models fails the
round at setup.

**A `pi` round's cost is the sum of its assistant messages' usage.** It is a
floor, "at least", where:

- the run did not end on a message's usage;
- the time bound stopped the reviewer;
- the report file could not be read to its end.

**A run where no message ended normally and no finish was recorded completed no
message.** The round's reason is the errored message's error text, and the
reviewer is not run a second time.

**A report file with a line that cannot be read fails the round**, and the
reports already read stand.

### The Copilot adapter

The adapter `"reviewer": "copilot"` chooses.

**With no `model` configured, the user's default is `COPILOT_MODEL`** in squiz's
environment, or else `model` in the user's Copilot `settings.json`. With neither,
the round runs on whatever Copilot falls back to.

**A Copilot run auto-updates nothing and sends no client telemetry**, so it
reaches only Copilot's own host and its model's.

**A Copilot round's cost comes from its usage line**, and only where Copilot
exited 0 by itself with token counts. It is never a floor:

| Figure | Read as |
|---|---|
| Tokens | Input plus output, over every model |
| AI credits | `totalNanoAiu`, at 10⁹ to a credit |

Any other Copilot round records no cost and names no model.

**The reporting server goes on answering while a history tool runs.** It is the
MCP server the adapter ships to serve the reporting calls and the history tools. A
`notifications/cancelled` naming a running history tool stops its `git`, and
that call is not answered. The server exits when its standard input closes, and
on `SIGTERM` and `SIGHUP`.

### Findings

**A finding carries these fields:**

- `scope`: `line`, `file` or `change`, which decides where its comment goes
  (Pull request comments).
- `file` and `line`: the changed line the comment is anchored to. A `file`
  finding carries the file alone. A `change` finding carries the changed file it
  most concerns, and no line.
- `severity`: `high`, `medium` or `low`.
- `headline`: the problem, in one line.
- `reasoning`: bullets, one point each.
- `suggestedFix`: what to do about it.
- `reference`: optional.

| Severity | |
|---|---|
| `high` | Wrong now, a security problem, or a broken written convention |
| `medium` | Wrong under conditions the change makes reachable, or a test that passes with its code deleted |
| `low` | Real, narrow and survivable |

Findings are ordered `high` to `low`, and findings of one severity keep the order
the reviewer reported them in.

**Every round hands the reviewer every thread it opened on the pull request**,
resolved and open, from every episode. A thread is the reviewer's own where its
opening comment carries the reviewer's marker (§ 2 Identity), whoever replied
since. A thread a person opened is never handed over, ruled on, read or
answered, never counts as open, and never keeps the loop going.

**Each handed thread gets one verdict**, and a second verdict on one thread is
refused. A verdict carries `thread`, the identifier the thread was handed under;
`verdict`; and `reason`, which is required and non-blank on `open` and
`withdrawn`, and refused on `fixed`.

| Verdict | Where the thread was open | Where it was already resolved |
|---|---|---|
| `fixed` | A reply naming the round and the commit, then the resolve | The resolve, and no reply |
| `withdrawn` | A reply carrying the reason, then the resolve | The resolve, and no reply |
| `open` | A reply carrying the reason, every round it keeps the thread open | The thread is re-opened, with the reply |

A handed thread with no verdict is treated as `open`, with nothing posted, where
the reviewer finished. Where it did not finish, the thread is left as it was
handed over.

**A ruling's reply opens with the reviewer's marker and the verdict**, and never
counts as activity that starts another round. It is posted before the round
ends, and before the resolve on a thread the round closes. `fixed` reads
`Confirmed in round 2 at 1b86987.`, `open` is headed `still open` and carries
the reason alone, and a withdrawal carries the reason beneath:

```markdown
**Squiz reviewer · withdrawn**

Withdrawn in round 2 at 1b86987.

The retry count is bounded by the caller: `schedule()` in `queue.ts:40` stops at five attempts.
```

A ruling made in an attempt that spends no round names the commit and no round,
as `Confirmed at 1b86987.`

**Every finding posted as a thread ends its episode in one of four states:**

| Status | What it means | Needs a person |
|---|---|---|
| `fixed` | The defect was there and is gone | No |
| `withdrawn` | There was no defect | No |
| `open` | Unresolved, with no reply from the coding agent | Yes |
| `disputed` | Unresolved, and the coding agent replied | Yes |

### The comment format

**Every finding's comment is its marker and headline, its reasoning as bullets,
its suggested fix, and an optional reference.** The comment stands without the
reference:

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

### Pull request comments

**A finding's `scope` decides where its comment goes:**

| Scope | Thread |
|---|---|
| `line` | An inline thread on a changed line |
| `file` | A thread on its file, with no line |
| `change` | A thread on the changed file it names, with no line |

A finding about code the change did not touch is anchored to the changed line
that caused it, and its body names the affected file and line.

**A line anchor that cannot be placed is posted on its file**, with `file:line`
in the text. A finding whose file the diff does not carry reaches no thread. The
summary's Notes says it could not be anchored (§ 6), and `squiz review` prints
it on stderr.

**A `change` finding goes on any file the diff names**, a deleted file and a
rename that changed nothing included. One whose file the diff does not name is
posted on the first file the diff names, in the diff's order, with the file it
named in the text:

```markdown
**Where:** the change as a whole. The reviewer named `src/sync/helpers.md`, which the diff does not carry.
```

Only a diff that names no file, or one that cannot be read, leaves a `change`
finding on no thread. Notes then names it:

```markdown
- About the change as a whole: All seven new exported helpers lack the required tests (no thread could be opened for it)
```

**A thread on a file is a review thread like an inline one.** It is resolved,
re-opened, ruled on, carried across rounds and replied to as an inline thread
is. It counts as open for the exit status and the round cap until a verdict
closes it.

## 6. The summary

When an episode closes, squiz posts one summary comment on the pull request. It
carries the status of every finding, what each round did, and what the review
cost. It is never edited or replaced, so a second episode on the same pull
request posts a second comment. The local venue writes it to `summary.md`
instead (§ 4 The local venue).

A round that leaves threads open for the coding agent posts no summary. Nor does
a failed round that leaves a round to run: it posts its failure comment instead
(§ 8 The failure comment).

**A failed round that spends the last of the round cap or the token bound posts
the summary of the rounds that ran**, and then its failure comment. § 3 The
state file says how it records the close, and § 8 what `squiz review` exits for
it. The summary counts each thread the failed round gave no verdict by
the reviewer's last ruling on it (§ 3 The state file): a resolved thread last
ruled `fixed` or `withdrawn` counts as that ruling, and every other one counts as
`open`, or `disputed` where the coding agent replied. Its Notes end with this
line:

```markdown
- The budget ran out before the review could be completed: the last attempt failed, and spent the last of the round cap. A person needs to look at this change.
```

Where the token bound closed the episode, it reads "the last of the token
bound". Where states were queued behind the failed round, the line names them
before its last sentence, as "Squiz did not review 8d21a4f."

### What the comment carries

Four blocks, in this order.

1. **The counts, the spend and the reviewer.** Rounds run and findings raised,
   then how many findings ended `fixed`, `withdrawn`, `open` and `disputed`.
   Findings raised counts every thread of the episode, and every finding no
   thread holds that Notes lists. A finding no thread holds carries no status.
   The spend line and the reviewer line follow, as The format sets out.
2. **Needs a person.** Every `open` finding and every `disputed` one, with its
   headline and where it sits: `file:line` for a thread on a line, and the file
   alone for a thread on a file. Where there are none, the block says so in one
   line.
3. **Rounds.** Each round in the order it ran, with the short commit it reviewed,
   how many findings it raised, and the rulings it gave. A round that raised
   nothing and ruled on nothing reads
   `- Round 4 at 9a0b1c2: found nothing new and ruled on nothing`.
4. **Notes.** What the threads do not show, one line each, in this order:
   - each finding no thread holds, the earlier rounds' first and then the closing
     round's;
   - each thread the closing round kept open whose reason could not be posted;
   - each thread any round closed whose reply could not be posted, with the
     ruling;
   - each ruling of the closing round that could not be applied;
   - each round whose finished review never read the diff of a changed file;
   - each round the time bound cut short;
   - the cap or the bound, where one ended the episode, with each queued state it
     left not reviewed, or the line of a failed round that spent it, as above.

**A round's findings raised are every finding the reviewer reported**, whether
or not its comment was posted. **A round's rulings count, by verdict, each
`fixed` or `withdrawn` verdict on a thread that was open when it was handed
over, and every `open` verdict.** A verdict on a thread that was not handed
over, and a second verdict on one thread, are not counted.

**A finding no thread holds is named by its location**, or as "About the change
as a whole" for one scoped to `change`, and says why no thread holds it. A
finding of an earlier round that no later round raised again names the latest
round that raised it, and says only that. One a later round raised again is
listed once, as the later round's.

**A ruling that could not be applied says what the reviewer ruled**, so that a
person can apply it by hand. A thread that was handed over is named by its
location and headline, and one that was not by the id the reviewer gave. Each
line carries the verdict the reviewer gave:

- a `fixed` or `withdrawn` ruling GitHub refused ends
  `(ruled fixed, and the thread could not be resolved)`;
- an `open` ruling GitHub refused ends
  `(ruled open, and the thread could not be re-opened)`;
- a thread given no ruling that could not be re-opened ends
  `(given no ruling, which keeps it open, and the thread could not be re-opened)`;
- a second ruling on one thread, of any verdict, ends
  `(ruled open a second time, which was not applied: the first ruling stands)`;
- a ruling on a thread that was not handed over, of any verdict, reads
  ``- A ruling of withdrawn on thread `PRRT_kwDOAbc999`, which was not handed to the reviewer, was not applied``.

**A round whose finished review never read the diff of a changed file names the
files**, at most ten of them, followed by "and N more" for the N past ten. Each
name is one code span. A control character in it is shown escaped, a line break
as `\n`, and the span's fence is one backtick longer than any run of backticks in
the name. A round the time bound cut short has no such line.

**The line of a cap or a bound that ended the episode names it, and each state
left not reviewed** as § 3 The state file names them. Where nothing was queued,
the line ends after "rather than with nothing left open". Where the closing
round left nothing open and the bound left queued states not reviewed, it reads
"ended at the token bound with nothing left open, and did not review 3f9c2e0
with different replies".

### The format

```markdown
**Squiz review — 3 rounds, 10 findings**

Fixed 2 · Withdrawn 1 · Open 4 · Disputed 1
At least 48,200 tokens over 3 rounds: 20,100, at least 16,400, 11,700 · at least $0.0105 · at least 0.84 AI credits
Reviewed by `pi` on `openai/gpt-5-mini` in rounds 1 and 2, and by `copilot` on `gpt-5-mini` in round 3

**Needs a person**

- `src/cache.ts:30` — The key ignores the locale (open)
- `src/session.ts:57` — Clock skew is read as token expiry (disputed)
- `src/retry.ts` — Every path here is dead once the queue lands (open)
- `src/queue.ts:140` — The cap is never read (open)
- `src/queue.ts:88` — The retry limit is read before it is set (open)

**Rounds**

- Round 1 at 3f9c2e0: raised 6 findings
- Round 2 at 1b86987: raised 2 findings, and ruled 2 fixed, 1 withdrawn and 2 open
- Round 3 at 8d21a4f: raised 2 findings, and ruled 1 fixed and 2 open

**Notes**

- Raised in round 1 and not raised again: `src/cache.ts:12` — The cache is never cleared (no thread could be opened for it)
- About the change as a whole: The retry queue duplicates the scheduler (raised, and its comment could not be posted)
- `src/retry.ts` — Every path here is dead once the queue lands (kept open, and the reviewer's reason could not be posted on its thread)
- `src/queue.ts:134` — Retry backoff resets (ruled fixed, and the reviewer's reply could not be posted on its thread)
- `src/cache.ts:30` — The key ignores the locale (ruled fixed, and the thread could not be resolved)
- The reviewer finished round 1 without reading the diff of 2 changed files: `src/queue.ts`, `docs/a file.md`
- The review was cut short by the 900-second time bound in round 2, and the round kept only the findings it had reported by then
- The episode ended at its round cap rather than with nothing left open, and did not review 8d21a4f with different replies or 5e6f7a8
```

Notes is left out where there is nothing to report, and Rounds where the episode
ran no round.

**The spend line leads with the tokens**, which every round with a cost carries:
the total, the rounds it covers, and each round's own. The dollars follow where
the reviewer's CLI priced the model, and the AI credits, to two places, where it
reported them, as Copilot does. A round with credits carries no dollars, never
zero dollars. Each total covers the rounds that carry it, so a round run on a
subscription adds no dollars.

- **A figure that is a floor reads "at least"** (§ 5 The `pi` adapter): the
  floor round's own figure, and every total of an episode holding one.
- **A round that completed no assistant message reads "unknown"** in place of its
  tokens, never zero. A floor round among them still marks the totals. Where no
  round with a cost completed one, the line reads "No spend was reported"
  followed by the rounds it covers, as "No spend was reported over 2 rounds".
- **A round with no cost has no figure.** The line covers the rounds that have
  one, says how many those are, and names no round's own figure:
  `18,200 tokens over 1 of 2 rounds · 0.36 AI credits`. Where no round has a
  cost, there is no spend line.

**The reviewer line names the reviewer CLI each round ran and the models its run
reported** (§ 5 Adapters), never the `model` `.squiz.json` configures. Where
every round ran the same reviewer on the same models, it names them once, as
``Reviewed by `copilot` on `gpt-5-mini` and `claude-haiku-4.5` ``. Where the
rounds differ, it names each model with the rounds that ran on it, under the
reviewer that ran them, in the order the rounds first named each, as the example
does. A round that ran two models is listed under both.

A run that reported no model reads "an unknown model", and a round recorded with
no reviewer reads "an unknown reviewer". Each model is one code span, with every
run of whitespace in its name collapsed to a space. An episode that ran no round
has no reviewer line.

## 7. Commands

Everything squiz ships to be run is a subcommand of one binary, `squiz`. Squiz
ships no slash command, and the setup check is `squiz doctor`.

### The `squiz` binary

In Claude Code, the coding agent's Bash tool and a command a person types after
`!` run `squiz` by name. Every other shell, Copilot's included, runs it through
the link `squiz init` makes.

| Command | Run by | What it does |
|---|---|---|
| `squiz review <number>` | The coding agent, a coordinator, a CI job | Reviews the pull request, waits for the review, and prints what is open. Under the local venue it takes no number (§ 4). |
| `squiz status` | A person, a coordinator | Lists the reviews recorded in every worktree of the repository. |
| `squiz init` | A person | Links `squiz` onto `PATH`, and allows its commands in Claude Code's user settings. |
| `squiz doctor` | A person | Checks each dependency (The setup check). |
| `squiz version` | A person | Prints the version and path of the squiz that answers. `squiz --version` is the same command. |
| `squiz hook` | Claude Code, Copilot | The hooks' entry point (§ 3 The hooks). |
| `squiz host <number>` | A trigger, never a person | The round host (§ 3 The round host). |
| `squiz threads` | The coding agent | Lists the open threads of the change. |
| `squiz reply <id> <text>` | The coding agent | Replies on a thread. |

`squiz threads` lists the open threads of the change in the worktree it runs
in. Under the GitHub venue that is the open pull request whose head is the
branch checked out there. Under the local venue it is the threads in that
worktree's `.squiz/local/`, and the heading reads `<n> open threads on the
working tree`:

```
3 open threads on #185
PRRT_kwDOUEd2qM6mPuUP scratch/paging/pages.ts:26 high — pageCount drops the partial last page
PRRT_kwDOUEd2qM6mPuVO scratch/paging/pages.ts:34 high — pageAt starts every page one page too far
PRRT_kwDOUEd2qM6mPuWa scratch/paging/cursor.ts (whole file) medium — Paging duplicates the cursor the API already returns
```

Each line is the thread's identifier, its location, and the severity and
headline of the finding on it. The identifier leads the line undecorated, so
the line splits into identifier and rest at the first space. A thread on a file
as a whole is located as the file and `(whole file)`. A thread whose first
comment carries none of § 2 Identity's markers was opened by a person. It is no
finding, and its line is the identifier and the location alone.

`squiz reply <id> <text>` replies as the coding agent on a thread `squiz threads`
printed, in the same change. It refuses an id the change holds no thread for,
and posts nothing:

```
squiz: nothing replied in T9: threads.json holds no thread "T9"
```

### `squiz review`

`squiz review <number>` acts on the record of the pull request's current state
(§ 3 The state file) and waits for its review within the deadline § 8 sets.
Under the local venue it is `squiz review`, run in the worktree it reviews, and
every message names the change, its rerun and where the summary is as § 4 The
contract sets out. The exit status says what happened:

| Exit | What it means |
|---|---|
| 0 | A round reviewed this state and nothing is open. The episode is closed, and its summary is posted. Or the pull request is a draft. |
| 1 | The review could not run. |
| 2 | Threads are open, and rounds remain. |
| 3 | The round cap or the token bound closed the episode with threads open. Or it closed the episode without a round reviewing this state, whatever is open. Or a failed round closed it after this state's round left threads open. |
| 4 | The review goes on in the round host, and the run's wait ended first. |

These are the only statuses `squiz review` gives. A caller reads any other, such
as a crash or a command that could not start, as 1. Apart from a draft, exit 0
is given only for a state a round reviewed. A state answered with 3 is answered
with 3 for the run waiting on it and for every later run.

A run that exits 0, 2, 3 or 4 prints its outcome on stdout. A run that exits 1
prints nothing on stdout. stderr carries what failed (§ 8 The command's stderr),
and the line § 10 Configuration gives where no `.squiz.json` is found.

A run that exits 0, 2, 3 or 4 writes everything it prints on stdout to
`.squiz/<number>/review.txt`, replacing it on every run, and prints that path
first. Where the file cannot be written, the outcome and the exit stand, and
stderr adds:

```
squiz: the output could not be written to /work/squiz/.squiz/41/review.txt: EACCES: permission denied
```

Every number and every thread in the output is as it stands on the pull request.
Each open thread is printed as its `squiz threads` line, followed by its comments
indented two spaces, the first without its first line. Threads open, exit 2:

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

Fix what applies in /work/squiz, and reply on each thread with
`(cd '/work/squiz' && squiz reply <id> <text>)` to say what you changed or why
you disagree. Commit and push what you changed, then run `squiz review 41` again.
```

A run handed a result it did not produce heads it `Squiz already reviewed PR #41
at 3f9c2e0: round 1 of 3, 2 new findings.`, and prints the threads as they stand
on the pull request now.

Nothing open, exit 0: the heading is `Squiz reviewed PR #41 at 8d21a4f: round 2
of 3, no new findings.`, and the paragraph after it is `Nothing is open. The
review is closed, and its summary is on the pull request.`

A draft, exit 0: the run prints only `PR #41 is a draft. Squiz reviews it once
it is marked ready for review, so there is nothing to wait for.`, and writes no
file. The hooks write nothing for a draft. Once it is marked ready for review,
the next trigger queues its state as any other.

Closed with threads open, exit 3: after the round's heading, the paragraph is
``The round cap is reached. The review is closed with 1 thread open, and its
summary is on the pull request. A person takes it from here, so do not run
`squiz review 41` again.``, and the open threads follow. Where the token bound
closed the episode, the paragraph begins "The token bound is reached".

Closed before a round reviewed the run's state, exit 3: a line after the
round's heading says why, as `Squiz did not review PR #41 at 8d21a4f: the
episode closed at the round cap, after reviewing 3f9c2e0.`, and the paragraph
says "with nothing open" where nothing is.

Closed by a failed round, exit 3: the round reviewed nothing to head the
output, so the line saying why it failed is the heading, as `Squiz did not
review PR #41 at 3f9c2e0: the reviewer was killed at its 900-second bound, and
the round recorded no findings.`, and stderr says where its failure comment
went. Where the close has no summary on the pull request, the paragraph does not
claim one. A run whose own state a round reviewed and left threads open before
the failed round closed the episode is handed the same close, rather than its
own exit 2, because nothing reviews a push after the cap. Its stderr carries the
closing round's summary problems, where its failure comment went, and the "not
known" line below where that round's host stopped before recording them.

Still reviewing, exit 4: the run prints one of these lines after the path.

- Its state's round is running: ``Squiz is still reviewing PR #41 at 3f9c2e0. Run `squiz review 41` again to wait for it.``
- Its state is queued behind an older one's round: ``Squiz is reviewing PR #41 at 3f9c2e0 first, and 8d21a4f is next. Run `squiz review 41` again to wait for it.``
- Its state was reviewed clean and a later one is queued: ``Squiz found nothing open in PR #41 at 3f9c2e0, and is reviewing 8d21a4f before it closes the review. Run `squiz review 41` again to wait for it.``
- Its state was superseded (§ 3 The state file): ``Squiz is reviewing PR #41 at 8d21a4f instead of 3f9c2e0. Run `squiz review 41` again to wait for it.``
- A failed round closed the episode and is still posting its summary (§ 3 The round cap), which every run on the episode waits for so that what the posting came to reaches its stderr: ``Squiz has closed the review of PR #41 and is still posting its summary. Run `squiz review 41` again to wait for it.``

A run on an episode that has already closed prints the close, whatever the round
cap or the token bound would now allow. The line names the head the close was
reached on, as `Squiz's review of PR #41 closed at 3f9c2e0 after 2 rounds, with
nothing open. Only a new head commit starts another review in this worktree.` A
clean close is printed this way, with exit 0, only for its own head and for a
failed state it recorded. Where the round cap or the token bound closed it, the
line ends `No round runs again in this worktree.` instead. Where threads are
open, the line counts them, the run exits 3, and the threads follow.

The one wait on a closed episode is for a failed round's close that is still
posting its summary: the run waits until the round host records what the
posting came to, then prints the close. Where the host is known to have
stopped, because no process holds the episode's host lock or the one that held
it is gone, nothing will record the posting. The run reads the state once more,
in case the host recorded it just before stopping, and otherwise prints the
close at once at exit 3, and stderr adds `squiz: the review of PR #41 closed,
and whether its summary was posted is not known: the round host stopped before
recording it`. A run that cannot tell whether the host is running keeps
waiting.

The review could not run, exit 1. Each reason is one line on stderr, and § 8's
line to stop ends the output. Where the round host's start cannot be told, the
run waits on a live host. Where no host takes the review, the state stays
queued and the run prints:

```
squiz: no review ran: whether the round host for PR #41 started could not be told, and none has taken the review since: the intermediate process exited 1: spawn node ENOENT
squiz: `squiz status` shows whether one takes it later, and .squiz/41/host.log holds what the host wrote
squiz: put these lines in your report rather than running squiz review again
```

The other reasons take the same form:

- A failed round prints `squiz: review failed: <reason>`, with the reason its
  failure comment gives (§ 8 The failure comment), then `squiz: the failure is
  posted on PR #41`.
- A run that failed before any round, or could not reach GitHub, prints
  `squiz: no review ran: <why>`, as `squiz: no review ran: PR #41 is closed`.
- A run whose state's round reached a result, but which cannot list all the
  threads that result prints, prints `squiz: the threads on PR #41 could not all
  be listed to print the review of 3f9c2e0: <reason>`, and posts nothing. A
  listing that fails after its first page, or runs out of time, is one that
  could not list them. Exit 1 stands where the run's deadline passed during the
  listing.
- A run after this worktree pushed waits up to 60 seconds, or until its
  deadline where that comes first, for GitHub to report a head containing the
  pushed commit, and acts on that head. Where GitHub does not, the run queues
  nothing and prints `squiz: no review ran: PR #41 still has 3f9c2e0 as its head
  after 60 seconds, though this worktree pushed 8d21a4f to it`. Commits not
  pushed, a head pushed from elsewhere, and a branch with no push destination
  are taken as GitHub reports them. The hooks never wait.

A round that left threads open and has findings no thread holds keeps exit 2.
On stderr it prints the count it could not post, where any failed to post, then
each finding as § 6's Notes write it:

```
squiz: round 1 could not post 1 of its 3 findings to PR #41
squiz: round 1 raised this on no thread: `src/sync/queue.ts:90` — The queue is never drained (no thread could be opened for it)
```

### `squiz status`

`squiz status` takes no argument. It lists every review recorded in any worktree
of the repository, one line per pull request state. It starts nothing and asks
nothing of GitHub.

```
PR   Commit   Replies  State      Started           Elapsed  Result                                                                       Session           Worktree                          Resume
#41  9e01b2c  OmQx7a   queued     —                 —        —                                                                            —                 .claude/worktrees/agent-a5336e10  —
#41  8d21a4f  OmQx7a   reviewing  07:13:05          3m 12s   —                                                                            tmux squiz-41-r3  .claude/worktrees/agent-a5336e10  —
#41  3f9c2e0  OmQx7a   reviewed   07:06:02          2m 40s   1 thread open                                                                tmux squiz-41-r2  .claude/worktrees/agent-a5336e10  pi --session-dir .squiz/41/rounds/2/session --session 0193f2c4-7d1e-7b52-9c1a-5e2f4d8a6b31
#39  77e0f19  —        reviewed   2026-10-04 07:20  4m 05s   1 thread open, review closed at the token bound, 2 of 5 findings not posted  detached          .claude/worktrees/agent-a3c91e07  pi --session-dir .squiz/39/rounds/3/session --session 0193f1b2-4d6e-7a1c-9b3f-2c8d5e7f9a14
  the review of PR #39 closed without its summary: gh: HTTP 502 Bad Gateway
#38  a1b2c3d  —        failed     2026-10-04 06:40  8m 00s   the reviewer was stopped at the time bound                                   detached          .claude/worktrees/agent-a077fff7  pi --session-dir .squiz/38/rounds/1/session --session 0193f1a0-2c4b-7e9d-8f3a-1b6c5d7e9f02
```

Each column holds:

- **PR:** the change's key, as § 4 The contract prints it.
- **Replies:** the last six characters of the identifier of the latest activity
  the state was read with, or `—` for none.
- **State:** the record's status. A reviewing record whose round host has gone
  is `killed`. One whose host cannot be told running or gone is `reviewing`,
  and its Result is "the round host could not be checked:", then why. A state
  the episode closed before reviewing is `not reviewed`.
- **Started:** in local time, the time of day for a round started today, and
  the date and minute otherwise. A reviewing record shows its reviewer's start
  once the reviewer has started, and its round host's start before then.
- **Elapsed:** the time so far for a running review, and from start to end for
  a finished one. A killed review, a state no round started, and a state that
  failed before a round took it show `—`.
- **Result:** for a failed state, the reason its failure comment gives. For a
  state not reviewed, why not. For a reviewed state, how many of the reviewer's
  threads are left open, then "review closed", "review closed at the round cap"
  or "review closed at the token bound" where it closed the episode, then the
  count of findings GitHub refused, as "2 of 5 findings not posted". Only the
  count is shown. The round's record and `squiz review`'s stderr hold each one.
- **Session:** the backend and the label `squiz-<number>-r<k>` (§ 5 The
  reviewer session). A record that keeps no `k` shows the backend alone. A
  detached reviewer is `detached`, and a state with no reviewer started is `—`.
- **Worktree:** the path relative to the main worktree, `.` for the main
  worktree itself.
- **Resume:** the round's `resume.txt` once the round is over, or `—`.

Every cell is one line: a line break, with the whitespace around it, prints as
one space. A reviewed state's problems, the failures that did not change its
outcome, follow its line, one line each, indented two spaces, and never widen a
column.

The lines are ordered by:

1. Episodes with a state queued or under review first.
2. Then the latest start or end time any of the episode's records carries.
3. Then the higher pull request number.

Within an episode, the newest state comes first. A closed episode a later one
replaced, in `episodes/<n>/` (§ 3 The state file), is listed as an episode of
its own under the same PR and worktree, with its Resume read from
`episodes/<n>/rounds/<k>/resume.txt`.

A state file that cannot be read, or an `episodes/` directory that cannot be
listed, gets a line on stderr naming the pull request, the worktree and what
was wrong, and every other worktree is still listed. A worktree git lists that
is gone from disk prints nothing. Where nothing is recorded and every state file
was read, stdout is `No review is recorded in any worktree of this repository.`
Where a state file could not be read and nothing else was listed, stdout is
empty.

### `squiz init`

`squiz init` links `squiz` onto `PATH` and allows its commands in Claude Code's
user settings, printing a line for each. It runs inside a repository or outside
one, and writes nothing in the repository.

```
squiz: linked /Users/ana/.local/bin/squiz to /Users/ana/.claude/plugins/cache/tools/squiz/0.2.0/bin/squiz, in place of /Users/ana/.claude/plugins/cache/tools/squiz/0.1.0/bin/squiz, an earlier version of this install
squiz: allowed Bash(squiz review *), Bash(squiz threads) and Bash(squiz reply *) in /Users/ana/.claude/settings.json
```

Its exit status is the link's alone: 0 where the link is in place afterwards,
and 1 otherwise, with the link's line on stderr. A settings file it could not
change puts its line on stderr too, and leaves the exit as the link set it.

**The link** goes in `~/.local/bin`, or else `~/bin`: the first of the two that
is on `PATH` and is a writable directory. No directory is created and no shell
startup file is edited. The link holds the real path of the running
`bin/squiz`. A squiz is a `bin/squiz` whose plugin's `.claude-plugin/plugin.json`
names it `squiz`.

Every `squiz` already on `PATH` is read first, and decides the outcome. Nothing
named `squiz` that is not this squiz is replaced, or shadowed by a link put
ahead of it.

| Already on `PATH` | `squiz init` |
|---|---|
| A link to this squiz | Changes nothing, and says so. |
| A link to another version of the same plugin-cache install, `plugins/cache/<marketplace>/squiz/<version>/bin/squiz`, whether or not that version is still there | Moves the link to this version, wherever it is on `PATH`. |
| This squiz's own `bin/`, which Claude Code puts on its shell's `PATH` for an enabled plugin | Ignores it. |
| A link to another squiz checkout or install | Makes no link, names it, and says to remove it and run `squiz init` again. |
| Another squiz's own `bin/` | Makes no link, and says to run `squiz init` by name in that session. |
| Anything else named `squiz`, or a link to something missing | Makes no link, names it, and leaves it alone. |
| Nothing, and neither directory can take the link | Makes no link, and says to add `~/.local/bin` to `PATH`. |

**The permission rules** are `Bash(squiz review *)`, `Bash(squiz threads)` and
`Bash(squiz reply *)`, added to `permissions.allow` in the `settings.json` of
Claude Code's configuration directory. That directory is `$CLAUDE_CONFIG_DIR`
where it is set and not empty, and `~/.claude` otherwise. Where
`CLAUDE_CONFIG_DIR` is set, `~/.claude` is never used.

- Only the rules missing are added, after those already there. Every other key
  and rule keeps its value. A missing file, `permissions` object or `allow` list
  is created, and a file already holding all three rules is not written.
- A file that cannot be read, is not JSON, is not a JSON object, or whose
  `permissions` is not an object or `permissions.allow` not a list is left as it
  is. The line names the file and says which, as `squiz: allowed nothing in
  /Users/ana/.claude/settings.json: its permissions.allow is not a list`.
- A `settings.json` that is a symlink is written at its target, and stays a
  symlink.
- Where the configuration directory does not exist, nothing is written or
  created, and the line on stdout says Claude Code's configuration was not found
  there, as `squiz: allowed nothing: Claude Code's configuration was not found
  at /Users/ana/.claude`. A `CLAUDE_CONFIG_DIR` that is not an absolute path, or
  neither it nor `HOME` set, writes nothing, with the line on stderr.
- A file already holding all three prints `squiz:
  /Users/ana/.claude/settings.json already allows Bash(squiz review *),
  Bash(squiz threads) and Bash(squiz reply *); nothing changed`.

### `squiz version`

`squiz version` and `squiz --version` print one line, and exit 0:

```
squiz 0.1.0 /Users/ana/squiz/bin/squiz
```

The version is the one in the running squiz's `.claude-plugin/plugin.json`, and
the path is the real path of its `bin/squiz`. Neither is read from the working
directory or from `PATH`. Where `plugin.json` cannot be read, is not JSON, names
another plugin or names no version, the command prints nothing on stdout, says
why on stderr, and exits 1:

```
squiz: the version of this squiz could not be read: /Users/ana/squiz/.claude-plugin/plugin.json could not be read: ENOENT: no such file or directory, open '/Users/ana/squiz/.claude-plugin/plugin.json'
```

### The setup check

`squiz doctor` runs inside a repository or outside one. It prints one line per
dependency, and exits 1 where any line failed:

```
git 2.51.0
Venue github (/Users/ana/app/.squiz.json)
gh 2.97.0, signed in as ana
Claude Code 2.4.1
copilot 1.0.92, experimental features on
Node 24.6.0
tmux: not found. Not required: without tmux or Herdr, reviews run detached
Herdr 0.9.3
squiz link: /Users/ana/.local/bin/squiz already links to this squiz
Reviewer pi 0.85.1 (/Users/ana/app/.squiz.json), model deepseek/deepseek-v4-pro, pi's default: warning: thinking medium runs at high on this model, which offers only off, high and max
```

Each line is at one of three levels, and only `failed` changes the exit status:

| Level | Meaning |
|---|---|
| present | Usable, or an optional tool that is absent |
| warning | Seen, and squiz runs without it |
| failed | A required dependency is missing, unusable or unauthenticated |

A tool answers where it is found on `PATH` and prints its version when asked.
The rows print in this order:

| Row | Required | Present where |
|---|---|---|
| `git` | Yes | It answers. |
| The venue | Yes | `.squiz.json` reads as a round reads it. |
| `gh` | Under the GitHub venue | It answers, and `gh auth status --json` reports an account whose check succeeded. |
| Claude Code | Only where `copilot` is missing or cannot be run | It answers. |
| Copilot as a coding agent | No, and printed only where `copilot` is on `PATH` | It answers, `"experimental"` is `true` in `<COPILOT_HOME>/settings.json`, and its socket path fits (§ 10 Getting started). |
| Node | Yes | The Node running squiz is 24 or later. |
| tmux, Herdr | No | It answers. |
| The `squiz` link | No, and never a failure | `PATH` holds a link to this squiz. Anything `squiz init` would refuse or change is a warning. |
| Copilot's copies of squiz | No, and printed only where Copilot has one | Each copy under `<COPILOT_HOME>/installed-plugins/` is this squiz's version. Each copy at another version is a warning. |
| The reviewer | Yes | Its CLI answers, its model and sign-in check pass as below, and for `pi` the model runs at the configured thinking level. |

The venue's row and the reviewer's row name the main worktree's `.squiz.json`
after the venue or version, as `(/work/squiz/.squiz.json)` where it was read and
`(no /work/squiz/.squiz.json)` where it was not. Under the local venue the row is
`Venue local (/work/squiz/.squiz.json): reviews run on the working tree, and gh
is not required`.

The reviewer is the one `reviewer` names in `.squiz.json`, or `pi` outside a
repository or without the file. Its row names the model a round would run on:
`model` from `.squiz.json`, or else the user's default from the reviewer CLI's
own settings, or else unknown. CLI settings that cannot be read are a warning
for `pi` and a failure for Copilot.

For `pi`, wherever the row names a model, it ends with the thinking level a
round runs at, read without a model request. A level that matches the
configured one ends the line, as `; thinking medium`. A level that differs is a
warning naming the configured level, the level it runs at and the levels the
model offers. A level `pi` does not report is a warning with the reason.

For Copilot, sign-in is checked by one prompt, which spends one request on the
model the row names, or names no model where it is unknown. The prompt runs as
a round's reviewer would run, signing in from the token file a round would use
(§ 5 Tools), and the row says which source it signed in with: the token in
`copilotTokenFile`, the token in the default file, or Copilot's own login. A
`copilotTokenFile` that cannot be used fails the row without running Copilot. A
default file that exists and cannot be used is a warning naming it, and the
prompt runs on Copilot's own login. A model the account cannot use fails the
row, with the reason Copilot prints. The token is never printed:

```
Reviewer copilot 1.0.105 (/Users/ana/app/.squiz.json), model gpt-6-astra, from .squiz.json. Signed in with Copilot's own login; the check spent one request on gpt-6-astra: warning: the Copilot token file /Users/ana/.config/squiz/copilot-token is empty
```

## 8. Failure modes

**A run that could not review exits 1**, unless its round's failure closed the
episode, which exits 3 (§ 3 The round cap). A failure that leaves the round's
outcome standing keeps the outcome's status, 0, 2 or 3, and adds a line on
stderr.

**No failure is silent.** Every failure reaches at least one of these:

- **The failure comment** on the pull request, below.
- **`squiz status`** (§ 7).
- **`.squiz/<number>/host.log`**, which holds a line for each thing the round host
  did. It is the only surface for what the host does outside a round.
- **`squiz review`'s stderr**, below.
- **The summary's Notes**, written by the round that closes the episode (§ 6).
- **The hook's stderr**, one line for what a stop firing could not do.

**A failure reaches the pull request once the round has found its pull request
and can read the episode's state.** From then on a failure posts a failure
comment where GitHub can be reached, and the problems of a round that closes the
episode go into its summary's Notes. A failure before that posts nothing. A round
that fails in the round host is recorded failed with its reason, which
`squiz status`, `squiz review`'s stderr and `host.log` show.

**A `gh` that ran and failed is reported by the status it exited with and the
first line it wrote.** A `gh` that could not run is reported as one that could
not run.

**A throw in the harness is trapped.** A command writes one line on stderr for
it. Inside a round it fails the round, which is recorded failed with the throw as
its reason and posts no failure comment. In the round host outside a round it
ends the host, and the round the host held reads as killed. The hook exits 0, as
it does on every path.

| Failure | What happens |
|---|---|
| Squiz cannot read or write its own files: the configuration, the state file, the queue, or the reviewing record. Or git cannot name the worktree or its branch | Exit 1, naming the file and the error, and no review runs. What already landed stands, and nothing more is posted. A queue write that fails queues nothing and starts no round host. A reviewing record that cannot be written records the state failed, and the state stays queued only where that write fails too. Any other state not yet taken stays queued. A state file missing a field its writer always writes cannot be read, and the reason names the field: `/work/squiz/.squiz/41/state.json: round 1 has "raised" as undefined`. |
| The round's rulings and spend cannot be written | Exit 1. Nothing the reviewer found is posted, and no verdict is applied. |
| The round's end cannot be written | Exit 1. No summary is posted, and the episode reads as open, so the next run reviews the pull request again. |
| The round's result cannot be recorded | What the round posted stands. `host.log` names the result and the reason, and `squiz status` shows the round killed. A `squiz review` waiting on it exits 4 at its deadline. A later run exits 1, saying the round host stopped before its round ended, unless the round closed the episode. |
| A round's posting time or resume command cannot be written | The round's result stands. A round with no resume command saved shows `—` under Resume in `squiz status`. |
| The reviewer is not installed, or ends without completing a message | Exit 1, and the failure comment and stderr say why, as a setup problem rather than a bad round. What the reviewer reported is posted. |
| The reviewer's output cannot be read, and a retry does not recover it | Exit 1, and the failure comment and stderr say why. What the reviewer reported is posted. |
| The reviewer stops without finishing its review | Retried once where the time bound leaves time for it. Both attempts post what they reported. Where the retry fails too, exit 1, and the failure comment says the review was never finished. |
| The reviewer's pane cannot be closed | The pane stays open, and `host.log` says so. |
| GitHub cannot be reached, or `gh` cannot run | Exit 1, and no review runs. stderr names the call. Nothing is posted, and nothing is stored to retry. A trigger queues nothing. |
| The threads cannot all be listed, or a call before the review runs out of its time | Exit 1, and no review runs. A failure comment is posted where GitHub still accepts one. A lookup that ran out of time is never read as no pull request. |
| GitHub refuses a comment, a verdict or the summary | Nothing is retried. What landed stays, and the round's outcome stands. |
| A verdict names a thread not handed over, or a second verdict names one thread | The verdict is not sent, and the first verdict stands. |
| GitHub refuses a verdict | The thread stays as it was handed over, and the round counts it that way. |
| Some comments fail to post | stderr gives the count, and a later round makes the rest. |
| A round found findings and posted none | The round failed, whatever its verdicts did. Exit 1 with the reason `round 2 found 3 findings and could not post them to PR #41`, a failure comment, and no summary. A later trigger retries the state where a round remains. |
| The summary cannot be posted | The episode closes all the same, with exit 0 or 3. stderr says it closed without its summary and names GitHub's answer, on this run and on every later run on the closed episode. `squiz status` and `host.log` show it too. |

Where squiz cannot write the round's rulings and spend, or its end, the failure
comment, stderr, `squiz status` and `host.log` each name the write that failed.

Each verdict not applied is named, with GitHub's answer, on `squiz review`'s
stderr, in `squiz status`, in the round's record and in `host.log`. The closing
summary's Notes or the failure comment names it too, without GitHub's answer.
Each comment that failed to post is listed the same way, in the closing summary
or in the failure comment.

A round that spends the last of the round cap or the token bound closes the
episode even where it failed, as § 6 says.

Some failures are stated with the part of squiz they belong to: a round host that
dies (§ 3 The round host), a pane that cannot be opened (§ 5 The reviewer
session), a snapshot that cannot be removed (§ 5 The snapshot), and a round
host whose start cannot be told or a push GitHub does not report (§ 7
`squiz review`).

### The failure comment

A failed round posts one issue-level comment on the pull request, after the
findings it salvaged, and posts it even where it salvaged nothing. The comment is
never edited, and each failed round posts its own. It opens with a bold headline
whose reason is word for word the one `squiz review` prints on stderr. It says
what happens next and how many of the salvaged findings were posted as threads.
A list follows of each salvaged finding no thread holds and each ruling not
applied, written as the summary's Notes write them (§ 6 What the comment
carries).

Where a round remains under the round cap and the token bound, the comment says
the review is still open, and that a new commit or reply, or `squiz review`,
retries it:

```markdown
**Squiz review failed — the reviewer was killed at its 900-second bound, and the round kept the 3 findings the reviewer had reported**

1 of the 3 findings the reviewer reported is posted as a thread. The review is still open. A new commit or reply, or running `squiz review` again, retries it.

- `src/cache.ts:12` — The cache is never cleared (no thread could be opened for it)
- About the change as a whole: The retry queue duplicates the scheduler (raised, and its comment could not be posted)
```

Where no round remains, the failed round has closed the episode and posted its
summary first (§ 6), and the comment says which bound closed it:

```markdown
The review is closed: it has run 3 rounds, and the round cap allows 3. No round runs again. Its summary is on the pull request.
```

At the token bound it reads `The review is closed: it reached the token bound of
10,000,000 tokens.`, then the same two sentences. Where the summary could not be
posted, it ends at "No round runs again."

Where GitHub cannot be reached, nothing is posted. A run that waited on another
run's round, or was handed a result already recorded, posts nothing.

### The command's stderr

`squiz review` writes one line on stderr for each thing that failed, each
prefixed `squiz: `. A run that exits 1 ends its stderr with the line telling the
coding agent to stop:

```
squiz: review failed: round 3 found 3 findings and could not post them to PR #142
squiz: the failure is posted on PR #142
squiz: put these lines in your report rather than running squiz review again
```

A run where nothing failed writes nothing on stderr, except the line saying the
defaults are in use (§ 10 Configuration).

### The review budget

A review is bounded per round by time, `timeout`, and by tokens, `tokens`
(§ 10 Configuration).

**At the time bound the reviewer is killed**, the findings it reported so far are
posted, and the round is recorded failed. The failure comment and stderr say how
many findings arrived. For a `pi` reviewer they add how many messages it
completed, the bound's seconds averaged over them, and how many requests its
provider failed. Where the machine slept during the review, they end with "the
machine slept for 13 minutes of the round". The summary that closes the episode
notes the cut. A round that already holds the reviewer's finish, with every
report read back, is the review it declared instead: it posts no failure comment,
and exits 0, 2 or 3.

**A round runs in the round host, outside any caller's timeout.** The time bound
is on the review alone. Before and after the review, each call the round makes
has 30 seconds of its own, and the round makes every call it has, however long
the ones before it took. A call that pages is one call, and its pages share its
30 seconds. No call to GitHub may take more than 30 seconds, and that is not
configurable. A call that reaches it while the round posts is one comment that
failed to post rather than GitHub being unreachable: the comments that landed
stay, and the round exits as its outcome says.

**Time the machine sleeps during the review is added back to the time bound**, at
most the bound itself in one round, so no review runs longer than twice its
bound. The calls outside the review, and `squiz review`'s wait, count sleep as
they count any other time.

**`squiz review` waits within one deadline of 540 seconds**, counted from its
start. A run whose round ends first returns the round's result, 0, 2 or 3, or 1
with the reason the round recorded, and posts no second failure comment. Listing
the threads that result prints has at least 10 seconds, past the deadline where
less of it is left. A run whose deadline arrives first exits 4, and a run stopped from outside, by a person
or the coding agent's tool, ends with no status of its own. Either way the round
goes on in the round host, and the next run returns its result.

**Every attempt's tokens count against the token bound, whether or not it was a
round.** A reviewer that ran is charged what its report file says, however its
attempt ended. An attempt is charged a floor, zero where the file reports none,
where it was a start that failed after the reviewer may have run, or one the
harness threw out of. A tmux window, and a child whose identity could not be
read, may have run. A failed Herdr start spends nothing. A Copilot usage line is
kept as Copilot's total, a Copilot round with no cost counts nothing, and dollars
and AI credits bound nothing.

**The bound is read when an attempt records what it spent**, and the attempt that
reaches it closes the episode, whether it reviewed or failed. A round that
reviewed closes with a summary saying the bound was reached, rather than that the
reviewer failed. The bound never stops the running round.

## 9. The project

### Language

Squiz runs as installed, with no build step and no compiled output. Node 24 or
later runs its TypeScript directly, and the `squiz` command is `bin/squiz`, a
shell script that runs the `.ts` entry point under Node. The one JavaScript file
is the Copilot extension, `extension.mjs`, which imports only Node's own modules
and the `@github/copilot-sdk/extension` that Copilot supplies.

Squiz has no runtime dependencies. Everything outside its own process is a
subprocess: `git`, `gh`, `ps` and the reviewer's CLI.

Squiz runs on macOS and Linux, and on Windows under WSL.

## 10. Adoption

### Installing

This repository is squiz's marketplace for both Claude Code and Copilot.
`.claude-plugin/marketplace.json` names the marketplace `squiz` and lists one
plugin, squiz, whose source is the repository's root, at the version
`plugin.json` carries. Each runtime adds the marketplace as `jacygao/squiz` and
installs the plugin as `squiz@squiz`, with the commands the README gives under
Install.

Every coding agent but Claude Code runs `squiz` through the link `squiz init`
makes (§ 7 `squiz init`), which is made once per machine. Where Claude Code has
squiz enabled, the user types `! squiz init` in a Claude Code session. Where only
Copilot has it, the user runs it from Copilot's copy:

```
<COPILOT_HOME>/installed-plugins/squiz/squiz/bin/squiz init
```

After updating squiz in Claude Code, the user types `! squiz init` again, in a
session started after the update. Until then, `! squiz doctor` warns about the
link.

### Getting started

**A Claude Code or Copilot coding agent needs no instruction to be reviewed,**
and nothing in the project's `AGENTS.md`. The plugin's hooks start a review each
time the agent finishes its work (§ 3 What starts a round).

The coding agent runs three `squiz` commands without being prompted. Claude Code
needs nothing per project for them, because `squiz init` allowed them in the
user's settings. A Copilot session is started with
`copilot --allow-tool='shell(squiz)'`.

**Squiz's Copilot support is experimental.** The user turns on Copilot's
experimental features once, with `copilot --experimental` or `/experimental on`.
Every Copilot session of a user who installed squiz then loads squiz's hooks and
its wake extension. Where the session's socket path,
`<COPILOT_HOME>/session-state/<session id>/squiz.sock`, is longer than 104 bytes
on macOS or 108 on Linux, the extension cannot listen, and says so in the session
as a warning.

### Configuration

Every squiz process reads one optional `.squiz.json`, at the root of the main
worktree of the worktree it acts on. The main worktree is the one
`git worktree list --porcelain` names first. Squiz never reads the reviewed
worktree's own `.squiz.json`, so every worktree of a repository has one
configuration.

Every setting has a working default. Where the main worktree holds no
`.squiz.json`, the first line `squiz review` writes on stderr says so, whatever
the outcome, and the outcome is the same as with the file. A round host writes
the same line to `host.log`:

```
squiz: no .squiz.json was found in the main worktree, /work/squiz, so the defaults are in use
```

A bare repository has no main worktree, so in one of its linked worktrees there
is no `.squiz.json`, and the line says so. A git that cannot name the main
worktree is a configuration that cannot be read.

| Setting | Default | |
|---|---|---|
| `venue` | `github` | Where reviews happen, `github` or `local` (§ 4 Choosing the venue) |
| `reviewer` | `pi` | The reviewer CLI, `pi` or `copilot`. It chooses the adapter and nothing else |
| `rounds` | 3 | The round cap, settable 1 to 8 |
| `timeout` | 900 | Seconds one round's reviewer may run, settable 60 to 3,600 |
| `tokens` | 10,000,000 | Tokens one round may spend, settable 100,000 to 10,000,000 |
| `thinking` | `medium` | How hard the reviewer thinks, one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `model` | none | The model the reviewer runs on, in its CLI's spelling: `provider/id` for `pi`, such as `openai/gpt-5-mini`, and the model's name for Copilot, such as `gpt-5-mini`. None runs the reviewer on the user's own default (§ 5 Adapters) |
| `copilotTokenFile` | none | The absolute path of a file holding the token the reviewer's Copilot signs in with. None reads the token from `~/.config/squiz/copilot-token` where that file exists, and otherwise leaves Copilot to its own login (§ 5 Tools) |

`model` is up to 200 letters, digits and `.` `_` `:` `/` `@` `+` `-`, starting
with a letter, a digit or `@`. An empty string is refused rather than read as
none.

`copilotTokenFile` is an absolute path of up to 4,096 characters. The file it
names, and the default file, each hold the token alone, of letters, digits and
`_`, and the spaces, tabs and line ends around it are dropped.
Either file is read where a Copilot reviewer starts, and by `squiz doctor`. A
value that is not such a path is refused with an error that leaves the value
out:

```
/work/squiz/.squiz.json: "copilotTokenFile" must be the absolute path of a file holding a token for Copilot; leave "copilotTokenFile" out for ~/.config/squiz/copilot-token or Copilot's own login
```

A setting outside its range, or of a type the table does not give it, is refused
with an error naming the setting, the value given and what was expected. A key
the table does not name is refused with an error saying it is not a setting, and
listing the settings there are. Where `.squiz.json` cannot be read or parsed, the
command exits 1, and its stderr names the file.

## 11. Human intervention

**Squiz is built for the unattended path.** The coding agent and the reviewer
settle a review between them. A person reads the result, and steps in where the
review ends with a thread that needs one (§ 5 Findings) or a failure only a
person can fix (§ 8).

### What squiz handles

Each of these is specified in the section named:

- A person's reply on one of the reviewer's threads is activity, and the next
  round reviews it (§ 3 The state file).
- A thread a person opens is never read or answered, and never keeps the loop
  going (§ 5 Findings).
- A pull request marked draft is not reviewed until it is marked ready
  (§ 7 `squiz review`).
- A pull request closed, or another branch checked out in the worktree, gets no
  review, and `squiz review` says why (§ 3 A round, step by step).
- Stopping `squiz review` while it waits leaves the round running in the round
  host, and the next run returns its result (§ 8).
- A branch moved back to a commit that a cleanly closed episode recorded answers
  from that record, and nothing is reviewed again (§ 3 The state file).

### Everything else

**Any other change a person makes while a review runs has no specified
behaviour,** whether to the pull request, the branch, the working tree or
squiz's own files. Squiz does whatever its code does with it. Each such case is
recorded on #819's list, and none is built for.

**The one exception: squiz never reports a review of a commit it did not
review.** `squiz review` exiting 0 about a head no round reviewed is a defect,
and is fixed, whatever a person did to cause it.
