---
settles: "§ 4 — whether a reviewer can be stopped from changing the commit, and what the stop is worth"
issue: 243
recorded: 2026-09-29
versions: { pi: 0.85.1, node: 24.15.0 }
recheck-when: pi upgrades, pi changes the tool_call event, or pi changes what it answers a blocked call with
---

# The extension stops a call before it runs

## Intent

- Whether a reviewer that moves `HEAD` can be stopped at all.
- Whether an extension handler runs at `--print --mode json`, the only mode the
  harness uses.
- What a stopped call answers with, and whether the reviewer reads it while it can
  still choose something else.
- What a handler that throws does to the call.
- How the round can count what it refused.

## Decisions

- **Refuse the call from a `tool_call` handler the extension subscribes, returning
  `{ block: true, reason }`.** `pi` installs the handler on the Agent instance
  rather than anywhere in the TUI, so print mode reaches it, and the tool never
  executes. Nothing in a command can undo it, because the command never runs.

- **Refuse `edit` and `write` by name, and six `git` commands by reading the
  command line.** A review reports through the calls and has no use for a write
  primitive, so the two tools need nothing read out of their arguments. The
  commands are the ones that move `HEAD` while leaving the worktree as it was:
  `git commit`, `git commit --amend`, `git reset --soft`, `git checkout -B`,
  `git update-ref` and `git push`.

- **Read the line the way the shell splits it, in a function of its own that is
  tested on its own, and match a name only where a command runs.** A substring of
  the whole line is wrong in both directions at once: it refuses a `grep` that
  only reads, and lets through a commit written with git's ordinary options. So
  the splitter honours the quoting rules, skips a comment, keeps an empty quoted
  word, and reads a short option's value written onto its flag. The subcommand is
  the first word after `git` that is not an option, and a listed flag counts
  wherever it sits.

- **Say in the code, where the list is defined, that splitting a line into words
  is not a boundary.** It refuses a reviewer that is not trying to get around the
  list. A word the shell would build out of quoting or substitution is left alone,
  so `git "com"mit` and `git $(echo commit)` run, and so do a script file, an
  encoded string and `sh -c`. Escalating the matching is an arms race, and a
  comment claiming more than the code delivers is worse than none.

- **Refuse a `bash` call whose command cannot be read, rather than running it.**
  The field the command arrives in is `pi`'s, and one it renames would leave every
  pattern matching nothing, which reads exactly like a reviewer that ran no git.

- **Count the refusals off the stream, by the text every refusal opens with.** A
  blocked call comes back as that call's own error result carrying the reason, so
  the count needs no second channel. The round reports it, because a reviewer that
  spent its window being refused returns the findings of one that had nothing to
  say.

- **Render the count nowhere until a round is seen to make it non-zero.** Nothing
  has yet observed a reviewer reaching for a listed command, so the summary would
  carry a line that is always absent. What the count costs while it goes unread is
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

`git`'s own options come before the subcommand, and these take the word after
them: `-C`, `-c`, `--git-dir`, `--work-tree`, `--namespace`, `--exec-path` and
`--config-env`. Their `--option=value` spellings need no list of their own,
because a word opening with `-` is an option and the subcommand is the first word
that is not one.

**`git -C ""` changes no directory and runs the subcommand after it.** git only
chdirs when the argument has a character in it, so the empty string is accepted
and the commit goes through. The word has to survive the splitting for the
option to take it.

`-B` takes its value attached as well as apart, so `git checkout -Breview-copy`
is `git checkout -B review-copy`.

**`pi` runs a `bash` call in `/bin/bash --noprofile --norc`, fed on stdin.** That
shell is not interactive, so a `#` where a word starts is a comment every time.

## Limits

- **No model was run.** Everything here comes from reading `pi`'s shipped
  JavaScript and from driving the extension through a stand-in that dispatches a
  call the way `pi` dispatches it. Nothing establishes that a reviewer reaches
  for these commands, how often, or what it does once refused.
- **The matching is defeated by anything that means to defeat it**, and the code
  says so. What the list holds is a reviewer acting in good faith. A command run
  by another command — after `env`, `xargs` or `ssh` — is read as that command's
  arguments and matches nothing, and a heredoc's body is read as script rather
  than as text.
- **A short option written in a cluster is not read.** `-Breview-copy` matches
  `-B` and `-qB review-copy` does not. The splitting decides the words; which
  letters of a word git would read as separate options is git's own parsing,
  and nothing here does it.
- **One machine, macOS, `pi` 0.85.1.** The extension runner, the hook
  installation and the agent loop's tool preparation are all `pi` internals, and
  none of them is in its documented interface.
- **Nothing was measured about `terminate`.** The handler never sets it, and a
  round whose reviewer is refused runs on to its own end.
