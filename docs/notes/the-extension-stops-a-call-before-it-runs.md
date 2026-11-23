---
settles: "§ 5: how `pi`'s extension refuses a call before it runs, what the reviewer reads when it does, and how the round counts what it refused"
issue: 243
recorded: 2026-09-29
versions: { pi: 0.85.1, node: 24.15.0 }
recheck-when: pi upgrades, pi changes the tool_call event, or pi changes what it answers a blocked call with
---

# The extension stops a call before it runs

## Intent

- Whether a reviewer's call can be stopped before it runs at all, in the modes
  the harness uses.
- What a stopped call answers with, and whether the reviewer reads it while it can
  still choose something else.
- What a handler that throws does to the call.
- How the round can count what it refused.

## Decisions

- **Refuse the call from a `tool_call` handler the extension subscribes,
  returning `{ block: true, reason }`.** `pi` installs the handler on the Agent
  instance rather than in the TUI, so print mode and interactive mode both reach
  it, and the tool never executes. The reviewer gets the reason as that call's
  own error result and can choose another call. The handler refuses any tool the
  grant does not name, and a read outside the snapshot.
- **Keep the refusal of a tool outside the grant, though `--tools` already
  withholds it.** While the grant is passed, the model is shown no other tool and
  the refusal never fires. It is what holds if the grant ever stops being passed,
  because `pi` then falls back to its default tools, a shell among them.
- **Count the refusals from the report file.** The extension writes each refusal
  there beside the reports, so the count needs no second channel. A reviewer that
  spent its window being refused otherwise returns what a reviewer with nothing
  to say returns.
- **Render the count nowhere until a round is seen to make it non-zero.** No
  reviewer had been seen making a call the handler refuses, so a summary line for
  it would always be absent. While it goes unread, an episode whose reviewer was
  refused reads as one that found nothing.

## Needs your input

Nothing.

## Reference

- **The subscription:** `pi.on("tool_call", handler)`, beside the extension's
  `registerTool` calls. `--tools` filters registered tools and does not touch an
  event subscription, so the handler needs no place in the grant.
- **The event:** `{ type: "tool_call", toolCallId, toolName, input }`.
  `toolName` is the tool's own name: `bash`, `edit`, `write`, `read`, `grep`,
  `find`, `ls`, or a name the extension registered. For `bash`, `input` is
  `{ command: string, timeout?: number }`.
- **The answer:** `{ block?: boolean, reason?: string, terminate?: boolean }`.
  The first handler that sets `block` wins and no later handler is asked. A
  handler that answers nothing objects to nothing.
- **A blocked call** becomes an immediate error result,
  `{ content: [{ type: "text", text: reason }], details: {} }`, emitted as a
  `tool_execution_end` with `isError` true. An empty `reason` becomes
  `Tool execution was blocked`.
- **A handler that throws blocks the call.** The agent loop catches the throw
  and returns an error result carrying its message, and the run carries on.
- **`pi` skips the event where nothing subscribed to it.** A subscription that
  goes missing leaves every round clean, every count zero, and nothing saying so.
- The handler is in `src/reviewers/pi/extension.ts`, and the grant check in
  `src/reviewers/pi/refusals.ts`.

## Limits

- **No model was run.** Everything here comes from reading `pi`'s shipped
  JavaScript and from driving the extension through a stand-in that dispatches a
  call the way `pi` does. How often a reviewer is refused, or what it does once
  refused, was not established.
- **One machine, macOS, `pi` 0.85.1.** The extension runner, the hook
  installation and the agent loop's tool preparation are `pi` internals, outside
  its documented interface.
- **`terminate` was not measured.** The handler never sets it.
