# Session Interface: What Squiz Asks of Muster

**Version:** 0.6 (draft)
**Status:** For review
**Owner:** TBD

---

## 1. Purpose

**Squiz runs its reviewer as a session that a person can watch and that
outlives whatever asked for the review.** Muster, a session manager that knows
nothing about reviews, starts those sessions, fires squiz when a coding agent
finishes, and carries squiz's messages. Muster is specified in `muster/docs/specs/muster-spec.md`. It is written in Go,
and squiz stays TypeScript. Squiz meets muster only through muster's commands
and the files each writes, never through an import. This document
is squiz's side: what it needs from muster, what it runs there, the message
kinds it defines, and what it guarantees.

Today the reviewer is a headless `pi` that `squiz review` or the `SubagentStop`
hook starts as a child, inside a coding agent's shell call or a hook. Every hard
limit of the current design comes from that placement: the 600-second window,
the 480-second time bound, the hand-back that drops a block (#278), and the
helper firings (#265). `review-harness-spec.md` at version 0.56 (#290) is "the
harness spec" below. Its CLI stays the core, and nothing here is built yet.

## 2. Decisions for the owner

| # | Decision | Recommended | Where |
|---|---|---|---|
| D2 | Where a round runs | In a round host, `squiz host <number>`, run as a detached muster session per episode, outside every caller's process tree | § 4 |
| D3 | Whether a reviewer keeps its context from one round to the next | No. A fresh `pi` session for every round | § 4 |
| D4 | Whether the reviewer reviews the coding agent's worktree or a snapshot of the head commit | A snapshot, in a worktree of the reviewer's own, because a live coding session may be editing while a round runs | § 6 |
| D5 | What replaces the time bound | A wall-clock guard the project sets, with no ceiling, and the token bound enforced while the round runs | § 8 |
| D6 | What `squiz review` does when its wait runs out | The harness spec's exit 4, "still reviewing", now also for a round this run asked for. A rerun attaches to the same round | § 4 |
| D8 | Whether the reviewer may answer a disputed thread in words | Yes, as an optional reply carried by an `open` verdict | § 6 |
| D10 | Whether Herdr's own `pi` extension loads into the reviewer | Not decided. It may be what makes Herdr show the reviewer's state, and it breaks the rule that only squiz's extension loads. Spike S6 in muster's document comes first | § 4 |
| D11 | Whether squiz's own `SubagentStop` registration stays once muster's triggers exist | No. Muster registers the hooks, and squiz is the command they run | § 9 |

## 3. What squiz needs from muster

| Need | Muster command squiz uses |
|---|---|
| Run `squiz hook` when a coding agent finishes, and wake it when squiz answers | A trigger in `.muster.json` running `squiz hook`, which prints `watch squiz-coder-<number>` |
| Start the round host so that it outlives the trigger | `muster start --backend detached --name squiz-host-<number> -- squiz host <number>` |
| Start each round's reviewer where a person can watch it | `muster start --name squiz-<number>-r<k> --kind pi --env … -- pi …` |
| Know when the reviewer's process has ended | `muster wait squiz-<number>-r<k>` |
| Stop a reviewer that outran the wall-clock guard | `muster stop squiz-<number>-r<k>` |
| Send a pointer to the round host or the coding agent | `muster send` |
| Take the round host's next request | `muster inbox take squiz-reviewer-<number>` |

Every call passes `--root`, the toplevel of the coding agent's worktree.

## 4. The sessions squiz runs

### The round host

`squiz host <number>` is part of squiz's core. It takes requests from the address
`squiz-reviewer-<number>`, runs a round for each, records the outcome in the
state file, and sends the coding agent a message. It runs the gate, the
episode's state, posting and the summary exactly as the harness spec § 3 sets
them out. It ends when the episode closes, when a `stop` message arrives, or
when the worktree it serves is gone.

It runs detached because no person needs to watch it and because it must
outlive every caller. Between rounds it waits on its inbox and spends nothing.

### The reviewer

Each round starts one reviewer session, `squiz-<number>-r<k>`, in the reviewer's
worktree. Paths are relative to the root:

```
muster start --root <worktree> --name squiz-41-r2 --cwd .squiz/41/review-tree --kind pi \
  --env PI_CODING_AGENT_DIR=.squiz/41/pi-agent --env TMPDIR=.squiz/41/scratch \
  --env SQUIZ_REPORTS=.squiz/41/rounds/2/reports.jsonl \
  -- pi --no-extensions --extension <reporting-extension> --no-approve \
        --tools read,grep,find,ls,report_finding,report_verdict,finish_review \
        --thinking medium --session-dir .squiz/41/rounds/2/session \
        --append-system-prompt <charter-file> <task-prompt>
```

The command line is the harness spec's § 4 command line without `--print`,
`--mode json`, `--no-session` and the `/dev/null` standard input. In Herdr and
tmux, `pi` runs with its interface in the pane. Detached, it has no terminal on
its standard input, and `pi` runs in print mode wherever that is so.

**The extension writes the round down and ends the reviewer.**

- It appends every accepted report, every refusal, and the usage of every
  assistant message to `SQUIZ_REPORTS`.
- It writes a progress line for every tool call to `.squiz/<number>/progress.log`.
- After `finish_review` it records the finish and calls `ctx.shutdown()`, which
  `pi` defers until it is idle. The reviewer writes its closing message first.
- On `agent_settled` with no `finish_review` recorded, it records that the round
  ended unfinished and calls `ctx.shutdown()`. Interactive `pi` otherwise waits
  for input indefinitely once its agent settles.

**A round is over when the reviewer's process has exited, or when the
wall-clock guard stops it.** The round host then reads the report file, not the
reviewer's output. The file says which ending it was: a finish, an unfinished
end, or neither, which is a reviewer stopped from outside.

**A reviewer's pane closes once its review ends, and its session stays
resumable.** The pane is gone with the process, and so is anything `pi` printed
there, its own resume line included. Each round's `--session-dir` is a
directory of its own, so the one session file `pi` writes there,
`<timestamp>_<uuid>.jsonl`, is the round's. The round host writes the command
that resumes it to `.squiz/<number>/rounds/<k>/resume.txt`, and records it
against the round in the state file:

```
pi --session-dir .squiz/41/rounds/2/session --session 0193f2c4-7d1e-7b52-9c1a-5e2f4d8a6b31
```

`squiz status` prints it as the last column of the round's line. A session
resumed that way is a conversation with the reviewer after its round, and
nothing said in it is part of the review.

**Stopping a reviewer takes two steps.** The round host stops the session
through muster, which reaches the processes in the reviewer's session. It
then signals the shell groups the reviewer's shells recorded, as the harness
spec § 4 Confinement sets out, because a shell `pi` started in a session of its
own is beyond muster's reach.

**What a person types into a reviewer's pane reaches `pi`.** It can steer the
review, and nothing records it.

### `squiz review`

`squiz review <number>` gates on the pull request as the harness spec § 3 step 1
does, then reads the record for the pull request's state:

- **No record:** it ensures the round host, sends `review-ready`, and waits.
- **Failed:** it ensures the round host, sends `re-review`, and waits.
- **Reviewing:** it waits.
- **Reviewed:** it prints the result, and exits as the harness spec § 6 says.

It waits on the state file's record, for at most 540 seconds by default, under
Claude Code's longest shell timeout. Where the wait runs out, it writes its
output to `.squiz/<number>/review.txt`, names that file first as every run that
prints an outcome does, and exits 4:

```
Full output: /work/squiz/.squiz/41/review.txt
Squiz is still reviewing PR #41 at 3f9c2e0, in session squiz-41-r2. Run `squiz review 41` again to wait for it.
```

Exit 4 is the harness spec § 6's "still reviewing", and the skill and the
`AGENTS.md` text already tell the coding agent to run the command again on it.
There it covers a run that waited on another caller's round. Here it covers the
run's own request as well, because the round runs in the round host and never
inside the command. `squiz review --no-wait <number>` sends its message and
exits 4 at once.

### `squiz hook`

`squiz hook` is the command muster's trigger runs. It resolves the pull
request whose head is the branch checked out where the event fired. Where that
state has no record, it ensures the round host and sends `review-ready`. On a
`settled` event it prints `watch squiz-coder-<number>` wherever a pull request
exists, so muster wakes the coding agent with whatever squiz sends next, where
the agent's adapter can wake it.

**The wake reaches full sessions whose adapter can wake them, and nothing
else.** A Claude Code subagent has ended by the time its `SubagentStop` fires,
and in auto mode it has handed back, so no `threads-open` reaches it. An agent
whose adapter has no wake, or that has no adapter, is not reached either. For
every such coder the loop closes only because it runs `squiz review` itself and
waits for it, which is #290's route and muster's pull fallback. `squiz hook` on
a `finished` event still starts the review, and prints no `watch` line.

## 5. The message kinds

Squiz's pointers are `key=value` words on one line. `head` and `activity`
together are a state, as the harness spec § 3 defines one: `head` is the pull
request's head commit, and `activity` is the GitHub identifier of the newest
reply, from anyone other than the reviewer, on a thread the reviewer opened, or
`none`.

| Kind | From | To | Pointer | Means |
|---|---|---|---|---|
| `review-ready` | `squiz hook`, `squiz review` | `squiz-reviewer-<n>` | `pr= head= activity=` | This state has no review. Run a round. |
| `reply-posted` | `squiz reply` | `squiz-reviewer-<n>` | `pr= head= activity= thread=` | A reply landed on a reviewer's thread, which is a new state. Treated as `review-ready` for it. |
| `re-review` | `squiz review`, a person | `squiz-reviewer-<n>` | `pr= head= activity=` | This state's last round failed. Run another. A reviewed state is never run again. |
| `stop` | A person, a coordinator | `squiz-reviewer-<n>` | `now=yes` or `now=no` | End the round host after the running round, or at once, failing that round with a failure comment. |
| `threads-open` | The round host | `squiz-coder-<n>` | `pr= head= round= threads= next=` | Threads are open. Work them. The harness spec's exit 2. |
| `closed` | The round host | `squiz-coder-<n>` | `pr= head= exit= next=` | The episode closed, with `exit` 0 or 3. |
| `failed` | The round host | `squiz-coder-<n>` | `pr= head= next=` | The round failed. The harness spec's exit 1. |

`next` is the command that reads the outcome and starts nothing:

- **`threads-open` and `closed`:** `squiz review <n>`. The state is reviewed, so
  it prints the recorded result and starts no round.
- **`failed`:** `squiz status`. Its line for the state gives the reason the
  failure comment gives. `squiz review <n>` would send `re-review` for a failed
  state and start a round, so it is never the `next` of a failure.

## 6. What squiz guarantees

- **The pull request holds the review.** Every finding, verdict and reply is on
  it. A message carries a pointer, and never a finding's text.
- **A missed message loses nothing.** Every message restates something the state
  file records, and `squiz review` reads the state file.
- **One review per state**, as the harness spec § 3 has it, whatever number of
  triggers fire for it.
- **A dispute is settled on the pull request, a round at a time.** A reply is a
  new state, every round counts against the round cap, and at the cap a person
  takes it. D8 lets an `open` verdict carry a reply the round host posts on the
  thread.
- **Each round starts cold** (D3). What the reviewer knows of earlier rounds is
  the threads it is handed.
- **The reviewer changes nothing the coding agent commits.** At `read` the grant
  holds it. At `deep`, D4 gives the reviewer a detached worktree at the state's
  head commit, `git worktree add --detach .squiz/<n>/review-tree <head>`, which
  nothing else writes, so the tracked-file comparison reads only the reviewer.
  The round host removes it after the round. The cost is installing dependencies
  before the tests run, which is spike S7.
- **Squiz stops what it started.** Every reviewer session ends with its round,
  and every shell group it recorded is signalled.
- **Squiz never imports muster**, and reaches it only as a command.

Two writers touch `.squiz/<number>/`: the core, and the reviewer's extension,
which appends to the report file and the progress log.

## 7. What changes in squiz

| Path | Change |
|---|---|
| `src/cli.ts` | Adds `squiz host` and `squiz review --no-wait`. `squiz hook` becomes muster's trigger command. |
| `src/review/` (#290) | `squiz review` sends a message and waits on the record. `squiz status` names each round's reviewer session, and ends the round's line with its resume command. |
| `src/host/` | New. The round host. |
| `src/hook/` | Resolves the pull request and sends `review-ready`. It no longer runs a round, and the exit-2 block goes. |
| `hooks/hooks.json` | Registers muster's hooks in place of squiz's own. |
| `src/loop/round.ts`, `src/loop/window.ts` | The round runs in the round host. The window and its three shares go. |
| `src/reviewers/round.ts`, `adapter.ts` | The reviewer starts through muster. Reports are read from the report file. |
| `src/reviewers/pi/argv.ts` | The command line in § 4. |
| `src/reviewers/pi/extension.ts` | Writes the report file and the progress log. Shuts `pi` down after `finish_review`, and on `agent_settled` without one after recording an unfinished end. Stops at the token bound. `execute` takes its fifth argument, the context `ctx.shutdown()` belongs to. |
| `src/reviewers/pi/stream.ts`, `parse.ts`, `output.ts`, `cost.ts` | Read the report file rather than the JSON stream. |
| `skills/squiz-review/SKILL.md` | A main session told it will be woken may end its turn. |

**Kept as they are:** the finding contract, the comment format and every
comment, the GitHub client and its 30-second bound per call, the tracked-file
comparison and the shell-group record, the refusals, the `pi` settings
directory, the charter, and #290's CLI with exits 0 to 3.

## 8. What it removes

| Limit | In this design |
|---|---|
| The 600-second window, and its three shares | **Gone.** No caller holds the round. |
| The 480-second ceiling on the time bound | **Moves.** It becomes a wall-clock guard on a runaway round, with no ceiling. |
| #291's 540-second question | **Gone** for the round. 540 seconds stays as the default wait of `squiz review`. |
| The stall watchdog | **Does not apply.** Nothing holds a subagent. |
| #278, a block that reaches no agent | **Gone for full sessions**, Claude Code or `pi`, which muster wakes. **Unchanged for subagents**, which no message reaches: the loop closes only where the subagent runs `squiz review` itself and waits, as under #290. |
| #265, helper firings | **Harmless** since #290's one review per state. |
| #264's remainder, a subagent working by path | **Gone** for sessions started in their own worktree. It stays for a subagent dispatched by path. |
| #276, an invisible reviewer | **Gone.** |
| The token bound | **Moves.** The extension stops the round once the bound is reached, so it prevents rather than detects. Whether an extension can stop a turn in flight is spike S5. |
| The round cap | **Kept.** It is the only bound on a dispute. |

## 9. Migration

Each step keeps today's Claude Code plus `pi` path working. `.squiz.json` gains
`"reviewer": "child" | "session"`, which is `"child"` until step 5.

1. **#290 lands as specified.** The reviewer runs as a child, and squiz's own
   `SubagentStop` hook triggers it.
2. **The report file.** The extension writes it beside the JSON stream, and the
   adapter reads it. A test holds the two equal on the recorded run.
3. **Muster's sessions and inbox, and the round host.** With
   `"reviewer": "session"`, `squiz review` sends `review-ready` and waits, and the
   round runs in a detached round host with a detached reviewer.
4. **Panes and triggers.** Muster's Herdr and tmux backends and its
   triggers. Squiz's `hooks.json` registers muster's hooks in place of its
   own (D11).
5. **The default becomes `"session"`.** `"child"` stays for one release, and goes
   once this repository has been reviewed on sessions for a milestone.

## 10. Open questions and spikes

Muster's own spikes, S1, S3, S4 and S6, are in its document. These are
squiz's.

| | Question | Spike | Decides |
|---|---|---|---|
| S2 | Does an interactive `pi`, started with the command line in § 4, run its prompt at once, register the three calls, apply the refusals, and exit after `finish_review`? On 0.85.1 and on 1.0.0. | Answered yes, in `docs/notes/an-interactive-pi-in-a-pane-reviews-like-the-headless-one.md`: one real round on 0.85.1 and a probe on 1.0.0. Still open: a pane round that reports findings on a real change, and on 1.0.0. | Whether the reviewer can run in a pane at all |
| S5 | Can a `pi` extension stop a turn in flight, or only between messages? How far past the token bound does a round run? | Read `pi`'s extension API, then measure against a low bound. An hour. | D5 |
| S7 | What does a snapshot worktree cost at `deep`, where tests need dependencies? | Time `git worktree add`, install and test on this repository and a larger one. Half a day. | D4 |
| S8 | Do warm reviewers drift toward the coding agent on a three-round dispute, and what do they save? | Two episodes on one fixture, cold and warm. A day. | D3 |
