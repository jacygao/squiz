# Review Harness Specification: A Local Review Loop That Lives on the Pull Request

**Version:** 1.30 (draft)

## 1. Purpose

**Squiz automates code review between agents.** Whenever a coding agent
finishes a piece of work, a reviewer agent reviews it. The reviewer runs a
different model from the coding agent, and can run in a different harness. The
two agents work through the findings over as many rounds as it takes to settle
them. Everything they say to each other is kept as review comments on the pull
request, where a person, or an agent trusted to merge, can see how each finding
was settled.

## 2. Dependencies

Squiz runs on the developer's machine, and needs all three of these:

| Dependency | Supported | Needed for |
|---|---|---|
| GitHub repository | `git`, and `gh` signed in | The pull request is where the review happens and is recorded. |
| Runtime | Claude Code / GitHub Copilot CLI | Runs the coding agent, and starts a review when the agent finishes its work. Copilot support is experimental (§ 3 The report). |
| Reviewer | `pi` / GitHub Copilot CLI | Reviews the change. It must run a different model from the coding agent. Only the one `reviewer` names has to be installed. |

A terminal multiplexer is optional. Where tmux or Herdr is running, each
reviewer runs in a pane of it, where a person can watch it. Where neither is,
the reviewer runs detached, and a log holds its progress.

### GitHub access

The harness must be able to:

- Read a pull request: its diff, its description, and its base and head refs
- List the existing review threads and whether each one is resolved
- Create a review comment anchored to a file and a line
- Create a review comment on a file as a whole, carrying no line
- Reply inside an existing review comment thread
- Resolve a review thread, and re-open one
- Post an issue-level comment on the pull request, for the summary and for a
  round that failed

`gh pr comment` and `gh pr review` take a body only, so every anchored comment
goes through `gh api`. Resolving and re-opening a thread go through GraphQL,
since REST has neither.

### Identity

Every comment is posted with the credentials `gh` holds, so all of them appear
under the account that authenticated it. The reviewer, the coding agent and the
harness share one GitHub identity.

Each comment names its own author at the start of its first line, inside that
line's bold span. What follows the marker differs from comment to comment, so
the marker is the opening of the span rather than the whole of it.

| Written by | Begins |
|---|---|
| The reviewer | `**Squiz reviewer · ` |
| The coding agent | `**Squiz coding agent` |
| The harness, at close | `**Squiz review — ` |
| The harness, when a round fails | `**Squiz review failed — ` |

A comment without one of those markers was written by a person.

`**Squiz review` is a prefix of `**Squiz reviewer`, so a marker is matched up to
and including the character after the name.

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
| **Episode** | The whole review of one pull request in one worktree, from its first round to its close. |
| **Round** | One turn of an episode: one review of the pull request as it stands. |

An episode is **live** until its close is recorded. Nothing else makes it live
or over: not whether a round is running, and not how long ago anything
happened. It closes for one of three reasons: nothing is left open for another
round to work, the round cap is spent, or a round reached the token bound. A
round that failed closes nothing. It posts a failure comment under § 7, and the
episode stays live.

### The state file

**An episode is keyed by the number of its pull request.** Its state lives in
`.squiz/<number>/` inside the worktree. The directory holds the state file, which
the rest of this section describes, and:

- `rounds/<k>/`, for each round: `prompt.md`, the task prompt the reviewer is
  handed, the report file the reviewer reports into, the reviewer's session,
  `resume.txt`, the command that resumes that session, and `gh/`, the empty `gh`
  configuration the reviewer runs with (§ 4 Tools). The snapshot the reviewer
  reads is in the temporary directory instead (§ 4 The snapshot).
- `notes/`, the notes for the sessions that own the work, under The report.
- `host.log`, the round host's output.
- `state.lock`, held while the state file is changed.

**`.squiz/` keeps itself out of git.** Wherever squiz makes an episode's
directory and `.squiz/.gitignore` is missing, it writes one holding `*`. One that
exists is left as it is.

**Every change to the state file is made under `state.lock`.** A writer takes the
lock, reads the file, changes it, writes it whole, and releases the lock. The
lock is held for one update and never across a review. It names its holder's pid
and start time, and a lock whose holder has gone is taken over. A writer that
finds the lock held by a live process, or by one that cannot be told running or
gone, waits up to a deadline of its own and never breaks the lock. A wait that
runs out is a state file that cannot be written (§ 7). Readers take no lock.

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
| Reviewed | The round's result: its exit status and the threads it left open. A round that left nothing open while a later state was queued behind it records *reviewed clean, episode open* instead, with no exit status. A round that left the episode open also records each finding no thread holds, as § 5's Notes would give it. |
| Failed | Why the round failed, and whether its owner has had a note about it. |
| Not reviewed | Why no round reviewed it: the episode closed first, or a later state superseded it. |

A record of a round that started also holds what `squiz status` prints for it
(§ 6).

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

`squiz review` then waits, as § 7 sets out, and the hooks return at once.

**A failed state is retried only when someone runs `squiz review`.** A hook
firing on it queues nothing, so a turn spent reading a failure note does not
bring the failure back. A retry that fails again posts its failure comment,
exits 1 and writes no second note, and its stderr tells the coding agent not to
run the command again (§ 6 `squiz review`). A new commit or reply is a new state, and is queued like any other.

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
| Nothing open, rounds remaining | The episode does not close. A is recorded as *reviewed clean, episode open*: no exit status, no summary, and no note for its owner. B is reviewed next, and the episode closes from the last round with nothing queued behind it. A run of `squiz review` waiting on A goes on waiting, for the state the queue ends on, and returns that state's result: 0 or 3 with the close, or 2 where B left threads open. It exits 4 where its wait runs out first. |
| The round cap reached, or the token bound | The episode closes, as it must, and posts its summary. Its Notes name the cap or the bound and each state left not reviewed, whether A left threads open or nothing. B is recorded as not reviewed, with the reason. A run of `squiz review` waiting on B is handed the close, exit 0 or 3, with a line saying why B was not reviewed, and B's owner gets a note saying the same. |

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
naming the state that superseded it as § 5's Notes do:

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
exits 4 where its wait runs out first, as § 6 shows.

**A round decides its close and records it in one step.** It reads the queue
under `state.lock`, decides from it as the table above sets out, and writes the
close in that same update, before it posts the summary. A trigger that comes
after the close finds it and queues nothing, so no state queued while the
summary is posted is stopped by a close it arrived before. A round that finds
the round cap or the token bound already spent, and closes the episode without
starting a reviewer (§ 5), also writes the close before it posts the summary.

**A state left not reviewed is named by its short head commit, followed by "with
different replies" where an earlier state has the same commit.** The earlier
states are the one the round that closed the episode reviewed, and those
queued ahead of it:

```
Squiz did not review PR #41 at 3f9c2e0 with different replies: the episode closed at the round cap, after reviewing 3f9c2e0.
```

**The state file keeps the reviewer's last ruling on each thread**, by the
thread's node id: `fixed`, `withdrawn` or `open`. A close that runs no reviewer
counts the thread by it (§ 5). A round writes its rulings in the update that
records its cost, before it posts anything, so no verdict reaches a thread unless
its ruling is on record. A state file that will not take that update fails the
round with nothing posted. A thread a finished review gave no verdict is kept as
`open`. A failed round writes the rulings it salvaged, and leaves every other
thread's alone. A ruling is kept whether or not GitHub then takes it.

**A closed episode stays closed in its worktree.** A second episode on the same
pull request starts in another worktree on the same branch, which holds no state
for it.

### A round, step by step

1. **Gate on the pull request.** The trigger checks that pull request `<number>`
   is open and that its head branch is checked out in the directory it was run
   in, not another branch or a detached HEAD. The round host checks again when
   the round starts. Where either check fails, no review runs and nothing is
   posted. `squiz review` exits 1, and stderr names what it found:

   ```
   squiz: no review ran: PR #41's head is "feature-a", and "/work/squiz" has "main" checked out
   ```
2. **Gate on the episode.** An episode that has reported its close is over:
   `squiz review` prints the close and exits as the close did, whatever the round
   cap or the token bound would now allow. Otherwise the record for the pull request's
   state decides whether it is queued (The state file).
3. **Run the reviewer.** The round host starts the reviewer in a session of its
   own (§ 4). It hands the reviewer the pull request and the threads the reviewer
   opened on it, in a snapshot of the state's head commit.
4. **Post the findings, and act on the verdicts.** Each new finding opens a
   thread, anchored to a file and a line or to a file as a whole. `fixed` and
   `withdrawn` reply on their thread and close it. `open` re-opens the thread or
   leaves it open, and replies with the reviewer's reason. § 4 Findings gives
   each reply.
5. **Record the open threads.** Where threads are open and the round cap is not
   reached, the round records the result and tells the session that owns the
   work (The report). A run of `squiz review` waiting on it prints the open
   threads and exits 2 (§ 6). A thread a person opened is never counted, so it
   never keeps the loop going.
6. **Close the episode.** Otherwise the round closes the episode, unless nothing
   is open and a later state is queued behind it, as The state file sets out. It
   records the close in the same update that read the queue, then posts one
   summary comment. `squiz review` exits 0 where nothing is open, and 3 where the
   cap or the token bound closed the episode with threads open.

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
the coding agent. With a cap of 1, the first round is the closing round. After
it, a new commit or reply queues nothing, and whatever is left open is a
person's.

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

**Squiz registers `squiz hook` on Claude Code's `Stop` and `SubagentStop`.**
`Stop` fires when a regular session's turn ends, and `SubagentStop` when a
subagent's does. Each firing resolves the pull request whose head is the branch
checked out in the payload's `cwd`, records the session that owns the work,
queues the state as The state file sets out, and returns. It never runs a round
and never blocks the agent: it exits 0 whatever it found. Where it finds no pull
request it writes the line under step 1 naming the branch and the directory.

**The worktree comes from the payload's `cwd`, never from the directory the hook
process runs in.** Under Claude Code the two are the same directory. Copilot runs
a plugin's hook in the plugin root, so the hook's own directory is the plugin
checkout. A payload with no `cwd`, or with one that is not an absolute path,
queues nothing, and the hook says so on stderr. So does a `cwd` that is in no git
worktree.

```json
"Stop": [
  { "hooks": [ { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/bin/squiz hook", "asyncRewake": true, "timeout": 86400 } ] }
],
"SubagentStop": [
  { "hooks": [ { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/bin/squiz hook" } ] }
]
```

| Event | The owner of the work it records |
|---|---|
| `Stop` | The session itself, from the payload's `session_id`, and its `CLAUDE_CODE_MESSAGING_SOCKET` where the hook's environment carries one |
| `SubagentStop` | The session that dispatched the subagent, from the payload's `session_id`, and its `CLAUDE_CODE_MESSAGING_SOCKET` where the hook's environment carries one; and the subagent, from its `agent_id` |

**GitHub Copilot CLI runs the same two registrations from the plugin, and the
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

Under Claude Code the `Stop` registration runs in the background, so the session
does not wait on it. After it has queued, it stays to deliver a note, as The
report sets out. The `SubagentStop` hook returns as soon as it has queued, and
so does the `Stop` hook under Copilot, which waits for every hook to end before
the session goes idle.

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
note:

```
to=60517e1f-e1dc-49b1-8e39-6fcbe686f3fb
pr=41
head=3f9c2e07b1d4a8c6e5f0923b7a1d6c4e8b2f5a90
subagent=a402ef8f56c1b2ed1
text=Squiz reviewed PR #41 at 3f9c2e0, the work of subagent a402ef8f56c1b2ed1: 2 threads are open. Run `squiz review 41` to read them.
```

The note points, and carries no finding. `subagent` is there only where a
subagent did the work. A failed state gets one note, however many times it fails,
and a state not reviewed gets one saying why. A state no hook recorded an owner
for gets no note.

For a round that failed, the text gives the reason and names `squiz status`.
Where a round remains under the round cap and the token bound, it says that a new
commit, or running `squiz review` once, retries it:

```
text=Squiz could not review PR #41 at 3f9c2e0: the reviewer could not run: the provider refused the credential. `squiz status` lists it. A new commit, or running `squiz review 41` once, retries it.
```

Where no round remains, the text ends as the failure comment does, saying the
review is closed and which bound closed it (§ 7 The failure comment).

**Then it wakes a Claude Code owner, one of two ways.** Whichever delivers a note
moves it into `delivered/` beside it, so the other does not deliver it again.

- **The messaging socket.** Where the hook recorded a socket for the owner, the
  round host posts the text to it, and an idle session starts a turn with it.
  The post is one JSON line,
  `{"type":"user","message":{"role":"user","content":"<text>"}}`, on a
  connection the host ends, and nothing is read back.
- **The `asyncRewake` waiter.** The `Stop` hook, once it has queued, waits while
  any state its session owns is queued or under review. When a note for its
  session arrives it writes the text to stderr and exits 2, which starts a turn.
  It delivers any note already waiting for its session first. Of several waiters
  for one session, only the newest delivers, and the others exit 0.

**A Copilot owner is woken through the plugin's extension.** Copilot loads
extensions only with its experimental features on, so squiz's Copilot support
is experimental as a whole, and § 9 has the user turn them on. Copilot starts
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
whose socket path is too long for the extension (§ 9). Its reviews still run.
It learns the result from its own `squiz review`, and one it ran in the
background wakes it when it exits.

**A note no wake reached stays where it was written.** The owner learns the
result by running `squiz review` or `squiz status`, and the pull request holds it
in any case. A note for a session that was closed is delivered only by that
session's next `Stop` waiter.

### Parallel coding agents

**Each worktree is reviewed on its own.** `squiz review` resolves the worktree
with `git rev-parse --show-toplevel` from the directory it is run in, and the
hook from the payload's `cwd`, which for a subagent is fixed when it is
dispatched. One worktree, one branch, one pull request, one episode.

**The harness does not remove a worktree.** The coding agent is still in it when
the command returns. Whatever created the worktree removes it. The episode's
state goes with the worktree.

**A tree two episodes share keeps them apart.** One tree holds two pull
requests' episodes when its `HEAD` moved to another branch while the first
episode was live. Each keeps its state under its own number, and each reviewer
reads a snapshot of its own pull request's head commit.

**Two coding agents on one branch in one tree share one episode, and nothing tells
them apart.** They spend one round cap between them. Nothing detects this.

## 4. The reviewer

The reviewer is a second agent that reads the code the coding agent has just
written and reports what is wrong with it. It has no GitHub access of its own:
it reports each finding as it confirms it, and the harness turns each one into a
comment on the pull request.

### Invocation

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
| **A thinking level** | How hard the reviewer thinks. The harness sets it every round, so the level never comes from the reviewer CLI's own configuration. The levels are listed under Configuration. |
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

### The reviewer session

**Each round's reviewer runs as a session of its own, where a person can watch
it.** The round host starts it in the first place that applies:

| Where | How the round host starts it |
|---|---|
| Herdr, where `HERDR_SOCKET_PATH` is set | `herdr tab create --cwd <snapshot> --label squiz-41-r2 --no-focus --workspace <id>` gives a pane, in the workspace the state's record names, and in the focused workspace where it names none, and `herdr pane run <pane> '<gated command line>'` types the reviewer's line into the pane's shell once the shell is at its prompt |
| tmux, where `TMUX` is set | `tmux new-window -d -n squiz-41-r2 -c <snapshot> '<command line>'` |
| Neither | As a child of the round host, with no terminal |

The command line is the one the adapter built: `pi`'s, or the Copilot adapter's
shell line, which starts Copilot. Below, "the reviewer" is that command.

**The Herdr workspace is the trigger's.** A trigger records the
`HERDR_WORKSPACE_ID` in its environment on the state's record. Herdr sets it in
every pane it manages, so the reviewer's tab opens beside the coding agent's
pane. A workspace id is a `w` and a number, such as `w2`, and a value of any
other shape is not recorded.

**In Herdr, the start returns once the reviewer is running, and the round's
bound is all that limits the review.** `herdr pane run` types a line and returns
at once. The line is the reviewer's behind a gate, each word single-quoted:

```
'/bin/sh' '-c' '<gate>' '/tmp/squiz-gate-Xa81Qe' '400' 'pi' '--session-dir' …
```

**No line over 512 bytes is typed**, because a new pane's shell can drop part
of a long line before its line editor starts. A longer gated line is written to
a file named `line` in the gate directory before the tab is created, and the
line typed runs that file, which removes itself and then execs the gated line:

```
'/bin/sh' '/tmp/squiz-gate-Xa81Qe/line'
```

tmux types nothing: the command line is `new-window`'s own argument.

The gate writes its pid into the gate directory, waits for a `go` file there,
and then becomes the reviewer with the same pid, group and start time. The
round host reads the pid and the reviewer's group while the gate is shut, and
only then writes `go`, so a start that fails never lets the reviewer run. A
gate left waiting gives up on its own after four times the bound on each
program the start runs, without running the reviewer. Where the reviewer's
command is not on the shell's path, the gate says so and the start fails at
once. Where the reviewer has not started 15 seconds after the line was typed,
the start fails.

**A pane's shell reads the line as typed**, so a control character in an
argument would be a key. The round host checks the arguments before it creates
the tab, and treats a command holding one as a pane Herdr refused: nothing
opens, and it goes on to tmux or a child.

**The variables the round sets reach the reviewer on every backend, over any
value the pane's shell gives them.** They are the adapter's, and the GitHub
variables under Tools, which come last so that no adapter can undo them. A child
has them in its environment. A pane gets them through Herdr's `--env` and tmux's
`-e`, and again as `env` arguments in front of the gate or the reviewer, because
the shell's startup files can set any of them again:

```
'/usr/bin/env' 'SQUIZ_REPORTS=…' 'GH_TOKEN=' 'GH_CONFIG_DIR=…' … '/bin/sh' '-c' '<gate>' …
```

`env` then becomes the gate or the reviewer, so the pid, group and start time
the round reads are still the reviewer's.

**The pane closes when the review ends, and the session stays resumable.** tmux
closes a window when its command exits. Herdr returns the pane to its shell when
`pi` exits, and the round host then closes it with `herdr pane close`. Each
round's `pi` writes its session to `.squiz/<number>/rounds/<k>/session/`, and the
round host writes the command that resumes it to `rounds/<k>/resume.txt`:

```
pi --session-dir .squiz/41/rounds/2/session --session 0193f2c4-7d1e-7b52-9c1a-5e2f4d8a6b31
```

`squiz status` prints it on the round's line. A person runs it from the coding
agent's worktree, which the paths are relative to. The snapshot the session ran
in is gone, so `pi` asks to fork the session into the current directory, and
answering yes opens the reviewer's conversation there. A conversation resumed
after the round is not part of the review. Copilot's resume line is under The
Copilot adapter.

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

A pane close is not relied on to stop anything: neither backend's close reaches
a process in a session of its own, and a command that ignores `SIGHUP` outlives
a tmux window.

### The snapshot

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
review, under its 30 seconds (§ 7 The review budget).

**The snapshot borrows the repository's objects and shares nothing else.**
`--shared` lets the clone read every object the repository has without copying
one, a head commit the fetch brought included, so `git log`, `git blame` and
`git show` in the snapshot answer as they would in a worktree at the same
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

Two worktrees, or two rounds of one episode, never share a path, and the same
worktree, number and round always give the same path.

**No component the harness adds to the path begins with a dot**, wherever the
coding agent's worktree is. A `TMPDIR` whose own path has such a component is
the user's, and the harness does not change it.

**The round host refuses to make a snapshot where `squiz-<uid>` is not the
user's alone**: a link, a directory another user owns, or one that a group or
other users can write, since another user could make that path first in a shared
`/tmp`. The round then fails before the review, as any snapshot that cannot be
made does.

**The snapshot holds the commit and nothing else.** It carries none of the coding
agent's uncommitted changes, which no state names, and none of its untracked
files, build output or installed dependencies. It is not a worktree of the
repository, so it shows in neither the coding agent's `git status` nor
`git worktree list`.

**The round host removes the snapshot once the round has recorded its result**,
whatever the round became, and before it takes the next queued state. It
deletes only a path of the form above, inside `squiz-<uid>`, then removes
`rounds/<k>/`, `rounds/` and `<digest>-<number>/` where each is empty. Removal
takes no part of the round's deadline, and needs nothing from the repository, so
it works where the coding agent's worktree has gone.

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

- **Time and disk on every round.** The checkout grows with the repository, not
  the change, and the disk held at once is the checkout's size times the reviews
  running at once, on the temporary directory's filesystem.
- **A snapshot nothing removes stays** until the system clears its temporary
  directory or a person deletes it: one whose round host was killed and that no
  later trigger finds, or one its round could not remove.
- **Pruning the repository breaks a running round.** A `git gc --prune=now`, a
  `git prune`, or a `gc.pruneExpire` of `now` deletes a fetched head commit no
  ref reaches, and the history tools then fail. An ordinary `git gc` keeps it for
  two weeks. The round does not guard against pruning.
- **A repository whose checkout spends the 30 seconds before the review cannot
  be reviewed.**

### Tools

**Every reviewer is granted the same tools, every round.** No setting changes
the grant. It holds three kinds of tool, under each adapter's own names:

| | `pi` | Copilot |
|---|---|---|
| Reading | `read`, `grep`, `find`, `ls` | `view`, `grep`, `glob` |
| Reporting | `report_finding`, `report_verdict`, `finish_review` | `squiz-report_finding`, `squiz-report_verdict`, `squiz-finish_review` |
| History | `git_log_search`, `git_blame`, `git_show` | `squiz-git_log_search`, `squiz-git_blame`, `squiz-git_show` |

The history tools answer whether a line was meant. The reporting calls are how
the reviewer returns what it found, as Findings sets out. Copilot names a call an
MCP server serves `<server>-<call>`, and the server the Copilot adapter ships is
`squiz`. Nothing else is granted: no tool that writes, and no shell
(Confinement).

**Each history tool runs one `git` subcommand in the snapshot, and no argument
reaches a shell.** Each runs `git` from an argument list, with the reviewer's
arguments as separate words:

| Tool | Takes | Runs |
|---|---|---|
| `git_log_search` | A term | `git log -S<term> HEAD`: the commits that added or removed the term, newest first, each with its message and the files it changed. The term is matched as literal text. |
| `git_blame` | A file and a line | `git blame -L <line>,<line> HEAD -- <file>`: the commit that last changed that line, with its author and date. |
| `git_show` | A commit | `git show` on the one commit the name resolves to: its author, date, message and change. A range, a tree or a file at a revision is refused. |

**The history tools are hardened against the repository they read**, whose
tracked files are the code under review's to set:

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

They are set empty rather than left out, so that they replace any value a pane's
shell has (The reviewer session). A `gh` that the reviewer's CLI or a tool
starts finds no login.

The credential each CLI needs for its model is left alone: `pi`'s provider key,
such as `DEEPSEEK_API_KEY`, and Copilot's login. Copilot signs in from
`COPILOT_GITHUB_TOKEN`, which is left set where the round host has it, from a
login of its own, or from `gh`'s login, which it reads by running
`gh auth token`. Whether a login from Copilot's own `/login` reaches a reviewer
under the adapter's `COPILOT_HOME` is untested (#695). A user who signs Copilot in through `GH_TOKEN` or
`GITHUB_TOKEN` alone has no model credential in the round, and nothing here
handles that.

**The system's credential store stays readable.** `gh auth token` prints `gh`'s
login from the keychain whatever `GH_CONFIG_DIR` names, and Copilot signs in
through it, so that login cannot be closed to the reviewer without closing it to
Copilot. An operating-system sandbox would close it (#529).

### Confinement

The reviewer must not change anything the coding agent would commit, and must
not read anything outside the code under review. Four things hold it there. None
is configurable, and each holds for both adapters, every round.

**No tool writes, and none is a shell.** The grant under Tools is everything the
reviewer can call, and it leaves out `edit`, `write` and every shell tool. A
reporting call reaches the round reading the reviewer's output, and nothing on
disk.

**The reading tools read the snapshot and nothing outside it.** A path is inside
where its real path, every link resolved, is inside the snapshot's real path, so
an absolute path elsewhere, a `..` path, and a link that points out are each
refused before anything is read. Each adapter confines its tools differently:

| Adapter | What refuses a read outside the snapshot |
|---|---|
| `pi` | The extension's `tool_call` handler, for `read`, `grep`, `find` and `ls`. It resolves the path as `pi` does: a leading `@` dropped, `~` taken as the home directory, a `file://` URL taken as its path, and the rest resolved against the snapshot. Where the path does not exist, the spelling `read` would open in its place is the one checked. A path that is not a string is refused. The reviewer reads ``squiz refused this call: `<path>` is outside the code under review.`` as the call's error, and the refusal is recorded like any other. |
| Copilot | Copilot's own path check, which refuses any path outside its working directory and the system's temporary directory. `--disallow-temp-dir` removes the temporary directory, where every snapshot is made, so of everything under it the reviewer reads only its own snapshot, which is its working directory. `--allow-all-paths` and `--add-dir` are never passed. |

No tool reads outside the snapshot on purpose. The charter, the prompt and
Copilot's agent file are read by the CLI itself, from its command line and its
`COPILOT_HOME`, and no granted tool reads them.

**The history tools only read.** They are hardened as Tools sets out, and a file
`git_blame` is given is confined to the snapshot as a read is.

**`pi` refuses every call outside the grant.** The extension's `tool_call`
handler refuses a call to any tool `grants` does not name, before it runs. It
holds if the grant ever stops being passed, when `pi` would fall back to its
default tools, a shell among them. The reviewer reads
``squiz refused this call: `<tool>` is not a tool this review grants.`` as the
call's error, and the refusal is recorded like any other. Copilot disables every
tool `--available-tools` leaves out, as The Copilot adapter sets out.

### Adapters

An adapter is the code that knows how to drive one reviewer CLI. There are two,
for `pi` and for the GitHub Copilot CLI, and `reviewer` in Configuration chooses
between them. A further reviewer means writing a further adapter and changing
nothing else. An adapter implements four things:

| | |
|---|---|
| `argv(opts)` | Build the command line from a working directory, a charter file, a prompt, a session directory, the thinking level and the model. |
| `confine(opts)` | Put in place whatever the CLI is handed outside its command line, check what the CLI cannot be trusted to refuse, and return what to add to its environment. A CLI handed nothing returns an empty environment and writes no file. |
| `read(reports)` | Report each finding and each verdict as the run makes it, from the file the reviewer reports into, and return the run's cost where the CLI reports one, with the models the CLI reported that cost against. A run the CLI reports as failed is told apart from one that reported no findings. |
| `grants` | The tools the CLI is given, as one list in the CLI's own names: the reading tools, the reporting calls and the history tools, as Tools sets out. |

**A configured model runs the round, or the round fails at setup.** The adapter
passes it as an argument of its own, never through a shell's parsing. Where no
model is configured, the command line and the environment are exactly what they
are without the setting. A CLI that falls back to another model when handed one
it does not offer is checked in `confine` first; one that refuses such a model
before its first request is left to refuse it. Either way the round fails as a
setup problem, with no review run and nothing spent, and the reason names
`model` and its value:

```
"model" in .squiz.json is "openai/gpt-5", which is not a model pi offers; it must be a provider and model as pi --list-models lists them, such as "openai/gpt-5-mini"
```

Where a run with a configured model completed no message, the round adds the
model to the reason:

```
the reviewer completed no message; "model" in .squiz.json is "gpt-5-nano", which the reviewer's CLI may not offer
```

**An adapter may ship files its CLI runs**, where reporting a finding or running a
history tool needs one: an extension the CLI loads, or a server it starts. Each
is the adapter's own, it is named on the command line `argv` builds, and the
names it registers are in `grants`. The `pi` adapter ships an extension, and the
Copilot adapter ships a server.

**Every reporting call is checked by the harness's own report checks, whatever
serves it.** They decide what a report must carry, and refuse one the harness
could not compose a comment or a mutation from. A CLI may convert an argument
before the checks see it, as `pi` does, or validate nothing, as Copilot does. The
schema the model is shown guards nothing.

**A finding reaches the harness as `read` reads it out of the report file, and
so does the run's cost.** An adapter whose CLI cannot report before the run ends
reports everything at the end, so its rounds keep nothing when they are killed.
One whose CLI reports its cost only at the end writes the cost then, and a run
stopped before that has no cost.

**A reviewer CLI must exit on `SIGTERM`, and so must every process it starts.**
The time bound signals the reviewer's process group and waits a grace before
escalating. An adapter for a CLI that ignores `SIGTERM` is not one this harness
can hold.

**The exit status does not say how a run ended.** A CLI can exit 0 when it was
stopped, as Copilot does. A run declared its review finished where the report
file holds the finish, and the round knows when it stopped a run itself. Nothing
else is read for it.

**The history tools run inside the reviewer's own group**, in the extension `pi`
loads and in the server the Copilot adapter ships, so the signal that stops the
reviewer stops the `git` they start.

**Each adapter tells the history tools where the snapshot is:**

| Adapter | Where the history tools find the snapshot |
|---|---|
| `pi` | The directory `pi` was started in, which is the snapshot, as for the reads the extension confines. |
| Copilot | `SQUIZ_SNAPSHOT`, the snapshot's absolute path, which the adapter puts in the `env` of the reporting server's MCP configuration (The Copilot adapter). |

A history tool that finds no snapshot named answers with its error and runs
nothing.

### The `pi` adapter

The adapter `reviewer` chooses by default. It must:

- **Hand `pi` the prompt as a file**, read into its first message, so that no
  argument carries a newline, which a pane's shell would read as a key.
- **Grant exactly the tools Tools names.** `pi` drops a name the grant does not
  carry without saying so, so a grant short of a reporting call leaves the
  reviewer no way to report.
- **Load its own extension and no other.** The extension registers the reporting
  calls and the history tools, and refuses a call outside the grant and a read
  outside the snapshot, as Confinement sets out. With no other extension loaded,
  none can register a tool under a reporting call's name.
- **Keep the tree's `pi` configuration out, and leave the user's alone.** The tree
  under review is untrusted, so none of its `.pi/` configuration reaches `pi`.
  The adapter writes none of `pi`'s settings. `pi` loads `AGENTS.md` and
  `CLAUDE.md` itself, which is how the project's conventions reach the reviewer.
- **Set the thinking level on every run**, so that it never comes from the
  user's own settings.
- **Run `pi` interactively in a pane, and in print mode with no standard input
  when detached.**
- **End the reviewer**, because interactive `pi` waits for input once its agent
  settles. After `finish_review` the extension records the finish and shuts
  `pi` down once its closing message is written. When the agent settles with no
  finish, it records an unfinished end and shuts `pi` down.

**A configured model is `provider/id`, exactly as `pi --list-models` lists it**,
such as `openai/gpt-5-mini`. `pi --model` matches a bare name loosely and sends
an unknown id to the provider as it is, so `confine` lists the models in the
snapshot, which makes no model request, and prepares the round only where the
configured model is listed exactly. A bare id listed under one provider is
refused with its full name in the reason. A `pi` that cannot list fails
`confine`. With no model configured, `pi` runs on the user's default.

**The reviewer's reports reach the round through a file.** The extension appends
one line to `.squiz/<number>/rounds/<k>/reports.jsonl`, which `SQUIZ_REPORTS`
names, for each of these, in the order they happen:

- every report a call accepted, as the extension accepted it;
- every call it refused, with the refusal;
- every assistant message's usage, `stopReason`, `provider` and `model`, with its
  `errorMessage` where it has one;
- the finish, when `finish_review` is called;
- an unfinished end, when the agent settles with no finish recorded.

The adapter reads the file as it grows. A report is the value the call accepted,
after `pi` converted its arguments to the schema's types.

**A round's cost is the sum of its assistant messages' usage**, returned with the
token count, which tells a model `pi`'s catalogue cannot price from a round that
cost nothing. A round's models are the ones its messages name, each as
`provider/model`, or as the model alone where a message names no provider, in
the order the run first named each. A provider or a model that is not text is a
line that cannot be read.

**A round's cost is a floor**, at least what the round spent, where:

- the file's last line is not a message's usage, because every run ends on an
  assistant message;
- the time bound stopped the reviewer;
- a line of the file could not be read, or the file could not be read to its
  end.

A round that ran the reviewer twice has a floor where either run does.

**How the run is read back:**

- A message whose `stopReason` is `error` carries zero usage and does not fail
  the run, because `pi` retries a failed request itself.
- The run reached no reviewer where no assistant message carries a `stopReason`
  of `stop` and no finish was recorded. The adapter reports the errored message's
  `errorMessage`, and does not start a second run.
- The round is over when the reviewer's process has exited, or when the time
  bound stops it. What arrives between the finish and the exit is part of the
  review.
- A round holding the reviewer's declaration is the review it declared, whatever
  ended the run.
- A line of the report file the adapter cannot read fails the round, declaration
  or not, and the reports that were read stand.

### The Copilot adapter

The adapter for the GitHub Copilot CLI, which a project chooses with
`"reviewer": "copilot"`. It must:

- **Run Copilot non-interactively, in a pane and detached alike**, so that it
  exits by itself once the reviewer's last message is written, with nobody to
  answer it.
- **Hand Copilot the prompt byte for byte**, read from its file as Copilot
  starts, so that no newline reaches the line a pane's shell reads. The prompt
  must fit in one argument, which Linux limits to 128 KiB, and nothing here
  handles a longer one.
- **Put the charter in the system prompt**, as the instructions of a custom agent
  the adapter writes into its own `COPILOT_HOME`, where it wins over a tree's
  agent of the same name.
- **Grant exactly the tools Tools names**, which disables every other tool,
  `skill` and every shell tool among them.
- **Confine reads to the snapshot** with Copilot's own path check, with the
  temporary directory taken out of it (Confinement).
- **Keep the tree's and the user's configuration out:**
  - its own `COPILOT_HOME`, holding the agent file and no trusted folders, so
    that none of the tree's hooks or MCP servers runs;
  - `COPILOT_ALLOW_ALL` set empty, since `true` would trust the working directory;
  - the tree's custom instruction files left out of the system prompt;
  - the built-in GitHub MCP server off;
  - no directory added with `--add-dir`, which would load its skills and agents
    as trusted.

  None of the user's own Copilot configuration reaches the reviewer except its
  default model, where the project configures none. The reviewer still signs in
  through `gh`'s login (Tools), and reads the tree's `AGENTS.md` with `view`, as
  the charter tells it to.
- **Set the reasoning effort on every run**: `thinking` as it is, and `off` as
  `none`.
- **Start the reporting server the adapter ships**, with `SQUIZ_REPORTS` and
  `SQUIZ_SNAPSHOT` in the `env` of its MCP configuration.
- **Append the run's usage to the report file only where Copilot exits 0 by
  itself.**

**The reviewer runs on the configured model, or else the user's default.** A
configured `model` is Copilot's own name for it, such as `gpt-5-mini`, and goes
on `--model`. Copilot refuses a model the user cannot use before any request,
exiting 1 and spending nothing. `COPILOT_MODEL` never carries a configured model,
because Copilot runs on some other model, and exits 0, when that variable names
one it does not have.

With no `model` configured, `confine` reads `model` from the user's own
`settings.json`, under `~/.copilot/` or the `COPILOT_HOME` the user set, and
returns it as `COPILOT_MODEL`, so that a pane runs it too. A `COPILOT_MODEL`
already in the round host's environment is the user's default, and is returned
in place of the setting. A `settings.json` that is there and cannot be read, or
does not hold a JSON object, fails `confine`. Where the user has neither, the
round runs on whatever Copilot falls back to, and nothing makes sure that is a
different model from the coding agent's, as § 2 requires.

#### The reporting server

**The reporting calls and the history tools are served by an MCP server the
adapter ships**, over standard input and output. It lists the three reporting
calls with the schemas the report checks declare, and writes the same lines to
the report file as `pi`'s extension does. It lists the three history tools after
them, and runs each in the directory `SQUIZ_SNAPSHOT` names. A call to a tool the
server does not serve is a protocol error. Copilot hands the server its own
environment, so the emptied GitHub credentials reach it too.

**The server checks every call itself, because Copilot validates none.** A
reporting call must meet the report checks, and a history tool's arguments must
match its schema before it runs. Either refusal, and a history tool that failed,
is answered with `isError: true` and the reason as its text, which Copilot hands
to the model as the call's error:

```
MCP server 'squiz': git_blame was not run: line must be an integer.
```

Nothing converts an argument first, so a report records what the model sent.

**The server goes on answering while a history tool runs.** A
`notifications/cancelled` naming a running history tool stops its `git`, and
that call is not answered. The server exits when its standard input closes, and
on `SIGTERM` and `SIGHUP`.

#### How the run ends and is read back

**Copilot exits by itself whether or not the reviewer finished its review**, so
the finish in the report file is what says it did. The usage line Copilot's run
leaves reads as:

| Figure | Read as |
|---|---|
| Tokens | The sum, over every model in `modelMetrics`, of `inputTokens` and `outputTokens`. `inputTokens` already holds cache reads and cache writes. |
| AI credits | `totalNanoAiu`, at 10⁹ to a credit. |
| Messages | The sum, over every model, of `requests.count`. |
| Models | Each model in `modelMetrics` whose name is not blank and whose `requests.count` is a number above zero, in the order the file lists them. |

A Copilot round has no dollar figure. A usage line with no model in
`modelMetrics`, or with a model that lacks `inputTokens` or `outputTokens`,
reports no usable cost.

| The file holds | The run |
|---|---|
| A finish | Reviewed |
| No finish, and a usage line counting at least one request | Stopped without finishing |
| No finish, and no usage line or one counting no request | Completed no message |

A run that wrote nothing to the report file completed no message: Copilot could
not be started, its model provider refused the run, or Copilot refused the
configured model. Detached, the round adds the run's stderr to the reason.

**A Copilot round records a cost only where Copilot ended by itself and its
usage line carried token counts.** That cost is Copilot's own total, and is never
a floor. Any other round records no cost and names no model, because the usage
line is the only place a Copilot run names one. A round the time bound stopped
leaves no usage line.

**The reviewer's process group holds everything the run starts**, the reporting
server and the `git` its history tools run included, and nothing in it traps a
signal.

The round writes the command that resumes the run's session to `resume.txt`:

```
COPILOT_HOME=.squiz/41/rounds/2/session copilot --resume=99b4a257-0666-4e1f-a9a2-94d9c79b14be
```

### Charter

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

### Findings

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
every other report: one malformed finding costs that finding and nothing else.

**A round keeps every finding reported before it ended, however it ended**:
killed at its time bound, never finished, or cut off from its model. None of
those is a review, and § 7 records each as the failure it was.

**The call that finishes the review is what tells an empty review from an
unfinished one.** A round that reported nothing and finished found nothing. A
round that reported nothing and did not finish failed.

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

Severity orders the findings and does not decide whether they count. The order
runs `high` to `low`, and findings of one severity keep the order the reviewer
reported them in.

Every round hands the reviewer the threads it opened, resolved and open alike,
from every episode on the pull request, and it reports one verdict for each from
the code as it now stands. A thread is the reviewer's own when the comment that
opened it carries the reviewer's marker from § 2, whoever replied on it since.
Resolved threads go over because re-opening one is a verdict. A thread a person
opened is left alone: it is not handed over, no verdict is applied to it, and
nothing in the loop reads or answers it.

A verdict carries three fields:

- `thread` — the identifier the thread was handed over under, copied back.
- `verdict` — `fixed`, `withdrawn` or `open`.
- `reason` — required on `open` and `withdrawn`, and refused on `fixed`. On
  `open` it is the reviewer's feedback to the coding agent: what is still wrong
  in the code as it now stands, and what change or argument would settle it. On
  `withdrawn` it says why there was no defect. A verdict of `open` or
  `withdrawn` with no reason, or with one that is blank, is refused.

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
reviewer's reason beneath:

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
`fixed` or `withdrawn` verdict. The round still sends the resolve, whose report
is its only evidence the thread is closed. An attempt that spends no round, such
as a setup problem that salvaged a verdict, names the commit and no round, as
`Confirmed at 1b86987.`

The next `squiz review` prints the replies with the thread's other comments
(§ 6), which is how the coding agent receives a reason.

**A reply that cannot be posted leaves the verdict standing.** The thread is put
in the state the reviewer ruled, and a closing reply that fails does not stop
the resolve after it. The round names the thread and what GitHub answered on
`squiz review`'s stderr, and in `squiz status`. A failed reason on a thread kept
open is named in the summary's Notes only by the round that closes the episode,
since a later round posts a reason of its own. A failed reply on a thread the
round closed is kept in the round's entry in the state file, and named by the
summary that closes the episode (§ 5), or by the failure comment of a round that
fails.

A thread the reviewer returns no verdict for is treated as `open` where the
reviewer finished its review, and nothing is posted on it. Where the review did
not finish, such a thread is left as it was handed over.

Every finding posted as a thread ends its episode in one of four states. The
reviewer names the first two; the harness reads the last two off the thread when
the episode closes. A close that runs no reviewer can also find a resolved thread
with none of them, as § 5 sets out.

| Status | What it means | Needs a person |
|---|---|---|
| `fixed` | The defect was there and is gone. | No |
| `withdrawn` | There was no defect. | No |
| `open` | Still unresolved at the close of the episode, with no reply from the coding agent. | Yes |
| `disputed` | Still unresolved at the close of the episode, and the coding agent replied. There is a disagreement for a person to settle, and the thread carries both sides of it. | Yes |

### The comment format

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

### Pull request comments

A finding's `scope`, which the reviewer sets, decides where its comment goes:

- **Inline**, for a finding scoped to `line`. It becomes a review comment thread
  anchored to a file and a line that the change touched. This is the normal case.
- **File**, for a finding scoped to `file`. It becomes a review comment thread on
  the file, carrying no line.
- **General**, for a finding scoped to `change`. It goes into the summary comment
  as a line of text, so nothing records whether it was fixed, and no later round
  rules on it.

A finding about code the change did not touch is still scoped to `line`, and
anchored to the changed line that caused it, with the affected file and line
named in the body. An anchor is one line: where the defect is visible, as the
charter instructs.

An anchor the harness cannot place is posted on the file instead, with
`file:line` written in the text. Where the diff does not carry the file either,
the finding is reported as general, and the summary's Notes records that it
could not be anchored. A finding scoped to `file` whose file the diff does not
carry goes to Notes the same way.

A file-scoped comment is a thread like an inline one: it is resolved, re-opened
and ruled on, and it carries across rounds.

## 5. The summary

One comment is posted on the pull request when an episode closes. It carries the
status of every finding, what each round did, and the cost of the review. It is
never edited or replaced, so a second episode on the same pull request posts a
second comment.

**An episode reports its close once.** The round that closes it writes the
close to the episode's state, and then posts the comment, as The state file
under § 3 sets out. Every path that ends an episode writes the close, the paths
that end one with no comment included. A round that leaves threads open for the
coding agent posts no summary, and a round that failed posts the failure comment
under § 7 instead.

**A run that finds the round cap or the token bound already spent closes the
episode without running a reviewer**, as it does where a bound was lowered since
the last round. It lists the episode's threads, posts the summary from them and
from what the episode recorded, prints the open ones, and exits 3 where any are
open and 0 where none are. Where the episode ran no round, because its failed
attempts spent the token bound, and none of the reviewer's threads is on the
pull request, it posts no summary, exits 0, and says on stderr that the episode
closed before any round ran.

**A close that runs no reviewer counts each thread by its resolved state and the
last ruling the state file holds for it** (§ 3 The state file):

| The thread | Counted as |
|---|---|
| Unresolved | `open`, or `disputed` where the coding agent replied, as at any close |
| Resolved, last ruled `fixed` | `fixed` |
| Resolved, last ruled `withdrawn` | `withdrawn` |
| Resolved, last ruled `open`, or with no ruling on record | resolved, ruling unknown |

A thread resolved by a person, in another worktree's episode, or after the
reviewer kept it open says nothing about the defect, so it counts as neither
`fixed` nor `withdrawn`, and needs no person.

### What the comment carries

Four blocks, in this order.

1. **The counts, what the review spent, and who reviewed it.** Rounds run, findings raised, how many ended `fixed`, `withdrawn`, `open` and `disputed`,
   and the tokens each round spent with the episode's total, followed by the
   dollars where the reviewer's CLI priced the model, and the AI credits where it
   reported those. Then the reviewer CLI and the model each round ran on, as the
   run reported them. Findings raised counts every thread of the episode, and
   every finding that no thread holds that Notes lists. The findings that no
   thread holds carry no status. A close that ran no reviewer adds a count of
   the threads it found resolved with no ruling to count them by, and only where
   there are any:

   ```markdown
   Fixed 1 · Withdrawn 0 · Open 1 · Disputed 0 · Resolved, ruling unknown 2
   ```
2. **The findings that need a person.** Every `open` finding and every
   `disputed` one, each with its headline and where it sits: `file:line` for a
   thread anchored to a line, and the file alone for one anchored to the file.
   When there are none, the comment says so in one line.
3. **Rounds.** Each round in the order it ran, with the short commit it
   reviewed, how many findings it raised, and the rulings it replied with: each
   thread it closed while the thread was open, and each it kept open. A round
   that raised nothing and ruled on nothing says so in one line, as
   `- Round 4 at 9a0b1c2: found nothing new and ruled on nothing`. The list is
   read from the episode's state file and never from the pull request, so a
   round whose replies GitHub refused is listed all the same.
4. **Notes.** Anything else a person reviewing the pull request should know:
   - findings about the change as a whole, each with its headline;
   - a finding the harness could anchor to neither a line nor a file, with its
     `file:line`;
   - a finding whose comment could not be posted at all, with its location;
   - a thread the last round kept open whose reason could not be posted, with
     its location and headline;
   - a thread any round closed whose reply could not be posted, with its
     location, headline and ruling;
   - a ruling of the last round that could not be applied, with what the
     reviewer ruled;
   - a round whose review the time bound cut short, with the round's number and
     the bound;
   - a cap or bound that ended the episode early, with each queued state it left
     not reviewed.

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

**The findings that no thread holds are the last round's.** A round that leaves
the episode open keeps each of its own as its Notes line (§ 3 The state file),
and `squiz review` prints each on stderr (§ 6). A later round whose reviewer
finished settles them, because it reads the whole change again. So only a close
that ran no reviewer lists an earlier round's, those of the last round that
reached a result, first in Notes. A failed round lists the findings it salvaged
in its failure comment instead (§ 7 The failure comment).

**A round whose review the time bound cut short is a line of its own**, written
by the round that later closes the episode, from the episode's state:

```markdown
- The review was cut short by the 900-second time bound in round 2, and the round kept only the findings it had reported by then
```

**A cap or bound that left queued states not reviewed is one line, naming the
bound and each of those states**, as § 3 The state file names them. It takes the
place of the line the bound writes where nothing was queued:

```markdown
- The episode ended at its round cap rather than with nothing left open, and did not review 8d21a4f or 8d21a4f with different replies
- The episode ended at the token bound with nothing left open, and did not review 3f9c2e0 with different replies
```

### The format

```markdown
**Squiz review — 3 rounds, 7 findings**

Fixed 2 · Withdrawn 1 · Open 2 · Disputed 1
48,200 tokens over 3 rounds: 20,100, 16,400, 11,700 · $0.0134
Reviewed by `pi` on `openai/gpt-5-mini`

**Needs a person**

- `packages/sync/src/queue.ts:134` — Retry backoff resets on every enqueue (open)
- `packages/sync/src/session.ts:57` — Clock skew is read as token expiry (disputed)
- `packages/sync/src/retry.ts` — Every path here is dead once the queue lands (open)

**Rounds**

- Round 1 at 3f9c2e0: raised 6 findings
- Round 2 at 1b86987: raised nothing, and ruled 2 fixed, 1 withdrawn and 3 open
- Round 3 at 8d21a4f: raised 1 finding, and ruled 3 open

**Notes**

- About the change as a whole: the retry queue duplicates the scheduler already
  in `packages/sync/src/scheduler.ts`, which nothing calls
- The review was cut short by the 900-second time bound in round 2, and the round kept only the findings it had reported by then
```

Notes is omitted when there is nothing to report.

Each round is written to the episode's local state file as the review finishes,
before anything is posted. The closing replies it could not post are added when
it records its end, and its posting time once posting ends:

```json
{ "reviewer": "pi", "dollars": 0.0134, "tokens": 20100, "messages": 9, "models": ["openai/gpt-5-mini"], "elapsedSeconds": 901.2, "cutShortAtSeconds": 900, "postingSeconds": 4.3, "head": "1b86987c4f0e2d6a9b3c5e7f8a1d2c3b4e5f6a7b", "raised": 0, "ruled": { "fixed": 2, "withdrawn": 1, "open": 3 }, "unpostedReplies": ["`src/queue.ts:134` — Retry backoff resets (ruled fixed, and the reviewer's reply could not be posted on its thread)"] }
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
  order they first named each, spelled as the adapter reads them (§ 4). A round
  that ran the reviewer twice names the models of both runs. It is absent where
  no run named a model, and a round with no cost carries none.
- `elapsedSeconds` is the wall clock from starting the reviewer to having it
  stopped, to a tenth of a second. A round that ran the reviewer twice counts
  both runs.
- `cutShortAtSeconds` is the time bound the round ran under, present only where
  the bound ended a review the reviewer had not finished.
- `postingSeconds` is the wall clock from the first call of the posting reserve to
  the last, to a tenth of a second. It is absent where the round posted nothing,
  and where the round was stopped before posting ended.
- `floor` is `true` where the round's cost is a floor (§ 4, The `pi` adapter),
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
  closed that GitHub refused, and is absent where none was refused. A round
  that fails records none, and lists them in its failure comment.

A field that is there and does not hold a value of the right kind makes the file
unreadable, like any other.

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
reported**, as § 4 sets out for each adapter, never the `model` `.squiz.json`
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

## 6. Commands

Everything the harness ships to be run is a subcommand of one binary, `squiz`,
run from a shell. Squiz ships no slash command: the setup check is
`squiz doctor`.

### The `squiz` binary

A coding agent in Claude Code, and a command a person types after `!` in a
Claude Code session, run `squiz` by name, because the plugin's `bin/` is on the
Bash tool's `PATH`. Every other shell, Copilot's included, runs it by name
through the link `squiz init` makes in a directory already on its `PATH`.

| Command | Run by | What it does |
|---|---|---|
| `squiz review <number>` | The coding agent, a coordinator, a CI job | Reviews pull request `<number>` once for each head commit and each new reply on the reviewer's threads, waits for the review, and prints what is open. |
| `squiz status` | A person, a coordinator | Lists the reviews running and finished in every worktree of the repository. |
| `squiz init` | A person | Links `squiz` onto `PATH`, for coding agents other than Claude Code. |
| `squiz doctor` | A person | Prints a line per dependency, saying it is present or naming what is missing or unauthenticated, and exits 1 where a required one is not usable (The setup check). |
| `squiz hook` | Claude Code | The `Stop` and `SubagentStop` entry point, named in `hooks.json`. Queues the review of the pull request for the payload's `cwd` and returns, as § 3 sets out. |
| `squiz host <number>` | A trigger, never a person | The round host (§ 3). |
| `squiz threads` | The coding agent | Lists the open threads on the pull request for the current branch. Each line carries the thread's identifier, where the thread is, and the severity and headline of the finding on it. |
| `squiz reply <id> <text>` | The coding agent | Replies in a thread. |

```
2 open threads on #185
PRRT_kwDOUEd2qM6mPuUP scratch/paging/pages.ts:26 high — pageCount drops the partial last page
PRRT_kwDOUEd2qM6mPuVO scratch/paging/pages.ts:34 high — pageAt starts every page one page too far
```

A thread whose first comment carries none of § 2 Identity's markers was opened by
a person rather than by the reviewer. It is no finding, and its line is the
identifier and the location alone.

`<id>` is whatever `squiz threads` printed for that thread. It leads the line,
undecorated, so a line splits into the identifier and the rest at the first
space.

### `squiz review`

`squiz review <number>` runs from the worktree pull request `<number>`'s branch is
checked out in. It acts on the record for the pull request's state as § 3 The
state file sets out, and waits for the review within one deadline for the whole
invocation (§ 7). The exit status says what the coding agent does next:

| Exit | What it means | What the coding agent does |
|---|---|---|
| 0 | Nothing of this review is open. The episode is closed, and its summary is on the pull request. | Finishes. |
| 2 | Threads are open, and rounds remain. | Works the threads, pushes what it changed and replies, and runs the command again. |
| 3 | The round cap or the token bound closed the episode with threads still open, and they are printed. | Finishes, and says what is open. A person takes it from here. |
| 4 | Still reviewing. The run's deadline came before the review of this state was done, before the review of a state queued behind a clean one, or before the review of the state that superseded this one. The round goes on in the round host. | Runs the command again. |
| Anything else | The review could not run. | Reports the lines on stderr. |

Exit 4 is neither an outcome nor a failure. Every status outside the table reads
as 1 does, so a command that could not be started, or crashed past the
harness's own trap, is never read as a result.

**stdout carries the outcome and stderr carries what failed.** A run that exits 0,
2, 3 or 4 prints its outcome on stdout, and § 7 The command's stderr sets out what
it adds on stderr. A run that exits 1 prints nothing on stdout.

**The first line names a file holding the whole output**, because Claude Code can
hand the agent less than the command printed. A run that exits 0, 2, 3 or 4
writes everything it prints on stdout to `.squiz/<number>/review.txt`, replaced
on every run, and prints that path first. A file that cannot be written leaves
the outcome and its status as they are, and stderr adds one line:

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

A run whose own state was superseded before a round took it (§ 3 The state
file), and whose wait ran out before the newer state's round ended. The newer
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
follow, each as exit 3 prints it:

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
squiz: review failed: the reviewer was killed at its 900-second bound, and the round kept the 2 findings the reviewer had reported; the reviewer's 21 messages took about 43 seconds each
squiz: the failure is posted on PR #41
squiz: put these lines in your report rather than running squiz review again
```

A round that left threads open and has findings that no thread holds keeps exit
2, and prints each on stderr as § 5's Notes write it, after the line counting
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

A round host whose start cannot be told is waited on once a live process holds
`.squiz/<number>/host.lock`. Where none holds it within 10 seconds, or by the
run's deadline where that comes first, the run exits 1 saying where to look:

```
squiz: no review ran: whether the round host for PR #41 started could not be told, and none has taken the review since: the intermediate process exited 1: spawn node ENOENT
squiz: `squiz status 41` shows whether one takes it later, and .squiz/41/host.log holds what the host wrote
squiz: put these lines in your report rather than running squiz review again
```

Every number and every thread in the output is computed from what the round read
back from the pull request, so the coding agent can check each one there.

### `squiz status`

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
- **State:** the record's status, with two readings of a reviewing record. One
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
  at the round cap" or "at the token bound". Where GitHub refused some of the
  round's findings, the count follows, as "2 of 5 findings not posted".
- **Session:** the backend and the label of the reviewer's tab or window,
  `squiz-<number>-r<k>` as § 4 The reviewer session opens it, with `k` the
  round's number its record keeps. A record that keeps no `k` shows the backend
  alone. A detached reviewer is `detached`, and a state with no reviewer
  started is `—`.
- **Worktree:** the worktree's path relative to the main worktree, `.` for the
  main worktree itself.
- **Resume:** the content of the round's `rounds/<k>/resume.txt` once the round
  is over, or `—`.

The order is newest first by what the records carry:

1. Episodes with a state queued or under review come first.
2. Then episodes by the latest start or end time any of their records carries.
3. Then by the higher pull request number.

Within an episode, the newest state comes first, in the reverse of the order the
state file keeps them.

Every cell is one line. A line break in a reason, with the whitespace around it,
is printed as one space, so each state keeps its one line.

**A reviewed state's problems follow its line, one line each, indented by two
spaces.** These are what failed without changing the round's outcome, such as a
summary that could not be posted. Each is one line by the same rule as a cell,
and none of them widens a column:

```
PR    Commit   Replies  State     Started           Elapsed  Result                                                                       Session   Worktree                          Resume
#39   77e0f19  —        reviewed  2026-10-04 07:20  4m 05s   1 thread open, review closed at the token bound, 2 of 5 findings not posted  detached  .claude/worktrees/agent-a3c91e07  pi --session-dir .squiz/39/rounds/3/session --session 0193f1b2-4d6e-7a1c-9b3f-2c8d5e7f9a14
  the review of PR #39 closed without its summary: gh: HTTP 502 Bad Gateway
```

The record keeps how many findings were not posted, and not which. Where the
round closed the episode, its summary's Notes lists each one, as § 5 sets out.
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

### `squiz init`

`squiz init` links `squiz` into a directory already on `PATH`, for a coding
agent whose shell does not have the plugin's `bin/` on its `PATH`. It prints a
line for what it did, and exits 0 where the link is in place afterwards and 1
otherwise, with the line on stderr. It writes nothing in the repository it is
run from, and runs outside one as well.

- **The link's target is this squiz:** the real path of the `bin/squiz` that is
  running, every symlink resolved, so the link holds an absolute path.
- **The directory is `~/.local/bin`, or else `~/bin`:** the first of the two
  that is on `PATH`, is a directory, and can be written to. No other directory
  on `PATH` is used, even a writable one. `squiz init` creates no directory and
  edits no shell startup file.
- **Every `squiz` already on `PATH` is read first,** in each of its
  directories, with an empty or relative entry read from the working directory
  as a shell would. Nothing named `squiz` that is not this squiz is replaced, or
  shadowed by a link put ahead of it, so that no coding agent changes which
  `squiz` another runs:

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

### The setup check

`squiz doctor` is run by a person, from a shell, inside a repository or outside
one. It prints one line per dependency, and exits 1 where any line failed:

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

Each line is at one of three levels, and only `failed` changes the exit status:

| Level | Meaning |
|---|---|
| present | Usable, or an optional tool that is absent |
| warning | Something a person should see, which squiz runs without |
| failed | A required dependency is missing, unusable or unauthenticated |

It starts every tool in the directory it was run from, and writes nothing but
the temporary directory of Copilot's sign-in prompt, which it removes.

**Each tool is found on `PATH` and started once to ask its version**, within 15
seconds, and only a version read from its output makes it present. An optional
tool that is found and cannot be run is a warning.

The rows, in the order they print:

| Row | Required | Present where |
|---|---|---|
| `git` | Yes | It answers. |
| `gh` | Yes | It answers, and `gh auth status --json` reports an account whose check succeeded. `gh auth token` is not used, because it can print a token `gh` itself does not use. |
| Claude Code | Only where `copilot` is missing or cannot be run, since either can be the coding agent | It answers. |
| Copilot as a coding agent | No, and printed only where `copilot` is on `PATH` | It answers, its experimental features are on, and its extension's socket path fits. |
| Node | Yes | The Node running squiz is 24 or later. |
| tmux, Herdr | No | It answers. |
| The `squiz` link | No, and never a failure | `PATH` holds a link to this squiz, read as `squiz init` reads it. Anything `squiz init` would refuse or change is a warning. |
| Copilot's copies of squiz | No, and printed only where Copilot has one | Each copy under `<COPILOT_HOME>/installed-plugins/` is this squiz's version. A different one is a warning naming the older, since Copilot's hook runs its own copy and two versions would write one state file. |
| The reviewer | Yes | `.squiz.json` reads as a round reads it, the reviewer's CLI answers, and for Copilot the sign-in prompt succeeds. |
| The project's `pi` settings | No, and printed only where the reviewer is `pi` and there are any | Never: the row names what a review does not use. |

**The reviewer is the one `reviewer` names in `.squiz.json`** at the root
`git rev-parse --show-toplevel` gives, or `pi` outside a repository or where the
file does not exist. A git that refuses for any other reason fails the row.

**The row names the model a round would run on:** `model` from `.squiz.json`,
or else the user's default from the reviewer CLI's own settings, as § 4 sets out
for each adapter. Where neither names one, the model is unknown. Settings that
cannot be read are a warning for `pi`, which starts without them, and a failure
for Copilot, whose round fails on them.

**Copilot's sign-in is checked with one prompt, which spends one request**, since
no `copilot` command reports a sign-in without reaching the model:

```
copilot -p "Reply with the single word OK." --model gpt-5-mini --no-ask-user
```

It runs with the variables a round gives a Copilot reviewer, so it signs in as a
round does, and is bounded at 60 seconds. No prompt is sent where the reviewer
is `pi`, or for Copilot as a coding agent.

**Copilot's experimental features are on** where `"experimental"` is `true` in
the user's own `<COPILOT_HOME>/settings.json`, since a session without them is
never woken by its review (§ 9 Getting started). **Its socket path fits** where
`<COPILOT_HOME>/session-state/<session id>/squiz.sock` is at most 104 bytes on
macOS and 108 on Linux.

**The project's `pi` settings row** names each of `.pi/settings.json`,
`.pi/extensions`, `.pi/skills`, `.pi/prompts`, `.pi/themes`, `.pi/SYSTEM.md`,
`.pi/APPEND_SYSTEM.md` and `.agents/skills` that the repository's root holds,
since `pi` takes none of them from a project it does not trust (§ 4 The `pi`
adapter). It ends with the context file that still reaches the reviewer, where
there is one. It reads the working tree rather than the head commit a round
reads, and its list is the one `pi` 0.85.1 requires trust for.

## 7. Failure modes

**Every failure the harness controls ends the command with a status the coding
agent can read.** A run that could not review exits 1. A failure that leaves the
round's outcome standing keeps the outcome's status, 0, 2 or 3, and adds a line on
stderr.

**No failure path is silent.** Every path reaches at least one of six surfaces a
person reads:

- **The failure comment**, which a round that fails posts on the pull request, as
  The failure comment below sets out.
- **`squiz status`**, which shows a failed state's reason, a killed round, and a
  reviewed state's problems, and prints a line on its stderr for a state file it
  cannot read (§ 6).
- **`.squiz/<number>/host.log`**, where the round host writes a line for each
  thing it did, and where its own stderr goes. It is the only surface for what
  the host does outside a round.
- **`squiz review`'s stderr**, one line for each thing that failed, as The
  command's stderr below sets out.
- **The summary's Notes**, which the round that closes the episode writes (§ 5).
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
| The round host's start cannot be told | The process that starts the host failed or answered nothing readable after it may have started the host, or the host's start time could not be read. A live process holding the host lock means the host started, and `squiz review` waits on it. Where no live process holds the lock within 10 seconds of the start, or by the run's deadline where that comes first, `squiz review` exits 1, and stderr names `squiz status` and `.squiz/<number>/host.log`, as § 6 `squiz review` shows. The state stays queued, and the next trigger starts a host for it. | Hook stderr, `squiz review` stderr |
| Whether a round host is running cannot be told | Where a reviewing record names a host that cannot be told running or gone, nothing is recovered, queued or started, and `squiz review` exits 1. `squiz status` shows the state reviewing, with "the round host could not be checked:" and why. A round host that cannot tell whether another holds the lock exits, and the next trigger starts one. | `squiz review` stderr, `squiz status`, `host.log` |
| The command is stopped from outside | The coding agent's tool or a person ends `squiz review` while it waits. The round runs in the round host, outside the command's process tree and group, and goes on. The next run returns its result. | `squiz status` |
| The round host dies | The reviewing record names a host that has gone, so the round reads as killed. The next trigger or round host to find it stops the orphaned reviewer, confirms it is gone, removes the snapshot, and records the round failed, as The round host under § 3 sets out. What the reviewer reported is not posted, and no failure comment is posted. `squiz review` exits 1, saying the host stopped before its round ended. The state is retried by a new commit or reply, or by `squiz review`. | `squiz status`, `squiz review` stderr |
| The state file cannot be read | Exit 1, and no review runs. Every reader of the file reports it with the underlying error rather than the word "failed": the hook queues nothing, `squiz review` exits 1, `squiz status` prints a line for the episode and lists the rest, and the round host exits, leaving the state queued. No failure comment is posted, because whether the episode is closed is in the file, and so is the record that would stop each firing posting another. | Hook stderr, `squiz review` stderr, `squiz status`, `host.log` |
| The round cannot write its reviewing record | Exit 1, and no review runs. The round host records the state failed, since a round nothing records would run twice. Where that write fails too, the host exits, and the state stays queued for the next host. | `squiz review` stderr, `squiz status`, `host.log` |
| The reviewer's session cannot be recorded | The review goes on. Until a later write names it, the record names no reviewer for `squiz status` or a recovery to find. | `host.log` |
| No pane can be opened | Where tmux or Herdr refuses to open a pane, the round host starts the reviewer detached, and the round goes on. `squiz status` shows the session as `detached`. Why the pane was refused is not kept. | `squiz status` |
| The reviewer is not installed | Exit 1, and the failure comment and stderr name the reviewer that could not be started. It is reported as a setup problem rather than as a bad round. A missing Copilot arrives instead as a Copilot adapter run that completed no message, because the line the round starts is `sh`, and is reported as a setup problem by the row below. | Failure comment, `squiz review` stderr, `squiz status`, `host.log` |
| The reviewer runs, exits cleanly, and completes no message | Exit 1, and what the reviewer reported before its provider gave out is posted. A credential the provider refuses arrives here rather than above, because the reviewer starts and answers. The failure comment and stderr carry the reason the reviewer gave. Not retried, because the reviewer already retried the request itself. Reported as a setup problem rather than as a bad round. An errored message in a round that completed others is a retry rather than a failure. | Failure comment, `squiz review` stderr, `squiz status`, `host.log` |
| The reviewer's output cannot be read, and no retry recovers it | Exit 1, and what the reviewer reported before its output stopped being readable is posted. The failure comment and stderr say the review did not run. A retry whose output cannot be read either and a first attempt that left no time for a retry both arrive here. | Failure comment, `squiz review` stderr, `squiz status`, `host.log` |
| The reviewer stops without finishing its review | Retried once, where the round has time left for one. Both attempts post what the reviewer reported before it stopped. A review that was never finished and an honest finding of nothing are distinguished before anything is posted. Exit 1 where the retry does not finish either, with a failure comment saying the review was never finished. | Failure comment, `squiz review` stderr, `squiz status`, `host.log` |
| The reviewer exceeds the review budget | Exit 1, unless the round holds the reviewer's declaration, as the end of this row says. The reviewer process is killed, what it reported before the kill is posted, and the failure comment and stderr say how many findings arrived. The same line then says what squiz saw during the round, and never what caused the kill. For a `pi` reviewer it gives how many messages the reviewer completed, with the bound's seconds averaged over them, and how many requests its provider failed, quoting the first line of the last one's error. A Copilot round's line adds nothing, because Copilot reports neither while it runs. The round is recorded as a failed round rather than a clean one, whatever it posted, and the summary that closes the episode notes that the bound cut it short. A round that already holds the reviewer's declaration is the review it declared instead, because the review was finished before the bound was reached, unless one of its reports could not be read back. That round posts no failure comment, and exits 0, 2 or 3 as its outcome says. | Failure comment, `squiz review` stderr, `squiz status`, `host.log`, summary's Notes |
| A reviewer's pane cannot be closed | The reviewer is already stopped, and its pane stays open on the person's screen. | `host.log` |
| A round's snapshot cannot be removed | The snapshot stays on disk, and the round's result stands. `host.log` names its path and why it could not be deleted (§ 4 The snapshot). | `host.log` |
| GitHub is unreachable | Exit 1 and nothing is posted, the failure comment included. Nothing is stored to retry. Where the episode ends having posted nothing, stderr says so. A trigger whose calls cannot reach GitHub queues nothing. | `squiz review` stderr, `squiz status`, `host.log`, hook stderr |
| `gh` cannot be run at all | Exit 1, nothing posted, the failure comment included, and no review runs. stderr names the call that needed it and says `gh` could not be run. | `squiz review` stderr, `squiz status`, `host.log`, hook stderr |
| The calls before the review run out of time | Exit 1, and no review runs. A snapshot that the fetch, the clone and the checkout could not make within the part is this row too. The failure comment and stderr say which call had nothing left, where the posting reserve can still reach GitHub. A lookup that ran out of time is never read as a branch with no pull request. | Failure comment, `squiz review` stderr, `squiz status`, `host.log` |
| The threads on the pull request cannot all be listed | Exit 1, and no review runs. The failure comment and stderr say so. The pages that arrived are dropped, because a reviewer handed a subset rules on a subset. A trigger whose listing fails queues nothing. | Failure comment, `squiz review` stderr, `squiz status`, `host.log`, hook stderr |
| A verdict cannot be applied | A verdict whose mutation GitHub refuses leaves its thread as it was handed over, and the round counts the thread that way. A verdict naming a thread that was not handed over, and a second verdict for one thread, are not sent. The round's outcome stands. stderr names each with its thread, what the reviewer ruled, and why it was not applied, which for a refused mutation is what GitHub answered. `squiz status` does the same for a round that reviewed. The summary that closes the episode, and the failure comment of a round that failed, name each as § 5 What the comment carries shows, without GitHub's answer. Nothing is retried. | `squiz review` stderr, `squiz status`, summary's Notes, failure comment |
| Some comments post and others fail | The comments that landed stay, the round exits as its outcome says, and stderr says how many could not be posted. A later round makes the rest again. A round that closes the episode lists each in its summary's Notes, and a round that fails lists each in its failure comment. | `squiz review` stderr, `squiz status`, summary's Notes, failure comment |
| The reviewer's reason cannot be posted | The verdict stands, and the thread stays in the state the reviewer ruled. The round's outcome stands. stderr names the thread and what GitHub answered, and so does `squiz status` for a round that reviewed. A round that closes the episode names the thread in its summary's Notes, without GitHub's answer. Nothing is retried: the next round that keeps the thread open posts a reason of its own. | `squiz review` stderr, `squiz status`, summary's Notes |
| The reply on a thread the round closes cannot be posted | The thread is resolved all the same, and the verdict stands. The round's outcome stands. stderr names the thread and what GitHub answered, and so does `squiz status` for a round that reviewed. The round records the line in its entry of the state file, and the summary that closes the episode names it in Notes, without GitHub's answer, whichever round it was. A round that fails names it in its failure comment instead. Nothing is retried, because no later round closes the thread again. | `squiz review` stderr, `squiz status`, summary's Notes, failure comment |
| A round that leaves threads open has findings no thread holds | A finding about the change as a whole, one the harness could anchor to neither a line nor a file, and one whose comment could not be posted reach no thread, and a round that leaves threads open posts no summary. The round's record keeps each. `squiz review` prints each on stderr, and the summary that closes the episode lists each that no later round settled (§ 5). | `squiz review` stderr, summary's Notes |
| No finding posts | A round that found findings and posted none of them is a failed round, whatever its verdicts did: exit 1, recorded failed with the reason "round 2 found 3 findings and could not post them to PR #41", and a failure comment where GitHub takes one. It posts no summary and does not close the episode. A new commit, a new reply or a run of `squiz review` retries it where a round remains, and closes the episode where none does, as The failure comment below says. | Failure comment, `squiz review` stderr, `squiz status`, `host.log` |
| The posting reserve runs out before the findings are posted | Exit 1, and the findings are reported on stderr as unposted rather than as comments that landed. No failure comment is posted, because the reserve it would be posted in is spent. Nothing is attempted past the end of the reserve. | `squiz review` stderr, `squiz status`, `host.log` |
| The round's spend cannot be written | Exit 1, and nothing the reviewer found is posted. The failure comment and stderr say nothing was posted, and give the underlying error. | Failure comment, `squiz review` stderr, `squiz status`, `host.log` |
| The round's end cannot be written to the episode's state | Exit 1, and no summary is posted, because the end, and the close where the round closes the episode, is written before the summary. The findings and verdicts the round posted stand, and the failure comment and stderr name the write that failed. The episode then reads as one still open, and the next run reviews the pull request again. A close reached before any review fails the same way, with nothing posted but the failure comment. | Failure comment, `squiz review` stderr, `squiz status`, `host.log` |
| The round's result cannot be recorded | The round host could not write what the round reached, after the round posted it. The host names the result and the reason, and exits. What the round posted stands. The reviewing record still names the host, so once the host has exited `squiz status` shows the round killed. A `squiz review` already waiting on the round sees no result and exits 4 at its deadline. A later run exits 1 saying the host stopped before its round ended, unless the round had closed the episode, which it then prints as closed. | `host.log`, `squiz status` |
| A round's posting time or resume command cannot be written | The round's result stands. A round with no resume command shows `—` under Resume in `squiz status`. | `host.log` |
| The summary comment cannot be posted | The close is a close still rather than a round the harness failed, and the command exits 0 or 3 as the close does. stderr says the episode closed without its summary, and names what GitHub answered or that the reserve was spent. Nothing is retried, because a second attempt would be a second comment. `squiz review` prints the line for the run that waited on the close, and for every later run on the closed episode, whether the close came after a review or before one. `squiz status` prints it under the line of a round that reviewed. `host.log` holds it after the close's own line, for a close before the review as well as after one. | `squiz review` stderr, `squiz status`, `host.log` |
| The episode closes before any round ran | An episode whose failed attempts spent the token bound before any round reaches this. It closes as § 5 says: with the summary, the open threads and exit 3 or 0 where those attempts left any of the reviewer's threads, and with exit 0 and a line on stderr where they left none. | Summary's Notes, `squiz review` stderr |
| The harness itself throws | A throw in a command is trapped at its top level, which writes one line on stderr. A throw inside a round fails the round: it is recorded failed with the throw as its reason, and posts no failure comment. `squiz review` exits 1. The hook exits 0, as it does on every path. A throw in the round host outside a round ends the host, and the round it held reads as killed. | `squiz review` stderr, `squiz status`, `host.log`, hook stderr |
| No wake reaches the owner of the work | The note stays in `.squiz/<number>/notes/`. The owner learns the result from `squiz review` or `squiz status`, and the pull request holds it. A note that cannot be written is reported the same way. | `host.log` |
| The round cap is reached | Exit 3, or 0 where nothing is open. Findings still unresolved stay open, and the summary comment reports them. | Summary's Notes, `squiz status` |
| The token bound is reached | Exit 3, or 0 where nothing is open. The episode closes without starting another round, and the summary comment reports that the bound was reached rather than reporting the round as one the reviewer failed. | Summary's Notes, `squiz status` |

### The failure comment

A round that fails posts one issue-level comment on the pull request saying so. It
names what failed, and says what happens next. A round that salvaged findings
says how many of them it posted as threads. A list follows, holding each
salvaged finding that no thread holds, written as the summary's Notes write it
(§ 5 What the comment carries): a finding about the change as a whole, one the
harness could anchor to neither a line nor a file, and one whose comment could
not be posted at all. Each ruling the round could not apply follows them, also
written as Notes writes it.

Where a round remains under the round cap and the token bound, the comment says
the review is still open and that a new commit or reply, or running
`squiz review`, retries it:

```markdown
**Squiz review failed — the reviewer was killed at its 900-second bound, and the round kept the 3 findings the reviewer had reported**

1 of the 3 findings the reviewer reported is posted as a thread. The review is still open. A new commit or reply, or running `squiz review` again, retries it.

- `src/cache.ts:12` — The cache is never cleared (no thread could be opened for it)
- About the change as a whole: The retry queue duplicates the scheduler
```

**Where the round leaves no round to run, the comment says the review is closed,
and which bound closed it**: a failed round that was the last the cap allows, or
a failed attempt whose tokens reached the token bound. Whether a round remains is
read from the episode's state once the attempt has recorded what it spent:

```markdown
**Squiz review failed — the reviewer was killed at its 900-second bound, and the round recorded no findings; the reviewer's 21 messages took about 43 seconds each; its provider failed 7 requests, the last with "429 Too Many Requests"**

The review is closed: it has run 3 rounds, and the round cap allows 3. No round runs again. A new commit or reply, or running `squiz review`, posts its summary.
```

```markdown
The review is closed: it reached the token bound of 10,000,000 tokens. No round runs again. A new commit or reply, or running `squiz review`, posts its summary.
```

The next run finds the bound spent and closes the episode with its summary.
Until a commit, a reply or `squiz review` starts it, the pull request carries
the failure comment and no summary. An episode that ran no round may have no
thread for a summary to count, so its comment ends at "No round runs again."

The reason on the first line is the reason the command prints on stderr, word for
word, as § 6 shows.

The failure comment is posted in the posting reserve, after the salvaged findings,
under the same deadline. It is never edited, and each failed round posts its own.
Where GitHub cannot be reached, or the reserve is spent, nothing is posted, and
stderr is the only channel.

A run that ends at the gate posts no failure comment. A run that waited for
another's round, or was handed a result already recorded, posts nothing of its
own.

### The command's stderr

The command writes one line on stderr for each thing that failed: the lines that
say why a run exits 1, and the line a run adds where something failed without
changing its outcome. A run that exits 1 then ends with the line telling the
coding agent to stop, as § 6 `squiz review` shows. The outcome itself, the open threads included, is on stdout
as § 6 shows. Both reach the coding agent as its shell tool's output.

```
squiz: round 3 found 3 findings and could not post them to PR #142
squiz: no review ran: HEAD is detached in "/work/squiz", so no pull request has it as its head
squiz: the review of PR #142 closed without its summary: GitHub answered 502
squiz: the reviewer ruled thread PRRT_kwDOAbc123 fixed, and it could not be resolved: GitHub answered 502
squiz: the failure could not be posted on PR #142: GitHub answered 502
```

A run with nothing that failed writes nothing on stderr.

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
verdicts it reported are applied, in the posting reserve and under the same
deadline a finished review's posting runs under. A finding no thread can hold is
listed in the failure comment. None of that decides what the
round became. The outcome is the reviewer's own, the cost is the floor the
failure left, and the round neither hands threads back to the coding agent nor
closes the episode over what it managed to put up.

A failed round that confirmed nothing has no findings to post and no verdicts to
apply. It still posts its failure comment under § 7.

**A round runs in the round host, so no caller's timeout bounds it.** It has
three parts, each bounded on its own:

| Part | How long | What runs in it |
|---|---|---|
| Before the review | At most 30 seconds | The pull request lookup, the threads listing, the diff, and the fetch, clone and checkout that make the snapshot |
| The review | The time bound | The reviewer |
| Posting | A reserve of 60 seconds | The findings, the verdicts, the summary comment and the failure comment |

Stopping the reviewer runs after the moment the review had to be over by, and a
reviewer that ignores the signal spends the grace and the kill there. That overrun comes out of the
posting reserve: a round whose reserve is spent by the time it has findings
posts nothing and says so.

**`squiz review` waits within one deadline of 540 seconds**, counted from the
moment it starts, which keeps it under the 600 seconds Claude Code gives a shell
command. Everything the run does counts against it.

- **A run whose state's round ends before its deadline returns that round's
  result**, 0, 2 or 3, or exits 1 with the reason the round recorded where it
  failed. It posts no second failure comment.
- **A run whose deadline arrives first exits 4.** Its state is queued or under
  review, so the round goes on, and the next run returns it.

**A part is one deadline every call inside it runs under, and a call with
nothing left on it is not made at all.**

**No single call to GitHub may take more than 30 seconds**, and this bound is not
configurable. A call that reaches either bound is treated as GitHub being
unreachable, so the round exits 1 and the comments that landed stay.

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

The bound is read before a round starts, and again when a round records what it
spent. **It stops the next round, never the running one**, so the round that
reaches it may spend more than the bound, and the time bound is the only thing
that caps a single round.

**The token bound holds a Copilot round that has a cost as it holds a `pi`
one**, with tokens counted the same way for both. A Copilot round with no cost
counts nothing against it. Dollars and AI credits bound nothing.

## 8. The project

Squiz is its own repository, not a directory inside a host project.

### Language

Squiz is written in TypeScript and runs on Node. Node strips the types and runs
the `.ts` files as they are, so there is no build step and no compiled output.

- **Erasable syntax only.** No `enum`, no parameter properties, no namespaces. A
  union of string literals stands where an enum would.
- **Types are checked by `tsc --noEmit` in CI.** Stripping does not check them.
- **Node 24 or later.** The setup check reports the version.
- **macOS and Linux.** Squiz detaches its round host, finds its processes again
  and stops them through Unix process calls: `ps`, `setsid`, process groups and
  signals. On Windows it runs under WSL. No review has run on Linux yet (#722).
- **`bin/squiz` is a shell shim.** Node decides to strip types from the `.ts`
  extension, so the entry point cannot be an extensionless Node file. The shim
  execs the real one.

The Copilot extension is the one file in JavaScript, because Copilot starts only
an `extension.mjs`. It imports nothing but Node's own modules and the
`@github/copilot-sdk/extension` that Copilot supplies.

There are no runtime dependencies. Everything outside the process is a
subprocess: `git`, `gh`, `ps`, and the reviewer's own CLI.

### Structure

The layout is a Claude Code plugin, which is also the package that is
distributed.

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
docs/specs/                  this document
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
`src/`.

A test sits beside the code it tests, named for it: `src/config/config.ts` is
tested by `src/config/config.test.ts`.

## 9. Adoption

### Installing

Squiz is a plugin for Claude Code and for Copilot, and this repository is its
marketplace for both. `.claude-plugin/marketplace.json` names the marketplace
`squiz` and lists one plugin, squiz, whose source is the repository's own root.

Into Claude Code:

```
/plugin marketplace add jacygao/squiz
/plugin install squiz@squiz
```

Into Copilot:

```
copilot plugin marketplace add jacygao/squiz
copilot plugin install squiz@squiz
```

Each runtime keeps a copy of its own, and runs the hooks from it:

- **Claude Code** copies the repository into
  `plugins/cache/squiz/squiz/<version>/` under its configuration directory,
  where the version is the one `plugin.json` carries. The marketplace entry
  carries the same version.
- **Copilot** copies it into `<COPILOT_HOME>/installed-plugins/squiz/squiz/`,
  and runs the extension from there too. `copilot plugin update squiz` replaces
  the copy in place, so the path does not change.

A person who installs squiz into both updates both, so that the two copies are
one version. `squiz doctor` warns where they are not (§ 6 The setup check).

**After updating squiz in Claude Code, run `squiz init` again,** by typing
`! squiz init` in a Claude Code session started after the update. Claude Code
copies a new version beside the old one and deletes the old one 14 days later,
so until then the link `squiz init` made names the old version, and after that it
names nothing. `! squiz doctor` warns about the link until `squiz init` moves it.

`/plugin uninstall squiz` removes squiz from Claude Code, and
`copilot plugin uninstall squiz` from Copilot.

A Copilot session can also load a checkout with `copilot --plugin-dir
<checkout>`, which loads the same hooks and extension from the checkout
itself.

### Getting started

Two things in the host project, the second one optional. Nothing goes in the
project's `.gitignore`: squiz keeps `.squiz/`, where it writes each episode's
state, out of git itself (§ 3 The state file).

1. Allow `squiz` in the project's Claude Code permissions, so the coding agent
   is not prompted every time it starts a round or works a thread.
2. **Optional.** `.squiz.json`, to change any of the settings below. Every one
   has a working default, so a project that writes none still runs.

Then check the setup with `squiz doctor` (§ 6 The setup check), from the
repository. In a Claude Code session, type it after `!`:

```
! squiz doctor
```

Elsewhere, run `squiz doctor` in a shell once `squiz init` has linked it.

**A Claude Code or Copilot coding agent needs no instruction to start a review.**
The plugin's hooks start one each time the agent finishes its work, and the
session that owns the work is woken with the result, which names
`squiz review` (§ 3 The report). Nothing goes in the project's `AGENTS.md` for
this.

**Every Copilot session of a user who installed squiz loads it,** with its
hooks, and with its extension where experimental features are on.

**Squiz's Copilot support is experimental, because it relies on Copilot's
experimental features.** Squiz wakes an idle Copilot session through an
extension the plugin ships, and Copilot loads extensions only with experimental
features on. Setting up Copilot includes turning them on once, for the user, by
either of:

```
copilot --experimental
```

```
/experimental on
```

Each writes `"experimental": true` to `<COPILOT_HOME>/settings.json`, which turns
them on for every later session of that user. A Copilot session without them is
unsupported: its reviews still run, and it learns the result only from a
`squiz review` it runs itself.

The socket's path, `<COPILOT_HOME>/session-state/<session id>/squiz.sock`, must
fit in the 104 bytes macOS allows a socket path, and the 108 Linux allows. Under
a `COPILOT_HOME` too long for it, the extension cannot listen, and says so in the
session as a warning.

**Every coding agent but Claude Code reaches `squiz` through a link
`squiz init` makes**, Copilot included. Run `squiz init` once on each machine. Where Claude Code has squiz
enabled, type `! squiz init` in a Claude Code session, so that every agent runs
the squiz Claude Code uses. Where only Copilot has it, run it by path from
Copilot's copy:

```
<COPILOT_HOME>/installed-plugins/squiz/squiz/bin/squiz init
```

It links `~/.local/bin/squiz`, or `~/bin/squiz`, to that plugin's `bin/squiz`,
and makes no link where a `squiz` that is not this one is already on `PATH`
(§ 6 `squiz init`). A Copilot session then runs `squiz` by name.

The reviewer reads `AGENTS.md` for the conventions it cannot derive from the
code, and for whatever else the project treats as authoritative. Without it the
review reports no convention violations.

A project that runs coding agents in parallel gives each one its own worktree on
its own branch. Squiz does not create them, and does not remove them.

### Configuration

`.squiz.json`, at the root of the repository.

| Setting | Default | |
|---|---|---|
| `reviewer` | `pi` | The reviewer CLI, `pi` or `copilot` |
| `rounds` | 3 | The round cap, settable 1 to 8 |
| `timeout` | 900 | Seconds one round's reviewer may run, settable 60 to 3,600 |
| `tokens` | 10,000,000 | Tokens one round may spend, settable 100,000 to 10,000,000 |
| `thinking` | `medium` | How hard the reviewer thinks, one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `model` | none | The model the reviewer runs on, in its CLI's spelling: `provider/id` for `pi`, such as `openai/gpt-5-mini`, and the model's name for Copilot, such as `gpt-5-mini`. None runs the reviewer on the user's own default (§ 4 Adapters) |

`model` is up to 200 letters, digits and `.` `_` `:` `/` `@` `+` `-`, starting
with a letter, a digit or `@`. An empty string is refused rather than read as
none. A model the configured reviewer does not offer fails the round at setup,
and never runs it on another model.

`reviewer` chooses the adapter, and nothing else changes with it. `copilot`
needs the GitHub Copilot CLI installed and signed in.

A setting outside its range, or of a type the table does not give it, is
rejected with an error naming the setting, the value given and what was
expected. A key the table does not name is rejected the same way, with an error
saying it is not a setting and listing the settings there are. A `.squiz.json`
that cannot be read or parsed is a failure the harness controls, so the command
exits 1 and its stderr names it.
