---
settles: "§ 4 — whether a finding can arrive as a call the reviewer's CLI validates, what `--tools` withholds and how a grant short of a name fails, why `pi` needs `/dev/null` on stdin, and where the harness reads the report back from"
issue: [11, 165]
recorded: 2026-09-25
versions: { pi: "0.84.2, 0.85.1", model: deepseek-v4-pro, node: 24.15.0 }
recheck-when: pi upgrades, pi changes how --tools filters extension tools, or pi changes what a tool call's execute receives
---

# `pi` validates a reporting call, and the grant must name it

## Intent

- **Nothing said whether `pi` could be given a reporting call at all.** A
  finding composed into the last message of a run is lost whenever the run is
  cut short, and a call the provider validates cannot be fenced and cannot omit
  a required field.
- **Nothing said whether an extension loads under `--print --mode json`.** The
  documented use of extensions is the interactive TUI.
- **Nothing said whether `--tools` reaches a tool an extension registered**, or
  whether a grant that leaves such a tool out says anything.
- **Nothing said where a report is read back from**, or whether what the model
  sent and what the tool received are the same value.
- **Nothing said what ends the run once the review is complete.** A run that goes
  on after the last finding spends the round's remaining time on a review that is
  already finished.
- **Nothing said whether `--tools` withholds a tool or only discourages it**, or
  what a name that matches no tool does.
- **Nothing said whether an extension may share code with the harness.** The
  harness has no runtime dependencies, and an extension that needed `typebox`
  would give it one.

## Decisions

- **Register the reporting calls from a file named with `--extension`, and pass
  `--no-extensions` beside it.** The extension loads under `--print --mode
  json`, and `--no-extensions` leaves the named file loading while discovery
  stops. Without it, an extension installed on the machine or sitting in the
  tree under review registers a tool of the same name and takes the round's
  reports, because a later registration replaces an earlier one by name.
- **Put every reporting call and history tool in the grant.** `--tools` filters
  extension tools exactly as it filters built-in ones: a call the grant does not
  name is not registered, is not in `getAllTools()`, and the run exits 0 with an
  empty stderr. A grant short of a reporting call is a reviewer with no way to
  report and a round with nothing to say about why.
- **Rely on `--tools` to withhold `edit`, `write` and `bash`.** A tool the grant
  leaves out is absent rather than discouraged: its schema is never sent, and it
  has no implementation in the run. A name that matches no tool withholds and
  never grants: beside real names it is dropped, and alone it leaves the run no
  tools at all rather than `pi`'s default set of `read`, `bash`, `edit` and
  `write`. Either way the run exits 0 with an empty stderr.
- **Give a headless `pi` `/dev/null` on stdin, whatever it is granted.** With an
  open pipe on stdin, `pi --print` emitted nothing and never exited, with one
  tool granted and with none, until it was killed at 25 seconds. With
  `< /dev/null` it returned in about a second. A hang and a refusal look alike
  from outside, so every run also needs the round's time bound.
- **Read a report out of the call's answer rather than out of its arguments.**
  `pi` converts an argument to the type the schema declares before the call
  runs, so a `line` of `"128"` reaches the call as `128` and is accepted. The
  arguments in `tool_execution_start` are what the model sent; the answer in
  `tool_execution_end` is what was accepted. Reading the arguments drops a
  finding the reviewer was told had landed.
- **Answer with a short line and carry the report in `details`.** No provider
  serialises `details`, so the report goes back to the harness whole without
  being paid for a second time in the reviewer's context. 2026-10-05: since M7
  the extension appends each accepted report to the round's report file, and
  the round reads that file rather than `pi`'s stream (§ 4 The `pi` adapter).
- **End the run from the round, once the reviewer has reported the review
  complete, and ask `pi` for nothing.** `terminate: true` on a tool's result ends
  the run only where every call of the same assistant message carries it, so a
  reviewer that reports a finding and finishes its review in one message is not
  obeyed and goes on to another model request. An instruction to finish last is
  not a guard: the model can obey it and still put both calls in one message.
- **Wait for every call the run started to be answered before signalling it.**
  `pi` answers the calls of one message in whatever order they complete, and its
  print mode exits on `SIGTERM` without flushing what it has written to stdout.
  So signalling on the finishing call alone loses a report of the same message
  that was accepted a moment later, and reading the pipe afterwards cannot
  recover it: those bytes never left the process. Bound the wait, because a call
  that never answers would otherwise hold a review that is already complete.
  2026-10-05: since M7 the extension ends the reviewer with `ctx.shutdown()`
  after `finish_review`, and the round waits for the process to exit (§ 4 The
  `pi` adapter).
- **Write the extension against structural types and a plain JSON Schema
  object.** `pi` validates a schema that is not a TypeBox value through its own
  JSON Schema path, so `typebox` need not be imported and the harness keeps no
  runtime dependency. An extension may import the harness's own `.ts` modules:
  `pi` compiles the extension and what it imports, extension included.

## Needs your input

- **Whether a live run should confirm that a model reaches for these calls.**
  Nothing here was measured against a model, so that the reviewer calls
  `report_finding` rather than describing a finding in prose is untested.
  Recommended: run one round against a real model before relying on a round's
  findings, since a reviewer that reports in prose now returns nothing at all
  rather than something the harness could still parse.

  2026-10-05: settled by a live run, which
  `the-reviewer-reports-through-the-calls-and-writes-no-prose.md` records.

## Reference

The flags, exactly: `--extension <path>` (repeatable, `-e`), and
`--no-extensions` (`-ne`), which stops discovery and leaves explicit paths
loading.

The reporting calls the grant carries: `report_finding`, `report_verdict`,
`finish_review`.

Where the grant is enforced: in `core/agent-session.js`, `--tools` becomes a set
that every registered tool name is filtered against, for both the definitions
sent to the model and the executable registry. At 0.84.2 a typo beside real
names, `read,grep,find,ls,bahs`, produced a request identical in size and
behaviour to `read,grep,find,ls`. A grant of `notatool` alone matched
`--no-tools` at 662 tokens, and the model, holding nothing, wrote a textual
imitation of a tool call.

`pi`'s own documentation: "Pi does not include a built-in sandbox. Built-in
tools can read files, write files, edit files, and run shell commands with the
permissions of the pi process." Granted `bash` at 0.84.2, a reviewer asked for
a fix used it to modify a tracked file on its first attempt, unprompted and
unrefused, so a grant that carries a shell confines nothing.

What a registered tool is: an object with `name`, `label`, `description`,
`parameters` and `execute`, passed to `pi.registerTool` by the module's default
export, which `pi` calls with its extension API. `promptSnippet` puts a one-line
entry in the system prompt's `Available tools`; `promptGuidelines` appends
bullets to its `Guidelines`, and each bullet must name its own tool.

How a call refuses: `execute` throws. The message becomes the call's answer,
`tool_execution_end` carries `"isError": true`, and the model reads it. A tool
cannot mark its own answer as an error by returning a flag.

What `terminate: true` on a result does: it ends the run only where every
finalized result of the same assistant message carries it. One call of a batch
asking for it has no effect at all, and nothing in the stream says so.

What `SIGTERM` costs a run in print mode: `pi` disposes its runtime and exits
without flushing its stdout queue, so an event it has written and not yet flushed
is gone. The parent's pipe holds only what was flushed, so draining it after the
exit recovers nothing.

The order the calls of one message are answered in: whatever order they complete.
Every `tool_execution_start` of a message is emitted before any of its prepared
calls is answered, so a run with nothing outstanding has answered all of them.

Where a report is read from: the report file the extension writes, one line for
each value a call accepted. When this was measured the harness read it from the
stream instead, as `tool_execution_end.result.details`, which carries the same
value.

What validation does and does not refuse, measured against the shipped schema:

| Arguments | |
|---|---|
| A missing required property | Refused, naming the property |
| A value outside an `enum` | Refused |
| An array property given as a string | Refused |
| A number property given as a string of digits | **Accepted**, converted to the number before `execute` |
| A property the schema does not declare | **Accepted**, and passed through |

## Limits

- **No model was run.** Every result here comes from `pi` started with an
  extension that writes what it was given and exits during `session_start`, and
  from calling `pi`'s own argument validator directly. Nothing establishes that
  a reviewer uses these calls, in what order, or how often it gets a finding's
  shape wrong.
- **What `terminate: true` does was read out of `pi`'s agent loop and driven
  offline**, with the loop's own tool executor over two batches. No live round
  was run against a provider to watch it.
- **The filtering and the stdin hang were measured at `pi` 0.84.2**, with
  `deepseek-v4-pro`, and not run again at 0.85.1.
- **One machine, macOS, `pi` 0.85.1.** The tool registry, the grant filter and
  the argument conversion are all `pi` internals, and none of them is in its
  documented interface.
- **Nothing measured what the schema costs the reviewer's context**, in tokens
  or in the review it produces. Three tools and their descriptions are on every
  request of every round.
