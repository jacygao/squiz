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

The loop runs the review from end to end. A coding agent finishes its work on a
pull request, or runs `squiz review <number>`, and a round starts: a reviewer
reads the change in a session of its own, and its findings go onto the pull
request as threads. The session that owns the work is told the result. It works
the threads, replies and pushes, and the next round starts, until nothing is
open or the round cap is reached.

### Terminology

| Term | What it is |
|---|---|
| **Episode** | One review of one pull request in one worktree, from its first round to its close. A worktree holds one live episode at a time, and keeps the episodes before it. |
| **Round** | One turn of an episode: one review of the pull request as it stands. |

An episode is **live** until its close is recorded. Nothing else makes it live
or over: not whether a round is running, and not how long ago anything
happened. It closes for one of three reasons: nothing is left open for another
round to work, the round cap is spent, or a round reached the token bound. A
round that failed posts a failure comment under § 8, and the episode stays live
unless that round spent the last of the round cap or the token bound. Then the
failed round closes it, as The round cap sets out.

A close is **clean** where the round that closed it left nothing open and no
state behind it not reviewed. A state the clean-closed episode never recorded,
on a head other than the one the close reviewed, starts a new episode in the
same worktree, as The state file sets out. Every other close is at the round cap
or the token bound, and stays closed.

### The state file

**An episode is keyed by the number of its pull request.** Its state lives in
`.squiz/<number>/` inside the worktree. The directory holds the state file, which
the rest of this section describes, and:

- `rounds/<k>/`, for each round: `prompt.md`, the task prompt the reviewer is
  handed, the report file the reviewer reports into, the reviewer's session,
  `resume.txt`, the command that resumes that session, and `gh/`, the empty `gh`
  configuration the reviewer runs with (§ 5 Tools). The snapshot the reviewer
  reads is in the temporary directory instead (§ 5 The snapshot).
- `notes/`, the notes for the sessions that own the work, under The report.
- `host.log`, the round host's output.
- `state.lock`, held while the state file is changed.
- `episodes/<n>/`, for each closed episode a later one replaced, numbered from 1
  in the order they closed: its state file, its `rounds/` and the local venue's
  `summary.md` (§ 4 The record), moved there when a new head starts a new
  episode, as set out below.

**`.squiz/` keeps itself out of git.** Wherever squiz makes an episode's
directory and `.squiz/.gitignore` is missing, it writes one holding `*`. One that
exists is left as it is.

**Every change to the state file is made under `state.lock`.** A writer takes the
lock, reads the file, changes it, writes it whole, and releases the lock. The
lock is held for one update and never across a review. It names its holder's pid
and start time, and a lock whose holder has gone is taken over. A writer that
finds the lock held by a live process, or by one that cannot be told running or
gone, waits up to a deadline of its own and never breaks the lock. A wait that
runs out is a state file that cannot be written (§ 8). The deadline bounds only
the wait: a lock taken is used, even where the deadline passed while it was
being taken, as it can on a loaded machine whose `ps` is slow. Readers take no
lock.

**The state file also holds one record for each state of the pull request the
episode has reviewed.** A state is two things, read when a trigger starts:

- **The head commit**, as GitHub reports it for the pull request.
- **The latest activity on the reviewer's threads.** Activity is a reply from
  anyone other than the reviewer, on a thread the reviewer opened: a comment after
  the first in that thread, carrying no `**Squiz reviewer · ` marker. The coding
  agent's replies are activity, and so is a person's. A thread a person opened
  holds no activity, whatever is said on it. The latest activity is the GitHub
  identifier of the newest such reply on the pull request, or none. An edited
  reply keeps its identifier and changes nothing. A deleted one can change which
  reply is newest, and that is a change like any other.

Each record has one of five statuses:

| Status | What it records |
|---|---|
| Queued | A trigger asked for a review of this state, and no round has started it. |
| Reviewing | A round host is running the round. The record names the host, and once the reviewer starts, the reviewer's session and snapshot, so that a recovery can find and stop them. |
| Reviewed | The round's result: its exit status and the threads it left open. A round that left nothing open while a later state was queued behind it records *reviewed clean, episode open* instead, with no exit status. That record gets exit status 0 where it later closes the episode, when the state behind it is superseded by it. A round that left the episode open also records each finding no thread holds, as § 6's Notes would give it. |
| Failed | Why the round failed, and whether its owner has had a note about it. |
| Not reviewed | Why no round reviewed it: the episode closed first, or a later state superseded it. |

A record of a round that started also holds what `squiz status` prints for it
(§ 7).

**A state file missing a field its writer always writes cannot be read**, and is
treated as any state file that cannot be read is (§ 8). Those fields are
`spentOutsideRounds`; each round's `reviewer`, `elapsedSeconds`, `head`, `raised`
and `ruled` (§ 6); the number of a reviewing record's round; and a reviewed
record's round and its count of new findings. The reason names the field:

```
/work/squiz/.squiz/41/state.json: round 1 has "raised" as undefined
```

**A trigger reads the record for the pull request's state before it queues
anything.** It has looked up the pull request and listed its threads by then,
because the state is read from them.

- **No record:** the trigger queues the state, and starts a round host where
  none is running.
- **Failed:** a hook queues nothing. `squiz review` queues the state again,
  because running the command is the request to retry it.
- **Reviewing**, by a round host that has gone: the trigger recovers the round, as
  The round host sets out, which records it failed. It then does what it does for
  a failed state.
- **Queued:** the trigger queues nothing, and starts a round host where none is
  running.
- **Reviewing**, by a round host that is running: the trigger queues nothing.
- **Reviewing**, by a round host no one can tell running or gone: the trigger
  recovers nothing, queues nothing and starts nothing, because recovering a round
  whose host may be alive would stop a live reviewer and remove its snapshot.
  `squiz review` exits 1 naming the host it could not check, and a hook returns.
  The next trigger checks again.
- **Reviewed, or not reviewed:** the trigger queues nothing. `squiz review`
  returns that result, with the threads read from the pull request as they stand
  now.

`squiz review` then waits, as § 8 sets out, and the hooks return at once.

**A failed state is retried only when someone runs `squiz review`.** A hook
firing on it queues nothing, so a turn spent reading a failure note does not
bring the failure back. The retry queues the state behind every state already
queued or recorded, as a state queued for the first time is, so the records
stay in the order their rounds ran. A retry that fails again posts its failure comment,
exits 1 and writes no second note, and its stderr tells the coding agent not to
run the command again (§ 7 `squiz review`). A new commit or reply is a new state, and is queued like any other.

**One state gets one review.** A trigger for a state already queued or under
review queues nothing, so two firings for one commit and the same replies post
one set of threads and at most one summary. An episode runs one round at a time,
oldest queued state first.

**A state accepted into the queue is never dropped.** It is reviewed, or it is
given a result of its own. Say state A is under review and state B, a later
commit, is queued behind it:

| A's round ends with | What happens to B |
|---|---|
| Threads open, rounds remaining | B is reviewed next, as usual. |
| Nothing open, rounds remaining | The episode does not close. A is recorded as *reviewed clean, episode open*: no exit status, no summary, and no note for its owner. B is reviewed next, and the episode closes from the last round with nothing queued behind it. Where B is superseded by A, A is that round, as below. A run of `squiz review` waiting on A goes on waiting, for the state the queue ends on, and returns that state's result: 0 or 3 with the close, or 2 where B left threads open. It exits 4 where its wait runs out first. |
| The round cap reached, or the token bound | The episode closes, as it must, and posts its summary. Its Notes name the cap or the bound and each state left not reviewed, whether A left threads open or nothing. B is recorded as not reviewed, with the reason. A run of `squiz review` waiting on B is handed the close with a line saying why B was not reviewed, and exits 3, whether A left threads open or nothing. B's owner gets a note saying the same. |
| A failure that spent the last of the round cap or the token bound | The episode closes as in the row above, and A is recorded failed, carrying the close. B is recorded as not reviewed with the reason "the episode closed at the round cap before a round took this state", or "at the token bound". A run of `squiz review` waiting on A or on B is handed the close, and exits 3. |

The line comes right after the heading of the close the run is handed:

```
Full output, to read where this is cut short: /work/squiz/.squiz/41/review.txt
Squiz reviewed PR #41 at 3f9c2e0: round 3 of 3, no new findings.
Squiz did not review PR #41 at 8d21a4f: the episode closed at the round cap, after reviewing 3f9c2e0.
```

Where the token bound closed the episode, its reason reads "the episode closed at
the token bound, after reviewing 3f9c2e0".

**A round reviews the pull request's newest state, and only that.** When the
round starts, the round host checks that its state still has the pull request's
head commit and latest activity. A state the pull request has moved past is
superseded: no review runs, nothing is posted, and it is recorded not reviewed,
naming the state that superseded it as § 6's Notes do:

```
superseded by 8d21a4f
superseded by 3f9c2e0 with different replies
```

The record also holds that state's head commit and latest activity, because
other states can share its short commit. The round host queues nothing. A
trigger queues the newer state, and since a hook does not wait, a state
superseded after a hook queued it is queued by the next trigger. A run of
`squiz review` waiting on a superseded state follows the state that superseded
it and returns that state's result. Where that state has no record, the run
reads the pull request afresh and acts on its record as any trigger does. It
exits 4 where its wait runs out first, as § 7 shows.

**A state reviewed clean can close the episode when the state behind it is
superseded by it.** Say A was reviewed clean with B, a reply, queued behind it,
and the reply is deleted before B's round starts. The pull request is at A again,
so B is superseded by A. A closes the episode where all of these hold:

- no round has run since A's, whether it reviewed or failed;
- none of the reviewer's threads is open on the pull request;
- nothing else is queued.

A is then the last round with nothing queued behind it. Otherwise B is recorded
superseded, and the episode stays open for the next commit or reply. No reviewer
runs for a close on A, and nothing is spent against the round cap. The close is
recorded first, as for any round. The summary is then posted
as § 6 sets out for a close on a state reviewed clean. A's record then becomes a
reviewed result with exit status 0 and no threads open, carrying the summary's
problem where it was not posted, and A's owner gets the note of any close. A
run of `squiz review` waiting on A or on B returns A's close.

**A round decides its close and records it in one step.** It reads the queue
under `state.lock`, decides from it as the table above sets out, and writes the
close in that same update, before it posts the summary. A clean close also
records, in that update, the state its round reviewed. A trigger that comes
after the close reads it before it queues anything, so no state queued while
the summary is posted is stopped by a close it arrived before. A failed round
that closes the episode (The round cap) also writes the close before it posts
the summary. The same update records the state the round took as failed,
carrying the close, and every state queued behind it as not reviewed, so a run
that reads the state while the summary is posted is handed the close. That
close is never clean.

**A state left not reviewed is named by its short head commit, followed by "with
different replies" where an earlier state has the same commit.** The earlier
states are the one the round that closed the episode reviewed, or took where it
failed, and those queued ahead of it:

```
Squiz did not review PR #41 at 3f9c2e0 with different replies: the episode closed at the round cap, after reviewing 3f9c2e0.
```

**The state file keeps the reviewer's last ruling on each thread**, by the
thread's node id: `fixed`, `withdrawn` or `open`. A close whose round gave the
thread no verdict counts it by that ruling (§ 6). A round writes its rulings in the update that
records its cost, before it posts anything, so no verdict reaches a thread unless
its ruling is on record. A state file that will not take that update fails the
round with nothing posted. A thread a finished review gave no verdict is kept as
`open`. A failed round writes the rulings it salvaged, and leaves every other
thread's alone. A ruling is kept whether or not GitHub then takes it.

**A close at the round cap or the token bound stays closed in its worktree.** A
new commit or reply queues nothing, and `squiz review` prints the close (§ 7).
A second episode on the same pull request starts in another worktree on the same
branch, which holds no state for it.

**A clean close stays closed for the head it reviewed, and for every state it
recorded.** The clean close records how many of the state file's records are the
closed episode's. A trigger acts on any other state as follows:

- **No record, on a head other than the one the close reviewed:** the trigger
  queues the state after the closed episode's records, for a new episode, and
  starts a round host where none is running. A run of `squiz review` waits on it,
  as on any other state.
- **A record the closed episode wrote, on another head**, as a force-push back to
  a head it reviewed leaves the pull request: the trigger queues nothing, and
  `squiz review` returns that record's result, which names its own head.
- **A record queued after the close:** the trigger acts on it as on any record. A
  hook leaves a failed one failed, and `squiz review` queues it again.
- **New replies on the head the close reviewed**, and a failed record the closed
  episode wrote: the trigger queues nothing, and `squiz review` prints the close.

No trigger queues a state the closed episode recorded, so its records keep their
places, and every record after them is the next episode's.

**The round host starts the new episode in the update that takes its first
state.** Under `state.lock`, it finds the close clean and a state queued after
the closed episode's records. In that one update it:

1. Writes the closed episode's state file, holding the closed episode's records
   in their order, to the next `episodes/<n>/state.json`.
2. Moves `rounds/` to `episodes/<n>/rounds/`, and rewrites each round's
   `resume.txt` to name the session where it now is. It moves the local venue's
   `summary.md` to `episodes/<n>/summary.md`.
3. Writes a fresh state file in its place: no rounds, nothing spent outside them,
   the reviewer's rulings carried over, and every record after the closed
   episode's, in their order. It takes the oldest queued one as round 1.

A round host that finds a round of the closed episode still recorded under
review starts no new episode, because that round's reviewer may still run and
its snapshot stands at the path the new round of that number takes. It records
each state queued after the close failed, and `squiz review` retries it as any
failed state:

```
no review ran: round 1 of the closed episode is still recorded under review by round host 4242
```

The new episode has its own round cap and token bound, and posts its own summary
when it closes. It reads the reviewer's threads from the change as any episode
does, so the closed episode's threads, and the rulings on them, are part of it.
Everything else in the directory belongs to the worktree and stays where it is:
`notes/`, `host.log`, the locks, and the local venue's files other than
`summary.md`. Where the archive cannot be written, the closed episode is left as
it was, and the round host records the state it took failed with the reason.

`host.log` says where the closed episode went:

```
2026-11-08T09:14:02.511Z a new episode starts on a state the clean close never recorded: the closed one is in /work/squiz/.squiz/41/episodes/1
```

A run of `squiz review` whose state's record, or whose close, moved into an
archive before it read it reads it there.

### A round, step by step

1. **Gate on the pull request.** The trigger checks that pull request `<number>`
   is open, that it is not a draft, and that its head branch is checked out in
   the directory it was run in, not another branch or a detached HEAD. The round
   host checks again when the round starts that the pull request is open and
   checked out. Where a check fails, no review runs, nothing is posted, and
   nothing is written to `.squiz/`.

   Where the pull request is not open or not checked out, `squiz review` exits 1,
   and stderr names what it found:

   ```
   squiz: no review ran: PR #41's head is "feature-a", and "/work/squiz" has "main" checked out
   ```

   Where it is a draft, `squiz review` exits 0 and prints one line on stdout
   saying so (§ 7 `squiz review`), and the hooks say nothing. Once it is marked
   ready for review, the next trigger queues its state as it would any other.
2. **Gate on the episode.** An episode that has reported its close is over:
   `squiz review` prints the close, naming the head it was about, whatever the
   round cap or the token bound would now allow. It exits as the close did for
   the state a round reviewed, and 3 for a state no round reviewed, as § 7
   `squiz review` sets out. After a clean close, a state on another head is the
   exception, and is queued or reported from its record as The state file sets
   out. Otherwise the record for the pull request's state decides whether it is
   queued.
3. **Run the reviewer.** The round host starts the reviewer in a session of its
   own (§ 5). It hands the reviewer the pull request and the threads the reviewer
   opened on it, in a snapshot of the state's head commit.
4. **Post the findings, and act on the verdicts.** Each new finding opens a
   thread, anchored to a file and a line or to a file as a whole (§ 5 Pull
   request comments). `fixed` and `withdrawn` reply on their thread and close
   it. `open` re-opens the thread or
   leaves it open, and replies with the reviewer's reason. § 5 Findings gives
   each reply.
5. **Record the open threads.** Where threads are open and the round cap is not
   reached, the round records the result and tells the session that owns the
   work (The report). A run of `squiz review` waiting on it prints the open
   threads and exits 2 (§ 7). A thread a person opened is never counted, so it
   never keeps the loop going.
6. **Close the episode.** Otherwise the round closes the episode, unless nothing
   is open and a later state is queued behind it, as The state file sets out. It
   records the close in the same update that read the queue, then posts one
   summary comment. `squiz review` exits 0 for the state the round reviewed
   where nothing is open. It exits 3 where the cap or the token bound closed the
   episode with threads open, and for a state the close left not reviewed,
   whatever is open.

The coding agent replies on a thread to say what it changed, to disagree, or to
ask a question, and never closes one. Only the reviewer's verdict closes a
thread, so a closed thread means the reviewer read the code as it now stands and
accepted it.

### The round cap

The cap defaults to 3 and is settable from 1 to 8. A cap of R hands open threads
back to the coding agent at most R−1 times.

**A reply is ruled on even where no commit follows it.** A coding agent that
disputes a finding and pushes nothing asks for a review again on a new state, and
the round reads its reply and rules on the thread: `withdrawn` where the argument
holds, `open` where it does not. A reply posted while a round runs is not in that
round's state, so the next run reviews again.

**Every round counts against the round cap, whatever started it.** A round that a
reply started is a round, exactly as one a commit started. A coding agent that
answers every finding with a dispute spends the cap doing so, and the episode
closes at the cap with the disputes for a person. A run that returns a recorded
result is no round and spends nothing.

**Round R is the closing round.** It reviews as any round does, then closes the
episode whatever is still open: it posts the summary and hands nothing back to
the coding agent. With a cap of 1, the first round is the closing round. Where
it leaves threads open, a new commit or reply after it queues nothing, and
whatever is left open is a person's. Where it leaves nothing open and nothing
behind it not reviewed, its close is clean, and a new head starts a new episode.

**The round that spends the last of the cap or the token bound closes the
episode, whether it reviewed or failed.** A failed round counts against the cap
as any round does, and every attempt's tokens count against the token bound,
whether or not it was a round (§ 8 The review budget). A failure that leaves no
round to run records the close, posts the summary (§ 6), and then posts its
failure comment (§ 8). A failure that leaves a round to run closes nothing. No
trigger closes an episode: one that comes after a close finds it, and runs
nothing.

### What starts a round

**A round starts when a trigger queues a state and the round host takes it.**
The triggers are the plugin's `Stop` and `SubagentStop` hooks, under Claude Code
and Copilot alike, and `squiz review <number>`, which a coordinator or a CI job
can also run from a checkout of the pull request's branch. In a runtime with no
hook, only `squiz review` starts a round.

### The round host

**The round host runs the rounds of one episode, one at a time, outside every
trigger's process.** It is `squiz host <number>`. A trigger that queues a state
starts one where none is running, detached so that it outlives the shell call or
hook that started it: a double fork with `setsid` between the forks, standard
input on `/dev/null`, and output in `.squiz/<number>/host.log`.

It takes the oldest queued state, writes the reviewing record naming itself, and
runs the round as the steps above set out. It exits when nothing is left queued,
and when the worktree it serves is gone.

**A host that finds nothing queued reads the queue again once its lock is
released.** A trigger that queued a state before the release saw the host
running and started none. A state found on that second read is taken by taking
the lock again, and where another host holds the lock by then, the state is left
to that host.

**One round host runs per episode.** It holds `.squiz/<number>/host.lock`, which
names its pid and start time. A host that finds the lock held by a live process
exits at once, so two triggers that each start one leave one running.

**A host that died is found by its pid and start time.** The next trigger starts
a host for any queued state. A reviewing record whose host has gone is a killed
round, and its reviewer may still be running, because a reviewer is not the
host's child.

**Recovery stops the orphaned reviewer before anything replaces it.** Every
trigger, and every round host as it starts, recovers each killed round it finds:

1. It reads the reviewer's session from the reviewing record: its backend, its
   pane or window, its pid and start time.
2. Where that reviewer is still running, it stops it as a round host stops a
   reviewer at its bound: the reviewer's process group, then the pane. It does so
   whether or not the reviewer's time bound has passed, so an orphan past its
   bound is always stopped by the first recovery to find it.
3. It confirms that the reviewer is gone, by pid and start time and by asking
   the backend for the pane.
4. Only then does it remove the snapshot and record the round as failed, with
   the reason "the round host died". No failure comment is posted.

A recovery that cannot confirm the reviewer is gone leaves the snapshot and the
record as they are, and starts nothing for that state. `squiz review` exits 1
naming the process it could not stop, and the next recovery tries again.

**Nothing stops an orphan before a recovery runs.** While no host is alive, the
reviewer's time bound is enforced when the next trigger or `squiz review` runs,
and not before.

### The hooks

**Squiz registers `squiz hook` on Claude Code's `Stop` and `SubagentStop`, on
its `SessionStart` and `SubagentStart`, and on its `UserPromptSubmit`.** `Stop` fires when a regular
session's turn ends, and `SubagentStop` when a subagent's does. Each stop
firing resolves the pull request whose head is the branch checked out in the
payload's `cwd`, records the session that owns the work, queues the state as The
state file sets out, and returns. It never runs a round
and never blocks the agent: it exits 0 whatever it found. Where it finds no pull
request it writes the line under step 1 naming the branch and the directory.
Where it finds a draft it writes nothing.

**The worktree comes from the payload's `cwd`, never from the directory the hook
process runs in.** Under Claude Code the two are the same directory. Copilot runs
a plugin's hook in the plugin root, so the hook's own directory is the plugin
checkout. A payload with no `cwd`, or with one that is not an absolute path,
queues nothing, and the hook says so on stderr. So does a `cwd` that is in no git
worktree.

```json
"Stop": [
  { "hooks": [ { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/bin/squiz\" hook" } ] }
],
"SubagentStop": [
  { "hooks": [ { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/bin/squiz\" hook" } ] }
],
"SessionStart": [
  { "hooks": [ { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/bin/squiz\" hook" } ] }
],
"SubagentStart": [
  { "hooks": [ { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/bin/squiz\" hook" } ] }
],
"UserPromptSubmit": [
  { "hooks": [ { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/bin/squiz\" hook" } ] }
]
```

**`SessionStart` and `SubagentStart` hand the worktree to the venue's
`recordStart` (§ 4 The base), and do nothing else.** They resolve no pull
request, record no owner and queue nothing. The GitHub venue records nothing at
a start, so under it these two firings change nothing. Claude Code and Copilot
both fire them from the plugin, each with a `cwd`, before the session or the
subagent does any work. A start hook takes its worktree from the payload's `cwd`,
as the stop hooks do. A start whose `cwd` is in no git repository records nothing
and writes nothing on stderr, because both runtimes fire it for every session,
wherever it is opened.

**`UserPromptSubmit` hands the payload's `prompt` and its worktree to the
venue's `recordPrompt` (§ 4 The record), and does nothing else.** It takes
the worktree from the payload's `cwd`, as the other hooks do, and prints nothing
on stdout, where Claude Code would add it to the session's context. Under the
GitHub venue it changes nothing. Both runtimes fire it from the plugin before the
session works on the prompt. Claude Code 2.1.321 fires it under that name alone.
Copilot 1.0.110 fires it from the plugin's `hooks.json` as well as its own
`userPromptSubmitted`, which squiz does not register. Each sends the prompt in
`prompt` and the directory in `cwd`:

```json
{"hook_event_name":"UserPromptSubmit","session_id":"51445ba2-2e4c-4c6b-943f-5ee4107e1dd9","timestamp":"2026-11-13T13:14:57.072Z","cwd":"/work/suss-task","prompt":"Add backoff. The first retry is immediate."}
```

Two prompts are not handed on:

- **A subagent's brief.** Copilot fires `UserPromptSubmit` for the prompt a
  session gives its subagent, with the subagent's `agent_id`, in the parent's
  `cwd`. A payload carrying a non-empty `agent_id` records nothing and says
  nothing. Claude Code 2.1.321 fires none for a subagent.
- **A prompt in no git repository.** It records nothing and says nothing, as a
  start does.

A payload with no `prompt`, or with an empty one, queues and records nothing,
and the hook says so on stderr. A `recordPrompt` that fails says
`no prompt was recorded:` and the reason, on stderr. Neither line carries the
prompt. The reviewer loads no squiz plugin, so no squiz hook fires in its
session.

**The plugin root is quoted in the command, so a root with a space in its path
stays one word.** Claude Code runs the command under `/bin/sh` and Copilot under
`/bin/bash`, and the registration has to hold under both.

| Event | The owner of the work it records |
|---|---|
| `Stop` | The session itself, from the payload's `session_id`, and its `CLAUDE_CODE_MESSAGING_SOCKET` where the hook's environment carries one |
| `SubagentStop` | The session that dispatched the subagent, from the payload's `session_id`, and its `CLAUDE_CODE_MESSAGING_SOCKET` where the hook's environment carries one; and the subagent, from its `agent_id` |

**GitHub Copilot CLI runs the same registrations from the plugin, and the
socket the hook records under it is the plugin's extension's.** Copilot fires the
plugin's `Stop` and `SubagentStop` with Claude Code's payload fields, and the
owner and the subagent come from the same fields as in the table. A firing is
Copilot's where the hook's environment carries `COPILOT_CLI` with any value but
the empty string.

- **The socket is `squiz.sock` beside the owner's transcript.** The payload's
  `transcript_path` is `<COPILOT_HOME>/session-state/<session id>/events.jsonl`,
  and the extension listens in that directory. The hook takes the socket from
  there only where the transcript's session is the payload's `session_id`.
- **The hook records it only once a connection to it is accepted, within one
  second.** It connects and closes without writing. A session started without
  experimental features has no extension, and a socket file left by a killed
  extension refuses the connection. Either way the hook records no socket, and
  the owner is recorded with its session id alone.
- **A `CLAUDE_CODE_MESSAGING_SOCKET` in the hook's environment is never
  recorded.** Copilot puts no socket there.

Both hooks return as soon as they have queued, under Claude Code and Copilot
alike. The result reaches the owner later, through the wake The report sets out.

**A `SubagentStop` firing whose `agent_type` is empty is no subagent's work.** In
an interactive session, Claude Code fires several of them after a turn ends, each
with a new `agent_id`, the parent's `session_id`, and no transcript. The hook
does nothing for one: it resolves nothing, records no owner and queues nothing.

**A `Stop` firing whose `session_id` is not the session its `transcript_path`
names is a subagent's turn.** Copilot fires one just before that subagent's
`SubagentStop`, carrying the subagent's id and the parent's transcript. The hook
does nothing for one, and the `SubagentStop` that follows queues the work. Only
a Copilot transcript path, `<COPILOT_HOME>/session-state/<session id>/events.jsonl`,
names a session, so a Claude Code `Stop` is never dropped by this rule.

### The report

**The result goes to the session that owns the work and is still alive.** For a
regular session's work that is the session itself. For a subagent's work it is
the session that dispatched it.

When a round records its result, the round host writes a note for the owner
recorded on the state, in `.squiz/<number>/notes/<session id>/`, one file per
note. Each field is one `key=value` line, and a backslash, line feed or carriage
return in a value is written as `\\`, `\n` or `\r`:

```
to=60517e1f-e1dc-49b1-8e39-6fcbe686f3fb
pr=41
head=3f9c2e07b1d4a8c6e5f0923b7a1d6c4e8b2f5a90
subagent=a402ef8f56c1b2ed1
text=Squiz reviewed PR #41 at 3f9c2e0, the work of subagent a402ef8f56c1b2ed1: 2 threads are open:\n\nPRRT_kwDOL7tYbc5abcd1 packages/sync/src/queue.ts:134 high — Retry backoff resets on every enqueue\n  - `enqueue()` calls …
```

`subagent` is there only where a subagent did the work. A failed state gets one
note, however many times it fails, and a state not reviewed gets one saying why.
A state no hook recorded an owner for gets no note.

**A note for open threads carries them.** Just before it writes the note, the
round host lists the review threads on the pull request. The note prints those
the round left open that are still open, each as `squiz review` prints it (§ 7),
in the order GitHub lists them. Where threads remain open with rounds left, the
text, decoded, reads:

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

Where the episode closed with threads open, the first line reads `the episode has
closed with 2 threads open:`, and the threads end the text, with no paragraph
after them.

- **At most 10 threads.** Where more are open, the note prints the first 10 and
  ends with a line counting the rest: ``3 more threads are open. `squiz review 41` prints them all.``
- **A listing that fails leaves a pointer.** Where the threads cannot be listed,
  or the listing holds none of those the round left open, the note counts them
  and points to `squiz review` instead. `host.log` says which of the two it
  was, and for a failed listing, why it failed:

  ```
  text=Squiz reviewed PR #41 at 3f9c2e0: 2 threads are open. Run `squiz review 41` to read them.
  ```

A round that closed the episode with nothing open says so and points to
`squiz review` for the close.

For a round that failed, the text gives the reason and names `squiz status`.
Where a round remains under the round cap and the token bound, it says that a new
commit, or running `squiz review` once, retries it:

```
text=Squiz could not review PR #41 at 3f9c2e0: the reviewer could not run: the provider refused the credential. `squiz status` lists it. A new commit, or running `squiz review 41` once, retries it.
```

Where no round remains, the text ends as the failure comment does, saying the
review is closed and which bound closed it (§ 8 The failure comment).

**Then it wakes a Claude Code owner through its messaging socket.** Where the
hook recorded a socket for the owner, the round host moves the note into
`delivered/` beside it and posts the text to the socket, and an idle session
starts a turn with it. The post is one JSON line,
`{"type":"user","message":{"role":"user","content":"<text>"}}`, on a connection
the host ends, and nothing is read back.

**A Copilot owner is woken through the plugin's extension.** Copilot loads
extensions only with its experimental features on, so squiz's Copilot support
is experimental as a whole, and § 10 has the user turn them on. Copilot starts
`extensions/squiz-wake/extension.mjs` in each session. It listens on
`squiz.sock` in the session's state directory, reads the posts the round host
makes to a Claude Code socket, and turns each one into a turn with
`session.send()`, as a system message carrying the note's text. The hook
records that socket as The hooks sets out, and the round host posts
to it exactly as it posts to Claude Code's.

- **One socket per session.** The extension removes any file at the path before
  it listens, and removes the socket when the session shuts down and when
  Copilot stops the extension.
- **A post that finds nothing listening fails.** The note goes back to wait for
  a pull, and nothing posts it again.

**A Copilot owner with no socket is woken by nothing.** That is a session
started without experimental features, which squiz does not support, or one
whose socket path is too long for the extension (§ 10). Its reviews still run.
It learns the result from its own `squiz review`, and one it ran in the
background wakes it when it exits.

**A note no wake reached stays where it was written.** The owner learns the
result by running `squiz review` or `squiz status`, and the pull request holds it
in any case.

**A run whose session has ended is woken by nothing.** Under `claude -p` or
`copilot -p` the run exits once its turn ends, and its review runs after it. The
round host writes the note all the same, and a socket the stop recorded has
nothing listening by then, so the note stays waiting. Squiz starts no coding
agent of its own. A caller with no live session runs the fix loop itself around
`squiz review`, which waits for the round and prints the threads it left open
(§ 7), as a coding agent working a pull request does. It hands the threads on
at exit 2, runs the command again at exit 4, stops at 0 and 3, and stops with
the status on any other. The output goes outside the worktree, where the local
venue would review it as part of the change:

```bash
out=$(mktemp)
while :; do
  squiz review 41 > "$out"; code=$?
  case $code in
    0|3) break ;;
    2) claude -p --resume "$SESSION" "$(cat "$out")" || exit ;;
    4) ;;
    *) exit "$code" ;;
  esac
done
```

Under the local venue the command is `squiz review`, with no number.


### Parallel coding agents

**Each worktree is reviewed on its own.** `squiz review` resolves the worktree
with `git rev-parse --show-toplevel` from the directory it is run in, and the
hook from the payload's `cwd`, which for a subagent is fixed when it is
dispatched. One worktree, one branch, one pull request, one live episode.

**The harness does not remove a worktree.** The coding agent is still in it when
the command returns. Whatever created the worktree removes it. The episode's
state goes with the worktree.

**A tree two episodes share keeps them apart.** One tree holds two pull
requests' episodes when its `HEAD` moved to another branch while the first
episode was live. Each keeps its state under its own number, and each reviewer
reads a snapshot of its own pull request's head commit.

**Two coding agents on one branch in one tree share one episode, and nothing tells
them apart.** They spend one round cap between them. Nothing detects this.

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

One comment is posted on the pull request when an episode closes. It carries the
status of every finding, what each round did, and the cost of the review. It is
never edited or replaced, so a second episode on the same pull request posts a
second comment. The local venue writes it as `summary.md` instead (§ 4). Every
line that says where the summary is, such as `squiz review`'s "its summary is
on the pull request", says it as `Change.summaryAt` gives it.

**An episode reports its close once.** The round that closes it writes the
close to the episode's state, and then posts the comment, as The state file
under § 3 sets out. Every path that ends an episode writes the close, whether or
not its comment is then posted. A round that leaves threads open for the coding
agent posts no summary. Nor does a failed round that leaves a round to run: it
posts the failure comment under § 8 instead.

**A failed round that spends the last of the round cap or the token bound posts
the summary of the rounds that ran** (§ 3 The round cap), and its failure
comment after it. The summary is built as at any close. Its threads are the ones
the round handed over, each as the round's salvaged verdicts left it, and the
ones its salvaged findings opened. Its Notes end with a line saying the budget
ran out before the review could be completed, so a person needs to look:

```markdown
- The budget ran out before the review could be completed: the last attempt failed, and spent the last of the round cap. A person needs to look at this change.
```

Where the token bound closed the episode, the line says "the last of the token
bound". Where states were queued behind the failed round, the line names them
before its last sentence, as "Squiz did not review 8d21a4f." An attempt that was
no round closes the same way where its tokens reach the token bound, and its
summary may count no rounds. `squiz review` exits 3 for the failed round's state
and for every state queued behind it, whatever is open, because no round
reviewed them (§ 7).

**A state reviewed clean that closes the episode once the state behind it is
superseded closes it without running a reviewer** (§ 3 The state file). The
round host lists the episode's threads and posts the summary from them and from
what the episode recorded, with the findings no thread holds that the clean
round and the rounds before it recorded, as Notes lists them below.

**A thread the closing round gave no verdict is counted by the last ruling the
state file holds for it** (§ 3 The state file). Only a failed round and a close
on a state reviewed clean leave such threads. A resolved thread last ruled
`fixed` or `withdrawn` counts as that ruling. Every other thread counts as
`open`, or `disputed` where the coding agent replied, as the default verdict
would rule it, resolved or not.

### What the comment carries

Four blocks, in this order.

1. **The counts, what the review spent, and who reviewed it.** Rounds run, findings raised, how many ended `fixed`, `withdrawn`, `open` and `disputed`,
   and the tokens each round spent with the episode's total, followed by the
   dollars where the reviewer's CLI priced the model, and the AI credits where it
   reported those. Then the reviewer CLI and the model each round ran on, as the
   run reported them. Findings raised counts every thread of the episode, and
   every finding that no thread holds that Notes lists. The findings that no
   thread holds carry no status.
2. **The findings that need a person.** Every `open` finding and every
   `disputed` one, each with its headline and where it sits: `file:line` for a
   thread anchored to a line, and the file alone for one anchored to the file,
   a finding about the change as a whole among them. When there are none, the
   comment says so in one line.
3. **Rounds.** Each round in the order it ran, with the short commit it
   reviewed, how many findings it raised, and the rulings it replied with: each
   thread it closed while the thread was open, and each it kept open. A round
   that raised nothing and ruled on nothing says so in one line, as
   `- Round 4 at 9a0b1c2: found nothing new and ruled on nothing`. The list is
   read from the episode's state file and never from the pull request, so a
   round whose replies GitHub refused is listed all the same.
4. **Notes.** Anything else a person reviewing the pull request should know:
   - a finding the harness could anchor to neither a line nor a file, with its
     `file:line`, or as about the change as a whole for one scoped to `change`;
   - a finding whose comment could not be posted at all, with its location, or
     as about the change as a whole for one scoped to `change`;
   - a thread the last round kept open whose reason could not be posted, with
     its location and headline;
   - a thread any round closed whose reply could not be posted, with its
     location, headline and ruling;
   - a ruling of the last round that could not be applied, with what the
     reviewer ruled;
   - a round whose finished review never read the diff of a changed file, with
     the round's number and the files;
   - a round whose review the time bound cut short, with the round's number and
     the bound;
   - a cap or bound that ended the episode early, with each queued state it left
     not reviewed;
   - a failed round that spent the last of the cap or the bound, as the line
     above shows.

**A closing reply that could not be posted is a line naming the ruling**, read
from the round's entry in the state file:

```markdown
- `src/queue.ts:134` — Retry backoff resets (ruled fixed, and the reviewer's reply could not be posted on its thread)
```

**A ruling that could not be applied is a line saying what the reviewer ruled**,
so a person can apply it by hand. A thread that was handed over is named by its
location and headline, and one that was not by the id the reviewer gave:

```markdown
- `src/queue.ts:134` — Retry backoff resets (ruled fixed, and the thread could not be resolved)
- `src/queue.ts:140` — The cap is never read (ruled open, and the thread could not be re-opened)
- `src/cache.ts:12` — The cache is never cleared (given no ruling, which keeps it open, and the thread could not be re-opened)
- `src/cache.ts:30` — The key ignores the locale (ruled open a second time, which was not applied: the first ruling stands)
- A ruling of withdrawn on thread `PRRT_kwDOAbc999`, which was not handed to the reviewer, was not applied
```

**Notes names every finding no thread holds that the episode raised.** A round
that leaves the episode open keeps each of its own as its Notes line (§ 3 The
state file), and `squiz review` prints each on stderr (§ 7). The summary lists
the earlier rounds' first, then the closing round's. An earlier round's line
that no later round raised again names the latest round that raised it, and
says only that, since a round that does not raise a finding again has not said
it was fixed:

```markdown
- Raised in round 1 and not raised again: `src/cache.ts:12` — The cache is never cleared (no thread could be opened for it)
- About the change as a whole: The retry queue duplicates the scheduler (raised, and its comment could not be posted)
```

A line a later round raised again is listed once, as the later round's. A close
on a state reviewed clean gives that round's lines as they are, after the
earlier rounds' it did not raise again. A failed round lists the findings it
salvaged in its failure comment, and where it closes the episode, in the
summary too, as the closing round's (§ 8 The failure comment). Both venues write
the same body, so `summary.md` lists them as the comment does.

**A round whose finished review never read the diff of a changed file is a
line of its own**, naming the files, the first ten of them where there are more.
It is read from the round's entry in the state file. Each name is one code span
on the line: a control character in it is shown escaped, a line break as `\n`,
and the span's fence is one backtick longer than any run of backticks in the
name. A round the time bound cut
short has no such line, because its own line says the review did not finish:

```markdown
- The reviewer finished round 1 without reading the diff of 2 changed files: `src/queue.ts`, `docs/a file.md`
- The reviewer finished round 2 without reading the diff of 12 changed files: `f1.ts`, `f2.ts`, `f3.ts`, `f4.ts`, `f5.ts`, `f6.ts`, `f7.ts`, `f8.ts`, `f9.ts`, `f10.ts`, and 2 more
```

**A round whose review the time bound cut short is a line of its own**, written
by the round that later closes the episode, from the episode's state:

```markdown
- The review was cut short by the 900-second time bound in round 2, and the round kept only the findings it had reported by then
```

**A cap or bound that left queued states not reviewed is one line, naming the
bound and each of those states**, as § 3 The state file names them. It takes the
place of the line the bound writes where nothing was queued. The line a failed
round's close writes names them itself, as shown above:

```markdown
- The episode ended at its round cap rather than with nothing left open, and did not review 8d21a4f or 8d21a4f with different replies
- The episode ended at the token bound with nothing left open, and did not review 3f9c2e0 with different replies
```

### The format

```markdown
**Squiz review — 3 rounds, 7 findings**

Fixed 2 · Withdrawn 1 · Open 3 · Disputed 1
48,200 tokens over 3 rounds: 20,100, 16,400, 11,700 · $0.0134
Reviewed by `pi` on `openai/gpt-5-mini`

**Needs a person**

- `packages/sync/src/queue.ts:134` — Retry backoff resets on every enqueue (open)
- `packages/sync/src/session.ts:57` — Clock skew is read as token expiry (disputed)
- `packages/sync/src/retry.ts` — Every path here is dead once the queue lands (open)
- `packages/sync/src/queue.ts` — The retry queue duplicates the scheduler already in `packages/sync/src/scheduler.ts` (open)

**Rounds**

- Round 1 at 3f9c2e0: raised 6 findings
- Round 2 at 1b86987: raised nothing, and ruled 2 fixed, 1 withdrawn and 3 open
- Round 3 at 8d21a4f: raised 1 finding, and ruled 3 open

**Notes**

- The review was cut short by the 900-second time bound in round 2, and the round kept only the findings it had reported by then
```

Notes is omitted when there is nothing to report, and Rounds when the episode ran
no round.

Each round is written to the episode's local state file as the review finishes,
before anything is posted. The closing replies it could not post are added when
it records its end, and its posting time once posting ends:

```json
{ "reviewer": "pi", "dollars": 0.0134, "tokens": 20100, "messages": 9, "models": ["openai/gpt-5-mini"], "elapsedSeconds": 901.2, "cutShortAtSeconds": 900, "postingSeconds": 4.3, "head": "1b86987c4f0e2d6a9b3c5e7f8a1d2c3b4e5f6a7b", "raised": 0, "ruled": { "fixed": 2, "withdrawn": 1, "open": 3 }, "unpostedReplies": ["`src/queue.ts:134` — Retry backoff resets (ruled fixed, and the reviewer's reply could not be posted on its thread)"], "unread": ["docs/a file.md"] }
```

- `reviewer` is the reviewer CLI the round ran, as `reviewer` in Configuration
  names it.

- `dollars` and `tokens` are what the round spent, the dollars being zero where
  the reviewer's CLI did not price the model. `messages` is how many assistant
  messages the two cover, or for Copilot how many model requests. A round with no
  cost, which only a Copilot round can be, carries none of the three.
- `credits` is the AI credits the round spent, where the reviewer's CLI
  reported them, as Copilot does. It is absent for a `pi` round.
- `models` is every model the round's runs reported their spend against, in the
  order they first named each, spelled as the adapter reads them (§ 5). A round
  that ran the reviewer twice names the models of both runs. It is absent where
  no run named a model, and a round with no cost carries none.
- `elapsedSeconds` is the wall clock from starting the reviewer to having it
  stopped, to a tenth of a second. A round that ran the reviewer twice counts
  both runs.
- `cutShortAtSeconds` is the time bound the round ran under, present only where
  the bound ended a review the reviewer had not finished.
- `postingSeconds` is the wall clock from the round's first call after the review
  to its last, to a tenth of a second. It is absent where the round posted nothing,
  and where the round was stopped before posting ended.
- `floor` is `true` where the round's cost is a floor (§ 5, The `pi` adapter),
  and absent where it is a total. A Copilot round never carries it.
- `head` is the full head commit of the state the round reviewed.
- `raised` is how many findings the reviewer reported, whether or not their
  comments were posted.
- `ruled` counts the rulings the round set out to reply with, by verdict: a
  `fixed` or `withdrawn` verdict on a thread that was open when it was handed
  over, and every `open` verdict the reviewer gave. A verdict naming a thread
  that was not handed over, and a second verdict on one thread, are not counted.
  The counts are taken before anything is posted.
- `unpostedReplies` is the Notes line of each reply on a thread the round
  closed that GitHub refused, and is absent where none was refused. A failed
  round lists them in its failure comment, and records them only where it closes
  the episode, in the update that writes the close.
- `unread` is each changed file whose diff the round's finished review never
  read through `git_diff`, by its name after the change. It is absent where the
  review read every one, where the review did not finish, and where the
  reviewer's adapter could not say what it read.

A field this list does not say can be absent that is missing, or a field that
does not hold a value of the right kind, makes the file unreadable, as § 3 The
state file sets out.

**The spend line leads with the tokens**, which every reviewer reports. A round
with no dollar figure, such as a model run on a subscription, adds none, and
where only some rounds were priced, the dollar total covers those.

**A Copilot round carries AI credits in place of dollars**, to two decimal
places, and never zero dollars:

```markdown
31,400 tokens over 2 rounds: 18,200, 13,200 · 0.84 AI credits
```

Where some rounds carry credits and others dollars, the line gives both totals,
each covering the rounds that carry it. A round that completed no assistant
message is given as unknown rather than as zero.

**A round with no cost has no figure in the line**, neither a zero nor a floor.
The line covers the rounds that have one, and says how many those are:

```markdown
18,200 tokens over 1 of 2 rounds · 0.36 AI credits
```

Where no round of the episode has a cost, the comment carries no spend line.

**A figure that is a floor reads "at least"**: a floor round's own, and every
total of an episode holding one. Here the second of two rounds is a floor:

```markdown
At least 36,500 tokens over 2 rounds: 20,100, at least 16,400 · at least $0.0105
```

A `pi` round the time bound killed is such a round: it reports the spend of the
messages that completed. A floor round that completed no assistant message is
given as unknown, and the totals beside it are still marked.

**The reviewer line names the reviewer CLI each round ran and the model the run
reported**, as § 5 sets out for each adapter, never the `model` `.squiz.json`
configures, since a CLI can run another. A round whose run reported no model
reads "an unknown model".

Where every round ran the same reviewer on the same models, the line names them
once:

```markdown
Reviewed by `pi` on `openai/gpt-5-mini`
Reviewed by `copilot` on `gpt-5-mini` and `claude-haiku-4.5`
```

Where the rounds differ, each model is named with the rounds that ran on it,
under the reviewer that ran them, in the order the rounds first named each. A
round that ran two models is listed under both:

```markdown
Reviewed by `pi` on `openai/gpt-5-mini` in rounds 1 and 3, and on an unknown model in round 2
Reviewed by `pi` on `openai/gpt-5-mini` in rounds 1 and 2, and by `copilot` on `gpt-5-mini` in round 3
```

Each model is one code span on one line, with every run of whitespace in its
name collapsed to a space. A round recorded with no reviewer reads "an unknown
reviewer". An episode that ran no round has no reviewer line.

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
| 3 | The round cap or the token bound closed the episode with threads open. Or it closed the episode without a round reviewing this state, whatever is open. |
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
claim one.

Still reviewing, exit 4: the run prints one of these lines after the path.

- Its state's round is running: ``Squiz is still reviewing PR #41 at 3f9c2e0. Run `squiz review 41` again to wait for it.``
- Its state is queued behind an older one's round: ``Squiz is reviewing PR #41 at 3f9c2e0 first, and 8d21a4f is next. Run `squiz review 41` again to wait for it.``
- Its state was reviewed clean and a later one is queued: ``Squiz found nothing open in PR #41 at 3f9c2e0, and is reviewing 8d21a4f before it closes the review. Run `squiz review 41` again to wait for it.``
- Its state was superseded (§ 3 The state file): ``Squiz is reviewing PR #41 at 8d21a4f instead of 3f9c2e0. Run `squiz review 41` again to wait for it.``

A run on an episode that has already closed prints the close, whatever the round
cap or the token bound would now allow. The line names the head the close was
reached on, as `Squiz's review of PR #41 closed at 3f9c2e0 after 2 rounds, with
nothing open. Only a new head commit starts another review in this worktree.` A
clean close is printed this way, with exit 0, only for its own head and for a
failed state it recorded. Where the round cap or the token bound closed it, the
line ends `No round runs again in this worktree.` instead. Where threads are
open, the line counts them, the run exits 3, and the threads follow.

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

**Every failure the harness controls ends the command with a status the coding
agent can read.** A run that could not review exits 1, unless its round's failure
closed the episode, which exits 3. A failure that leaves the round's outcome
standing keeps the outcome's status, 0, 2 or 3, and adds a line on stderr.

**No failure path is silent.** Every path reaches at least one of six surfaces a
person reads:

- **The failure comment**, which a round that fails posts on the pull request, as
  The failure comment below sets out.
- **`squiz status`**, which shows a failed state's reason, a killed round, and a
  reviewed state's problems, and prints a line on its stderr for a state file it
  cannot read (§ 7).
- **`.squiz/<number>/host.log`**, where the round host writes a line for each
  thing it did, and where its own stderr goes. It is the only surface for what
  the host does outside a round.
- **`squiz review`'s stderr**, one line for each thing that failed, as The
  command's stderr below sets out.
- **The summary's Notes**, which the round that closes the episode writes (§ 6).
- **The hook's stderr**, one line for what a `Stop` or `SubagentStop` firing
  could not do.

**A failure reaches the pull request once the round has found its pull request
and can read the episode's state.** A round that fails after that posts a failure
comment where GitHub can be reached, and the problems of a round that closes the
episode go into the summary's Notes. A failure before that posts nothing, and is read on the local
surfaces alone.

**A round that fails in the round host is recorded failed, with its reason**,
which `squiz status`, `squiz review`'s stderr and `host.log` all carry.

**What ran and answered is reported by its answer.** Where `gh` ran and said what
was wrong, the round reports the status it exited with and the first line it
wrote. A `gh` that could not be run at all is a failure of its own.

**A call whose body `gh` did not read to its end is a failure**, never a call
that did what was asked. Where `gh` exited non-zero, the failure reported is what
`gh` said, and where it exited 0, GitHub not having been reached.

The last column names the surfaces each path reaches.

| Failure | Behaviour | Read on |
|---|---|---|
| The hook's payload cannot be read | Nothing is queued, and the hook exits 0, as it does on every path. | Hook stderr |
| git cannot name the worktree or its branch | Exit 1, and no review runs. A trigger queues nothing. A round that meets it records the state failed and posts no failure comment, because it has found no pull request to post one on. | Hook stderr, `squiz review` stderr, `squiz status`, `host.log` |
| The configuration cannot be read | `squiz review` exits 1 naming the setting it refused, and no review runs. A round host started for the state stops before taking it, and says why. The state stays queued. | `squiz review` stderr, `host.log` |
| The state cannot be queued | The trigger's write of the queued record fails. Nothing is queued and no round host is started, and `squiz review` exits 1. | Hook stderr, `squiz review` stderr |
| The round host cannot be started | The state stays queued with no host to take it, and the next trigger starts one. `squiz review` exits 1. | Hook stderr, `squiz review` stderr |
| The round host's start cannot be told | The process that starts the host failed or answered nothing readable after it may have started the host, or the host's start time could not be read. A live process holding the host lock means the host started, and `squiz review` waits on it. Where no live process holds the lock within 10 seconds of the start, or by the run's deadline where that comes first, `squiz review` exits 1, and stderr names `squiz status` and `.squiz/<number>/host.log`, as § 7 `squiz review` shows. The state stays queued, and the next trigger starts a host for it. | Hook stderr, `squiz review` stderr |
| Whether a round host is running cannot be told | Where a reviewing record names a host that cannot be told running or gone, nothing is recovered, queued or started, and `squiz review` exits 1. `squiz status` shows the state reviewing, with "the round host could not be checked:" and why. A round host that cannot tell whether another holds the lock exits, and the next trigger starts one. | `squiz review` stderr, `squiz status`, `host.log` |
| The command is stopped from outside | The coding agent's tool or a person ends `squiz review` while it waits. The round runs in the round host, outside the command's process tree and group, and goes on. The next run returns its result. | `squiz status` |
| The round host dies | The reviewing record names a host that has gone, so the round reads as killed. The next trigger or round host to find it stops the orphaned reviewer, confirms it is gone, removes the snapshot, and records the round failed, as The round host under § 3 sets out. What the reviewer reported is not posted, and no failure comment is posted. `squiz review` exits 1, saying the host stopped before its round ended. The state is retried by a new commit or reply, or by `squiz review`. | `squiz status`, `squiz review` stderr |
| The state file cannot be read | Exit 1, and no review runs. Every reader of the file reports it with the underlying error rather than the word "failed": the hook queues nothing, `squiz review` exits 1, `squiz status` prints a line for the episode and lists the rest, and the round host exits, leaving the state queued. No failure comment is posted, because whether the episode is closed is in the file, and so is the record that would stop each firing posting another. | Hook stderr, `squiz review` stderr, `squiz status`, `host.log` |
| The round cannot write its reviewing record | Exit 1, and no review runs. The round host records the state failed, since a round nothing records would run twice. Where that write fails too, the host exits, and the state stays queued for the next host. | `squiz review` stderr, `squiz status`, `host.log` |
| The reviewer's session cannot be recorded | The review goes on. Until a later write names it, the record names no reviewer for `squiz status` or a recovery to find. | `host.log` |
| No pane can be opened | Where tmux or Herdr refuses to open a pane, the round host starts the reviewer detached, and the round goes on. `squiz status` shows the session as `detached`. Why the pane was refused is not kept. | `squiz status` |
| The reviewer is not installed | Exit 1, and the failure comment and stderr name the reviewer that could not be started. It is reported as a setup problem rather than as a bad round. A missing Copilot arrives instead as a Copilot adapter run that completed no message, because the line the round starts is `sh`, and is reported as a setup problem by the row below. | Failure comment, `squiz review` stderr, `squiz status`, `host.log` |
| The reviewer runs, exits cleanly, and completes no message | Exit 1, and what the reviewer reported before its provider gave out is posted. A credential the provider refuses arrives here rather than above, because the reviewer starts and answers. The failure comment and stderr carry the reason the reviewer gave. For a Copilot reviewer that is not signed in, the reason says so and names no model (§ 5 Adapters). Not retried, because the reviewer already retried the request itself. Reported as a setup problem rather than as a bad round. An errored message in a round that completed others is a retry rather than a failure. | Failure comment, `squiz review` stderr, `squiz status`, `host.log` |
| The reviewer's output cannot be read, and no retry recovers it | Exit 1, and what the reviewer reported before its output stopped being readable is posted. The failure comment and stderr say the review did not run. A retry whose output cannot be read either and a first attempt that left no time for a retry both arrive here. | Failure comment, `squiz review` stderr, `squiz status`, `host.log` |
| The reviewer stops without finishing its review | Retried once, where the round has time left for one. Both attempts post what the reviewer reported before it stopped. A review that was never finished and an honest finding of nothing are distinguished before anything is posted. Exit 1 where the retry does not finish either, with a failure comment saying the review was never finished. | Failure comment, `squiz review` stderr, `squiz status`, `host.log` |
| The reviewer exceeds the review budget | Exit 1, unless the round holds the reviewer's declaration, as the end of this row says. The reviewer process is killed, what it reported before the kill is posted, and the failure comment and stderr say how many findings arrived. The same line then says what squiz saw during the round, and never what caused the kill. For a `pi` reviewer it gives how many messages the reviewer completed, with the bound's seconds averaged over them, and how many requests its provider failed, quoting the first line of the last one's error. A Copilot round's line adds nothing of that, because Copilot reports neither while it runs. Where the machine slept during the review, the line ends by saying for how long, as in "the machine slept for 13 minutes of the round", whichever reviewer ran. The round is recorded as a failed round rather than a clean one, whatever it posted, and the summary that closes the episode notes that the bound cut it short. A round that already holds the reviewer's declaration is the review it declared instead, because the review was finished before the bound was reached, unless one of its reports could not be read back. That round posts no failure comment, and exits 0, 2 or 3 as its outcome says. | Failure comment, `squiz review` stderr, `squiz status`, `host.log`, summary's Notes |
| A reviewer's pane cannot be closed | The reviewer is already stopped, and its pane stays open on the person's screen. | `host.log` |
| A round's snapshot cannot be removed | The snapshot stays on disk, and the round's result stands. `host.log` names its path and why it could not be deleted (§ 5 The snapshot). | `host.log` |
| GitHub does not report a push | `squiz review` asks again for up to 60 seconds, and then exits 1 naming the head GitHub reports and the commit the worktree pushed, as § 7 `squiz review` shows. Nothing is queued for either head. A hook triggers on the head GitHub reports. | `squiz review` stderr |
| GitHub is unreachable | Exit 1 and nothing is posted, the failure comment included. Nothing is stored to retry. Where the episode ends having posted nothing, stderr says so. A trigger whose calls cannot reach GitHub queues nothing. | `squiz review` stderr, `squiz status`, `host.log`, hook stderr |
| `gh` cannot be run at all | Exit 1, nothing posted, the failure comment included, and no review runs. stderr names the call that needed it and says `gh` could not be run. | `squiz review` stderr, `squiz status`, `host.log`, hook stderr |
| A call before the review runs out of time | Exit 1, and no review runs. A snapshot that the fetch, the clone and the checkout could not make within their 30 seconds is this row too. The failure comment and stderr say which call ran out of time, where GitHub can still be reached. A lookup that ran out of time is never read as a branch with no pull request. | Failure comment, `squiz review` stderr, `squiz status`, `host.log` |
| The threads on the pull request cannot all be listed | Exit 1, and no review runs. The failure comment and stderr say so. The pages that arrived are dropped, because a reviewer handed a subset rules on a subset. A trigger whose listing fails queues nothing. | Failure comment, `squiz review` stderr, `squiz status`, `host.log`, hook stderr |
| A verdict cannot be applied | A verdict whose mutation GitHub refuses leaves its thread as it was handed over, and the round counts the thread that way. A verdict naming a thread that was not handed over, and a second verdict for one thread, are not sent. The round's outcome stands. stderr names each with its thread, what the reviewer ruled, and why it was not applied, which for a refused mutation is what GitHub answered. `squiz status` does the same for a round that reviewed. The summary that closes the episode, and the failure comment of a round that failed, name each as § 6 What the comment carries shows, without GitHub's answer. Nothing is retried. | `squiz review` stderr, `squiz status`, summary's Notes, failure comment |
| Some comments post and others fail | The comments that landed stay, the round exits as its outcome says, and stderr says how many could not be posted. A later round makes the rest again. A round that closes the episode lists each in its summary's Notes, and a round that fails lists each in its failure comment. | `squiz review` stderr, `squiz status`, summary's Notes, failure comment |
| The reviewer's reason cannot be posted | The verdict stands, and the thread stays in the state the reviewer ruled. The round's outcome stands. stderr names the thread and what GitHub answered, and so does `squiz status` for a round that reviewed. A round that closes the episode names the thread in its summary's Notes, without GitHub's answer. Nothing is retried: the next round that keeps the thread open posts a reason of its own. | `squiz review` stderr, `squiz status`, summary's Notes |
| The reply on a thread the round closes cannot be posted | The thread is resolved all the same, and the verdict stands. The round's outcome stands. stderr names the thread and what GitHub answered, and so does `squiz status` for a round that reviewed. The round records the line in its entry of the state file, and the summary that closes the episode names it in Notes, without GitHub's answer, whichever round it was. A round that fails names it in its failure comment instead, and in its summary too where it closes the episode. Nothing is retried, because no later round closes the thread again. | `squiz review` stderr, `squiz status`, summary's Notes, failure comment |
| A round that leaves threads open has findings no thread holds | A finding the harness could anchor to neither a line nor a file, and one whose comment could not be posted, reach no thread, and a round that leaves threads open posts no summary. The round's record keeps each. `squiz review` prints each on stderr, and the summary that closes the episode lists each, with the round that raised it where no later round raised it again (§ 6). | `squiz review` stderr, summary's Notes |
| No finding posts | A round that found findings and posted none of them is a failed round, whatever its verdicts did: exit 1, recorded failed with the reason "round 2 found 3 findings and could not post them to PR #41", and a failure comment where GitHub takes one. Where a round remains, it posts no summary and does not close the episode, and a new commit, a new reply or a run of `squiz review` retries it. Where none does, it closes the episode itself, as The failure comment below says. | Failure comment, `squiz review` stderr, `squiz status`, `host.log` |
| The round's spend cannot be written | Exit 1, and nothing the reviewer found is posted. The failure comment and stderr say nothing was posted, and give the underlying error. | Failure comment, `squiz review` stderr, `squiz status`, `host.log` |
| The round's end cannot be written to the episode's state | Exit 1, and no summary is posted, because the end, and the close where the round closes the episode, is written before the summary. The findings and verdicts the round posted stand, and the failure comment and stderr name the write that failed. The episode then reads as one still open, and the next run reviews the pull request again. A failed round whose close cannot be written closes nothing either: it posts no summary, its failure comment promises a retry, and its reason names the write that failed. | Failure comment, `squiz review` stderr, `squiz status`, `host.log` |
| The round's result cannot be recorded | The round host could not write what the round reached, after the round posted it. The host names the result and the reason, and exits. What the round posted stands. The reviewing record still names the host, so once the host has exited `squiz status` shows the round killed. A `squiz review` already waiting on the round sees no result and exits 4 at its deadline. A later run exits 1 saying the host stopped before its round ended, unless the round had closed the episode, which it then prints as closed. | `host.log`, `squiz status` |
| A round's posting time or resume command cannot be written | The round's result stands. A round with no resume command shows `—` under Resume in `squiz status`. | `host.log` |
| The summary comment cannot be posted | The close is a close still rather than a round the harness failed, and the command exits 0 or 3 as the close does. stderr says the episode closed without its summary, and names what GitHub answered. Nothing is retried, because a second attempt would be a second comment. `squiz review` prints the line for the run that waited on the close, and for every later run on the closed episode, whether the round that closed it reviewed or failed. `squiz status` prints it under the line of a round that reviewed. `host.log` holds it after the close's own line. | `squiz review` stderr, `squiz status`, `host.log` |
| A failed round spends the last of the round cap or the token bound | Exit 3, because the episode is closed and no round reviewed the state. The round records the close, posts the summary (§ 6), and then posts its failure comment. Its state is recorded failed, carrying the close, and every state queued behind it not reviewed. stderr carries where the failure comment went. An attempt that was no round closes the same way where its tokens reach the token bound. | Failure comment, summary's Notes, `squiz review` stderr, `squiz status`, `host.log` |
| The harness itself throws | A throw in a command is trapped at its top level, which writes one line on stderr. A throw inside a round fails the round: it is recorded failed with the throw as its reason, and posts no failure comment. `squiz review` exits 1. The hook exits 0, as it does on every path. A throw in the round host outside a round ends the host, and the round it held reads as killed. | `squiz review` stderr, `squiz status`, `host.log`, hook stderr |
| No wake reaches the owner of the work | The note stays in `.squiz/<number>/notes/`. The owner learns the result from `squiz review` or `squiz status`, and the pull request holds it. A note that cannot be written is reported the same way. | `host.log` |
| The round cap is reached | Exit 3, or 0 for the state the closing round reviewed where nothing is open. Findings still unresolved stay open, and the summary comment reports them. | Summary's Notes, `squiz status` |
| The token bound is reached | Exit 3, or 0 for the state the closing round reviewed where nothing is open. The episode closes without starting another round, and the summary comment reports that the bound was reached rather than reporting the round as one the reviewer failed. | Summary's Notes, `squiz status` |

### The failure comment

A round that fails posts one issue-level comment on the pull request saying so. It
names what failed, and says what happens next. A round that salvaged findings
says how many of them it posted as threads. A list follows, holding each
salvaged finding that no thread holds, written as the summary's Notes write it
(§ 6 What the comment carries): a finding the harness could anchor to neither a
line nor a file, and one whose comment could not be posted at all. Each ruling the round could not apply follows them, also
written as Notes writes it.

Where a round remains under the round cap and the token bound, the comment says
the review is still open and that a new commit or reply, or running
`squiz review`, retries it:

```markdown
**Squiz review failed — the reviewer was killed at its 900-second bound, and the round kept the 3 findings the reviewer had reported**

1 of the 3 findings the reviewer reported is posted as a thread. The review is still open. A new commit or reply, or running `squiz review` again, retries it.

- `src/cache.ts:12` — The cache is never cleared (no thread could be opened for it)
- About the change as a whole: The retry queue duplicates the scheduler (raised, and its comment could not be posted)
```

**Where the round leaves no round to run, it closes the episode, and the comment
says the review is closed and which bound closed it**: a failed round that was
the last the cap allows, or a failed attempt whose tokens reached the token
bound. Whether a round remains is read from the episode's state once the attempt
has recorded what it spent. The summary is posted first (§ 6), and the comment
says where it is:

```markdown
**Squiz review failed — the reviewer was killed at its 900-second bound, and the round recorded no findings; the reviewer's 21 messages took about 43 seconds each; its provider failed 7 requests, the last with "429 Too Many Requests"**

The review is closed: it has run 3 rounds, and the round cap allows 3. No round runs again. Its summary is on the pull request.
```

```markdown
The review is closed: it reached the token bound of 10,000,000 tokens. No round runs again. Its summary is on the pull request.
```

Where the summary could not be posted, the comment ends at "No round runs
again."

The reason on the first line is the reason the command prints on stderr, word for
word, as § 7 shows.

The failure comment is posted after the salvaged findings. It is never edited,
and each failed round posts its own. Where GitHub cannot be reached, nothing is
posted, and stderr is the only channel.

A run that ends at the gate posts no failure comment. A run that waited for
another's round, or was handed a result already recorded, posts nothing of its
own.

### The command's stderr

The command writes one line on stderr for each thing that failed: the lines that
say why a run exits 1, and the line a run adds where something failed without
changing its outcome. A run that exits 1 then ends with the line telling the
coding agent to stop, as § 7 `squiz review` shows. The outcome itself, the open threads included, is on stdout
as § 7 shows. Both reach the coding agent as its shell tool's output.

```
squiz: round 3 found 3 findings and could not post them to PR #142
squiz: no review ran: HEAD is detached in "/work/squiz", so no pull request has it as its head
squiz: the review of PR #142 closed without its summary: GitHub answered 502
squiz: the reviewer ruled thread PRRT_kwDOAbc123 fixed, and it could not be resolved: GitHub answered 502
squiz: the failure could not be posted on PR #142: GitHub answered 502
```

A run with nothing that failed writes nothing on stderr, except the line saying
the defaults are in use where the main worktree holds no `.squiz.json`
(§ 10 Configuration).

A line is a pointer rather than a report. What a person needs to read about a
failure is in the failure comment.

### The review budget

The review budget bounds a review two ways. Both are configurable.

| Bound | Default | When it is reached |
|---|---|---|
| **Time**, per round | 900 seconds | The reviewer is stopped, the round records that the bound cut it short, and it posts the findings reported before the stop. |
| **Tokens**, per round | 10,000,000 | The episode closes without starting another round. |

A `pi` reviewer killed at the time bound yields the cost of its completed
messages as well as its findings, both read from the same moment of the run.

**What a failed round salvaged goes on the pull request, and the round is a
failed round still.** The findings the reviewer confirmed are posted and the
verdicts it reported are applied, as a finished review's are. A finding no thread can hold is
listed in the failure comment. None of that decides what the
round became. The outcome is the reviewer's own, the cost is the floor the
failure left, and the round neither hands threads back to the coding agent nor
closes the episode over what it managed to put up. It closes the episode only
where it spent the last of the round cap or the token bound (§ 3 The round cap).

A failed round that confirmed nothing has no findings to post and no verdicts to
apply. It still posts its failure comment under § 8.

**A round runs in the round host, so no caller's timeout bounds it.** The time
bound is on the review alone. Before the review and after it, each call the round
makes has 30 seconds of its own, and the round makes every call it has, however
long the ones before it took:

- **Before the review**: the pull request lookup, the threads listing, the
  snapshot's fetch, clone and checkout together, and the diff read from it.
- **After the review**: each verdict, each reply, each finding's thread and the
  read-back of its id, the summary comment and the failure comment.

A call that pages, as the threads listing and a thread's read-back do, is one
call, and its pages share its 30 seconds.

**Time the machine sleeps during the review is added back to the time bound.**
While the reviewer runs, the round host reads the clock at least every 250
milliseconds. A gap of more than 5 seconds between two reads is time the machine
slept, and the moment the review has to be over by moves on by that gap. At most
the time bound itself is added back in one round, so no review runs longer than
twice its bound. The calls outside the review, and `squiz review`'s wait, count
sleep as they count any other time.

**`squiz review` waits within one deadline of 540 seconds**, counted from the
moment it starts, which keeps it under the 600 seconds Claude Code gives a shell
command. Everything the run does counts against it.

- **A run whose state's round ends before its deadline returns that round's
  result**, 0, 2 or 3, or exits 1 with the reason the round recorded where it
  failed and closed nothing. It posts no second failure comment.
- **A run whose deadline arrives first exits 4.** Its state is queued or under
  review, so the round goes on, and the next run returns it.

**No single call to GitHub may take more than 30 seconds**, and this bound is not
configurable. A call that reaches it, or whose pages reach their call's 30
seconds, is treated as GitHub being unreachable: the round exits 1, and the
comments that landed stay.

**The token bound is on one round rather than on the episode.** A round whose
tokens reached it closes the episode. The episode's own ceiling follows from the
round cap: a cap of R rounds with a bound of B tokens is an episode of R × B,
which is 30,000,000 tokens at the default cap of 3 and 80,000,000 at the largest
cap the configuration accepts.

The tokens an attempt spent count whether or not the attempt was a round, as a
ledger of its own.

**A reviewer that ran is charged what its report file says, however its attempt
ended.** Two attempts end with no read of the file to its end:

- **A start that failed after the reviewer may have run.** A tmux window runs its
  command as it opens, and a child whose identity could not be read ran until it
  was stopped. A Herdr pane runs nothing until its start succeeds, so its failed
  start spends nothing.
- **An attempt the harness threw out of** after the reviewer started. The
  reviewer's process group is stopped and its pane closed before the attempt
  returns.

The file is read once the reviewer is stopped, and what it says is a floor. A
Copilot usage line is Copilot's own total and is kept as it is. A reviewer that
ran and whose file reports no spend is charged a floor of zero.

The bound is read when an attempt records what it spent, and the attempt that
reaches it closes the episode, whether it reviewed or failed. **It stops the next
round, never the running one**, so the round that reaches it may spend more than
the bound, and the time bound is the only thing that caps a single round.

**The token bound holds a Copilot round that has a cost as it holds a `pi`
one**, with tokens counted the same way for both. A Copilot round with no cost
counts nothing against it. Dollars and AI credits bound nothing.

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
