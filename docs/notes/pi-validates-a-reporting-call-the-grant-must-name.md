---
settles: "§ 4 — whether a finding can arrive as a call the reviewer's CLI validates, what that costs the grant, and where the harness reads the report back from"
issue: 165
recorded: 2026-09-25
versions: { pi: 0.85.1, node: 24.15.0 }
recheck-when: pi upgrades, pi changes how --tools filters extension tools, or pi changes what tool_execution_end carries
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
- **Put every reporting call in the grant, at both depths.** `--tools` filters
  extension tools exactly as it filters built-in ones: a call the grant does not
  name is not registered, is not in `getAllTools()`, and the run exits 0 with an
  empty stderr. A grant short of a reporting call is a reviewer with no way to
  report and a round with nothing to say about why.
- **Read a report out of the call's answer rather than out of its arguments.**
  `pi` converts an argument to the type the schema declares before the call
  runs, so a `line` of `"128"` reaches the call as `128` and is accepted. The
  arguments in `tool_execution_start` are what the model sent; the answer in
  `tool_execution_end` is what was accepted. Reading the arguments drops a
  finding the reviewer was told had landed.
- **Answer with a short line and carry the report in `details`.** No provider
  serialises `details`, so the report goes back to the harness whole without
  being paid for a second time in the reviewer's context.
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

## Reference

The flags, exactly: `--extension <path>` (repeatable, `-e`), and
`--no-extensions` (`-ne`), which stops discovery and leaves explicit paths
loading.

The tool names the grant carries: `report_finding`, `report_verdict`,
`finish_review`.

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

What the harness reads a report out of:
`tool_execution_end.result.details`. The event also carries `toolCallId`,
`toolName` and `isError`. It is emitted before the `message_end` of the
matching `toolResult` message, which carries the same `details`.

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
- **One machine, macOS, `pi` 0.85.1.** The tool registry, the grant filter and
  the argument conversion are all `pi` internals, and none of them is in its
  documented interface.
- **Nothing measured what the schema costs the reviewer's context**, in tokens
  or in the review it produces. Three tools and their descriptions are on every
  request of every round.
