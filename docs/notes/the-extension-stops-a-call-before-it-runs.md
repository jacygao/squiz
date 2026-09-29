---
settles: "§ 4 — whether a reviewer can be stopped from changing the commit, and what the stop is worth"
issue: 243
recorded: 2026-09-29
versions: { pi: 0.85.1, node: 24.15.0 }
recheck-when: pi upgrades, pi changes the tool_call event, or pi changes what it answers a blocked call with
---

# The extension stops a call before it runs

## Intent

- **Nothing said whether a reviewer that moves `HEAD` could be stopped at all.**
  The two options on the table were to detect the move and name it, or to accept
  it as outside what the harness bounds. Both leave the commit changed.
- **Nothing said whether an extension handler is reached at `--print --mode
  json`**, which is the only mode the harness runs. The documented use of
  extensions is the interactive TUI.
- **Nothing said what a call the handler stops answers with**, or whether the
  reviewer reads that answer while it can still choose something else.
- **Nothing said what a handler that throws does.** A throw that let the call
  through would be the worst of the three outcomes and the quietest.
- **Nothing said how the round could count what it refused.** The extension runs
  inside `pi` and the harness reads `pi`'s stdout, so a count has to travel as
  part of the stream or not at all.

## Decisions

- **Refuse the call from a `tool_call` handler the extension subscribes, and
  return `{ block: true, reason }`.** `pi` installs the handler on the Agent
  instance rather than anywhere in the TUI, so print mode reaches it, and the
  tool never executes. Nothing in a command can undo it, because the command
  never runs.
- **Refuse `edit` and `write` by name, and the commands by matching their
  text.** A review reports through the calls and has no use for a write
  primitive, so the two tools need nothing read out of their arguments. The
  commands that have to be matched are only the ones that move `HEAD` while
  leaving the worktree as it was: `git commit`, `git commit --amend`, `git reset
  --soft`, `git checkout -B`, `git update-ref` and `git push`.
- **Say in the code, where the list is defined, that matching text is not a
  boundary.** It refuses a reviewer that is not trying to get around the list.
  Quoting, a script file, an encoded string and `sh -c` each defeat it. Escalating
  the matching is an arms race, and a comment claiming more than the code delivers
  is worse than none.
- **Refuse a `bash` call whose command cannot be read, rather than running it.**
  The field the command arrives in is `pi`'s. One it renames would otherwise
  leave every pattern matching nothing, which reads exactly like a reviewer that
  ran no git.
- **Count the refusals off the stream, by the text every refusal opens with.**
  A blocked call emits a `tool_execution_end` with `isError` true whose result
  carries the handler's reason, so the count needs no second channel. The round
  reports it, because a reviewer that spent its window being refused returns the
  findings of one that had nothing to say.

## Needs your input

- **Whether § 4's Confinement should name this as a fourth mechanism.** It lists
  three — scratch space, a non-mutating test invocation, and the comparison of
  tracked files — and says the third is the only thing that catches a write made
  through the shell. That is now wrong for the commands on the list above, which
  are prevented rather than detected. Recommended: add a row, and keep the
  comparison, which still covers everything the list does not.
- **Whether the count should reach the summary comment.** The round reports it
  and nothing above the round reads it yet, so a person reading the pull request
  cannot tell a reviewer that spent its window being refused from one that had
  nothing to say. Recommended: one Notes line, alongside the mutated file and the
  shared worktree that the summary is already due to carry.

## Reference

The subscription: `pi.on("tool_call", handler)`, alongside the `registerTool`
calls the extension already makes. `--tools` filters registered tools and does
not touch an event subscription, so the handler needs no place in the grant.

The event, as `pi` hands it over: `{ type: "tool_call", toolCallId, toolName,
input }`. `toolName` is the tool's own name — `bash`, `edit`, `write`, `read`,
`grep`, `find`, `ls`, or a name the extension registered. For `bash`, `input` is
`{ command: string, timeout?: number }`.

The answer: `{ block?: boolean, reason?: string, terminate?: boolean }`. The
first handler that sets `block` wins and no later handler is asked. A handler
that answers nothing is a handler that objects to nothing.

What a blocked call becomes: an immediate error tool result, `{ content: [{
type: "text", text: reason }], details: {} }`, emitted as a
`tool_execution_end` with `isError` true and sent back to the model as that
call's own result. `reason` left empty becomes `Tool execution was blocked`.

**A handler that throws blocks the call.** The throw is rethrown out of the hook
and caught by the agent loop's own try around the whole of the call's
preparation, which returns an error result carrying the message. The run carries
on. Fail-closed in both directions: nothing runs unless a handler was asked and
did not object.

**`pi` skips the event entirely where nothing subscribed to it.** The hook asks
whether any handler is registered and returns without emitting when none is. So
a subscription that goes missing leaves every round clean, every count zero, and
nothing anywhere saying so.

## Limits

- **No model was run.** Everything here comes from reading `pi`'s shipped
  JavaScript and from driving the extension through a stand-in that dispatches a
  call the way `pi` dispatches it. Nothing establishes that a reviewer reaches
  for these commands, how often, or what it does once refused.
- **The matching is defeated by anything that means to defeat it**, and the code
  says so. What the list holds is a reviewer acting in good faith.
- **One machine, macOS, `pi` 0.85.1.** The extension runner, the hook
  installation and the agent loop's tool preparation are all `pi` internals, and
  none of them is in its documented interface.
- **Nothing was measured about `terminate`.** The handler never sets it, and a
  round whose reviewer is refused runs on to its own end.
