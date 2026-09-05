# SubagentStop blocks and the subagent resumes

Settles the first prerequisite in § 8 of the review harness specification: that a
`SubagentStop` hook exiting 2 feeds its stderr back into the subagent's open
turn, and that the subagent keeps working rather than ending the turn.

**It holds.** The hook fired every time the subagent stopped, exit 2 delivered
the hook's stderr to the subagent as a new user message, the subagent acted on
that message, and it did so inside the same tool call that started it. The loop
in § 3 rests on real behaviour.

Two things the specification does not currently say came out of the run, and
both matter for M1. The runtime rewrites the blocking reason before the agent
sees it, and the agent that dispatched the subagent sees only the subagent's
final message, which can make blocked-and-resumed work look like tampering.
Both are written up below.

Run on 2026-09-05 for issue #9.

## Versions

| | Version | Note |
|---|---|---|
| Claude Code | 2.1.261 | The specification's table records 2.1.228 |
| `git` | 2.50.1 (Apple Git-155) | Matches the specification's table |
| `gh` | 2.97.0 | Matches the specification's table |
| Node | v24.15.0 | |
| `pi` | 0.84.2 | The specification's table records 0.74.2 |

Neither version drift changed anything observed here, because nothing here
touches `gh` or `pi`. They are recorded so that a later re-run knows what this
one was checked against.

## Where the scaffolding lives

`spike/`, at the root of this repository, and **it is committed**.

```
spike/
  .claude-plugin/plugin.json   manifest, name squiz-spike
  hooks/hooks.json             the SubagentStop registration
  hooks/subagent-stop.sh       the hook itself
```

§ 8's `src/` layout has no home for scaffolding that is meant to be thrown away,
so `spike/` sits beside `docs/` rather than inside the layout the harness will
grow into. It is a Claude Code plugin in its own right, which is what
`--plugin-dir` wants, and it is nothing the harness ships. It is deleted when M0
closes.

`spike/hooks/subagent-stop.sh` is a POSIX shell script rather than TypeScript.
It has no types to erase, so the erasable-syntax rule in § 8 does not come into
it, and a shell script keeps the evidence one file away from the log.

The remaining M0 subtasks — the payload's fields, `stop_hook_active`, and
worktree separation — extend this same script. It is written for that: it logs
the whole payload verbatim on every invocation, plus the working directory, the
git toplevel and the branch, so most of what those subtasks need is already in
the log. Three environment variables steer it, all optional:

| Variable | Default | What it does |
|---|---|---|
| `SQUIZ_SPIKE_DIR` | `/tmp/squiz-spike` | Where the log and the invocation counter live |
| `SQUIZ_SPIKE_MAX_BLOCKS` | `2` | How many invocations exit 2 before it starts exiting 0 |
| `SQUIZ_SPIKE_TOKEN` | `ZZQ-4417` | The arbitrary string the blocking reason asks for |
| `SQUIZ_SPIKE_LABEL` | `unlabelled` | Written into every log record, so one log can hold several runs |

`SQUIZ_SPIKE_MAX_BLOCKS` is clamped to 5 inside the script, and a non-numeric
value falls back to 2. An always-blocking `SubagentStop` hook is an unbounded
billed loop, and the clamp is there so that a typo cannot start one.

The counter file is not reset between runs. Delete `$SQUIZ_SPIKE_DIR` before
each run, or the hook will start already over its budget and exit 0 the first
time it fires.

## What was run

The whole experiment ran outside this repository, in a throwaway git repository
under a scratch directory, so that the proof files it produces do not land in
the worktree. `$SPIKE` below is the absolute path to `spike/` in this worktree,
and `$SB` is that scratch directory.

The plugin was validated first:

```
claude plugin validate ./spike
```

which passed with one warning, that the manifest names no author.

Then a cheap session with no subagent in it, to see the plugin load:

```
claude -p --plugin-dir "$SPIKE" --model sonnet --debug-file "$SB/dbg.log" \
  'Reply with the single word OK. Use no tools.'
```

Then the run that matters:

```
SQUIZ_SPIKE_DIR=/tmp/squiz-spike SQUIZ_SPIKE_MAX_BLOCKS=2 SQUIZ_SPIKE_LABEL=run1 \
claude -p --plugin-dir "$SPIKE" --model sonnet \
  --permission-mode acceptEdits \
  --output-format stream-json --verbose --include-hook-events \
  --forward-subagent-text \
  --max-budget-usd 2 \
  --debug-file "$SB/run1.dbg" \
  'Use the Task tool exactly once. Launch a subagent with subagent_type
   "general-purpose" and give it exactly this prompt: "Reply with the single
   word PING. Use no tools unless you are told to." After the Task tool
   returns, reply with the single word DONE. Do not launch a second Task. Do
   not create or edit any files yourself.'
```

`--include-hook-events` and `--forward-subagent-text` are what make the run
readable. The first puts a `hook_started` and a `hook_response` event into the
stream for every hook invocation, with the exit code and the captured stderr.
The second puts the subagent's own messages into the stream, each tagged with
the `parent_tool_use_id` of the tool call it belongs to. Together they show both
what the hook did and what the subagent did about it.

The run cost $0.13 and took 27 seconds.

Nothing was registered in `~/.claude/settings.json`. Its checksum was taken
before the run and again after, and it did not change. The hook reached the
session only through `--plugin-dir`.

## What was observed

### The plugin loaded

The debug log names the plugin by name at four separate points:

```
Read hooks.json for plugin squiz-spike (enabled=true): .../spike/hooks/hooks.json
Loaded inline plugin from path: squiz-spike
Loading hooks from plugin: squiz-spike
Registered 1 hooks from 1 plugins
```

This matters because a plugin that failed to load and a hook that never fired
produce exactly the same output, which is none. The debug log separates them.
`--debug hooks` on its own printed nothing in print mode; `--debug-file <path>`
is what produced this.

`--plugin-dir` wants the plugin root itself, the directory holding
`.claude-plugin/`, not a parent directory of several plugins.

### The hook fired, three times

The hook writes a timestamped record and the full payload to
`$SQUIZ_SPIKE_DIR/hook.log` before it decides anything. After the run the log
held three records and the counter read 3, against one subagent.

That the directory does not exist until the hook creates it is the point. Before
the run it was deleted. After the load-only session with no subagent in it, it
still did not exist, which is what a hook that correctly did not fire looks
like. After the real run it existed and held three records. A hook that fired
and exited 0 would still have written the record.

### Exit 2 fed the stderr back to the subagent

Each of the first two invocations exited 2. The stream shows what the runtime
made of that:

```json
{
  "type": "system", "subtype": "hook_response",
  "hook_name": "SubagentStop", "hook_event": "SubagentStop",
  "stdout": "",
  "stderr": "squiz-spike block 1 of 2.\nBefore you finish, write ...",
  "exit_code": 2,
  "outcome": "error"
}
```

and immediately after it, a synthetic user message inside the subagent:

```
Stop hook feedback:
[/abs/path/to/spike/hooks/subagent-stop.sh]: squiz-spike block 1 of 2.
Before you finish, write the exact string ZZQ-4417-1 to a file named
proof-1.txt in your current working directory, using the Write tool. ...
```

`stdout` was empty and `stderr` carried everything, so on exit 2 the runtime
takes the reason from stderr alone. The message goes to the **subagent**, not to
the session that dispatched it. Claude Code's published hooks documentation says
that a `SubagentStop` hook's stderr is "shown to Claude", which is ambiguous
between the two; the run settles it as the subagent.

### The subagent acted on the reason, not on its own momentum

The blocking reason asked for something no agent would do unprompted: write the
exact string `ZZQ-4417-1` to a file named `proof-1.txt`. After the run both
`proof-1.txt` and `proof-2.txt` existed in the scratch directory, holding
exactly `ZZQ-4417-1` and `ZZQ-4417-2` and nothing else.

A subagent that merely kept talking after being blocked would prove nothing,
because a subagent may keep talking for its own reasons. Two files that could
only have come from two specific instructions, each written after the
invocation that carried it, is what rules that out. The second file also shows
the second block landed, so the mechanism is not a one-off that the runtime
declines to repeat.

### It resumed inside the same turn

Told apart from "the turn ended and a new one started" by four things in the
stream, which all agree:

- **One tool call.** The parent issued exactly one `Agent` tool use,
  `toolu_01QmyG3q…`, and received exactly one `tool_result` for it, after the
  third hook invocation. Had the turn ended and restarted, there would have been
  a second tool use and a second result.
- **One `prompt_id`.** All three hook payloads carried the same `prompt_id`,
  `dff73d9c-dbd2-45dc-b134-97af1bfa1c03`, and the same `session_id`. A new turn
  carries a new `prompt_id`.
- **The feedback is addressed into the open call.** Every message between the
  first hook firing and the final result — the feedback, the subagent's
  thinking, its `Write` calls, the results of those calls — carried
  `parent_tool_use_id` equal to that one `Agent` tool use id. Nothing appeared
  at the top level in between.
- **The run's own accounting.** `subagent_stats` reported `spawned: 1` and
  `completed: 1`, and `num_turns` was 2, one for the parent's tool call and one
  for its final reply.

In order, the subagent's messages ran: `PING`, then feedback, then `Write`, then
"Done — I wrote ZZQ-4417-1", then feedback, then `Write`, then "Done — I wrote
ZZQ-4417-2", and only then did the tool call return. This is what § 3 step 4
describes.

## What M1 has to account for

### The runtime rewrites the blocking reason

The hook's stderr is not delivered verbatim. The runtime prepends a fixed line
and the absolute path of the hook command:

```
Stop hook feedback:
[<absolute path to the hook command>]: <the hook's stderr, verbatim from here>
```

§ 7 says the blocking reason "names the open threads and the commands that work
them, and the coding agent reads it as its next instruction". That still holds,
but the reason arrives with a prefix the harness does not control, and the
harness's first line is not the agent's first line. Anything the reason's
formatting relies on has to survive that prefix. The path in the prefix will be
the path to `bin/squiz`, which is a plausible thing for the coding agent to see
and reasonable to leave alone.

Only one hook was registered. Whether several hooks each get their own bracketed
line, or how their stderr is joined, was not tested.

### `outcome` reads `error` for a deliberate block

The `hook_response` event labels exit 2 as `"outcome": "error"`. Squiz exits 2
on purpose, on the loop's happy path, so anything that reads these events —
logging, a future doctor command, a person reading a transcript — will see the
harness's normal operation recorded as an error. It is cosmetic, and it is worth
knowing before someone reports it as a bug.

### The dispatching agent sees only the last message, and may distrust it

The agent that launched the subagent received one tool result, containing the
subagent's final message and nothing else. It did not see the block, the
feedback, or the work in between. It reacted to the divergence by saying so:

> instead of replying "PING" with no tools, it claimed to have written a file
> (`proof-2.txt`) containing an unrelated string `ZZQ-4417-2` … this looks like
> it could be a prompt injection or tampering of some kind.

The instruction in this experiment was deliberately arbitrary and unrelated to
the subagent's task, which is most of why it read as tampering. Real blocking
reasons will be review findings on the subagent's own pull request, which is
coherent with what the subagent was asked to do, so this particular reaction may
not recur. The underlying shape does though: the dispatching agent sees the end
of a story whose middle was written by the harness, and § 3 says nothing about
what it should make of that. Worth watching for during M1 rather than designing
around now.

## What this did not settle

- **Whether the runtime caps consecutive blocks.** The third invocation exited 0
  because the spike's own budget of 2 was spent, not because the runtime stopped
  honouring exit 2. Nothing here says what would have happened at block 3, 5 or
  20. The round cap in § 3 is set by the harness, so this matters only as a
  ceiling the harness must stay under, and finding that ceiling is the
  `stop_hook_active` subtask's job.
- **Behaviour with more than one registered `SubagentStop` hook**, including how
  several hooks' stderr is combined and whether one exiting 2 suppresses the
  others.
- **Behaviour in an interactive session.** Everything here ran under `-p`.
- **`matcher` in the registration.** The registration omits it, so the hook fires
  for every subagent type. Whether a `matcher` narrowing it to one agent type
  works was not tested.
- **A second run.** The result was clean and internally consistent, so it was
  not repeated. There is no evidence here about how stable it is across runs or
  across models. The run used `claude-sonnet-5` for both the parent and the
  subagent.

## Seen in passing

Not what this note set out to establish, and each belongs to another M0 subtask
that should confirm it deliberately. Recorded because it was in the log.

The payload the hook received on every invocation:

```json
{
  "session_id": "…", "prompt_id": "…", "cwd": "…",
  "transcript_path": "…", "agent_transcript_path": "…",
  "permission_mode": "acceptEdits", "effort": {"level": "xhigh"},
  "hook_event_name": "SubagentStop",
  "agent_id": "a6f2258998dc7a2dd", "agent_type": "general-purpose",
  "stop_hook_active": false,
  "last_assistant_message": "PING",
  "background_tasks": [], "session_crons": []
}
```

- `agent_id` was present and identical across all three invocations. It is the
  field § 3 wants to key an episode on. One subagent stopping three times is not
  the same as the same subagent across separate dispatches, which is what that
  subtask has to check.
- `stop_hook_active` was `false` on the first invocation and `true` on the
  second and third.
- `cwd` and the hook process's own working directory were both the directory the
  session was started in, and `git rev-parse --show-toplevel` run from the hook
  resolved to it. One subagent, one directory, so this says nothing yet about
  two running at once.
- `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PROJECT_DIR` were both set in the hook's
  environment.
- `last_assistant_message` carried the subagent's final text, which changed with
  each invocation. Anything that wants the subagent's own words has them without
  reading the transcript.
