---
settles: "§ 4 — whether `pi`'s extension can refuse a call before it runs, what the reviewer reads when it does, and how the round counts what it refused"
issue: 243
recorded: 2026-09-29
versions: { pi: 0.85.1, node: 24.15.0 }
recheck-when: pi upgrades, pi changes the tool_call event, or pi changes what it answers a blocked call with
---

# The extension stops a call before it runs

## Intent

- Whether a reviewer's call can be stopped before it runs at all.
- Whether an extension handler runs in the modes the harness uses.
- What a stopped call answers with, and whether the reviewer reads it while it can
  still choose something else.
- What a handler that throws does to the call.
- How the round can count what it refused.

## Decisions

- **Refuse the call from a `tool_call` handler the extension subscribes, returning
  `{ block: true, reason }`.** `pi` installs the handler on the Agent instance
  rather than anywhere in the TUI, so print mode and interactive mode both reach
  it, and the tool never executes. The handler refuses a call to any tool the
  grant does not name, and a read outside the snapshot.

- **Keep the refusal of a tool outside the grant, though `--tools` already
  withholds it.** While the grant is passed, the model is shown no other tool and
  the refusal never fires. It is what holds if the grant ever stops being
  passed, because `pi` then falls back to its default tools, a shell among
  them.

- **Count the refusals the extension records.** A blocked call comes back as
  that call's own error result carrying the reason, and the extension writes
  each refusal to the report file beside the reports, so the count needs no
  second channel. The round reports it, because a reviewer that
  spent its window being refused returns the findings of one that had nothing to
  say.

- **Render the count nowhere until rounds are seen to make it non-zero.** When
  this was recorded nothing had observed a reviewer making a call the handler
  refuses, so the summary would carry a line that is always absent. What the count costs while it goes unread is
  that an episode whose reviewer was refused still reads as one that found nothing,
  and dogfooding settles whether that case arrives.

## Needs your input

Nothing.

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
  call the way `pi` dispatches it. Nothing establishes how often a reviewer is
  refused, or what it does once refused.
- **One machine, macOS, `pi` 0.85.1.** The extension runner, the hook
  installation and the agent loop's tool preparation are all `pi` internals, and
  none of them is in its documented interface.
- **Nothing was measured about `terminate`.** The handler never sets it, and a
  round whose reviewer is refused runs on to its own end.
