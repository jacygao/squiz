---
settles: "§ 5: whether interactive pi in a pane can be the reviewer, how its reports reach the round, and how it ends"
issue: 277
recorded: 2026-10-03
versions: { pi: "0.85.1 and 1.0.0", model: deepseek-v4-pro, tmux: 3.7b, node: 24.15.0 }
recheck-when: pi upgrades past 1.0.0, or the extension API's ctx.shutdown, agent_settled or the fifth argument to a tool's execute changes
---

# An interactive pi in a pane reviews like the headless one

## Intent

- Whether `pi` can run interactively in a pane with squiz's `--tools` grant and
  `--extension`, with the calls registered and the refusals refusing.
- How the harness hands it the prompt and reads its findings back.
- Whether it exits by itself when the review is done, and if not, how it is
  ended.
- Whether RPC or JSON mode in a pane fits better than interactive mode.

## Decisions

- **Host the reviewer in a pane as interactive `pi`: the detached command line
  without `--print`.** Everything the round depends on behaved as it does
  headless: `ctx.mode` was `"tui"`, the active tools were exactly the grant, a
  call the extension's `tool_call` handler refuses was refused with squiz's
  reason, and a malformed finding was refused with the extension's own error.
  `--session-dir` keeps the session file, as `<timestamp>_<uuid>.jsonl`, so the
  round can save the command that resumes it.
- **Hand it the prompt on the command line, never with `send-keys`.** A prompt
  on the line started the agent at once, with no keystroke. The prompt spans
  several lines, and typed into the editor its first newline would submit it.
  Squiz passes it as `@<prompt file>`, since Herdr refuses a newline on the line
  (unverified in a pane run here).
- **Read the findings from the report file the extension writes, not from
  `pi`'s output.** In interactive mode stdout is the screen. Each tool's
  `execute` receives the same `details` the JSON stream carries, and a file it
  appended to recorded every report and every refusal in order.
- **Have the extension end the session, since `pi` never does.** Interactive
  `pi` waits for input when the agent settles, indefinitely. Two calls end it:
  - `ctx.shutdown()` inside `finish_review`'s `execute`. It waits until the
    agent is idle, so the closing message is written first, and `pi` exited
    with status 0 1.5 to 3.4 seconds later, as headless.
  - `ctx.shutdown()` from an `agent_settled` handler, for a reviewer that stops
    without `finish_review`, after the extension records the round as
    unfinished. It exited with status 0 0.06 seconds after settling.

  The harness then waits for the process to exit, and needs no idle detector.
- **Do not use RPC or JSON mode in the pane.** JSON mode is print mode: `hasUI`
  is false and it exits after the prompt. RPC mode works, `ctx.shutdown()`
  included, but the harness then owns stdin and stdout, so a person watching
  the pane sees JSON lines and cannot type.

## Needs your input

Nothing.

## Reference

| Extension hook | Does | Seen |
|---|---|---|
| each reporting call's `execute(id, params, signal, onUpdate, ctx)` | appends `details`, or the refusal's error, to the report file | every call, in order |
| `finish_review`'s `execute` | `ctx.shutdown()` after recording it | exit 1.5 to 3.4 s later, status 0 |
| `on("agent_settled", (event, ctx) => …)` | records an unfinished end, then `ctx.shutdown()` | exit 0.06 s later, status 0 |
| `on("session_start", …)` | `pi.sendUserMessage(prompt)`, where no prompt is on the line | agent started 1 ms later |

`ctx` is the fifth argument to `execute`.

### Traps

- **Interactive `pi` writes to the user's config directory.** At startup it set
  `lastChangelogVersion` in `settings.json` and refreshed `models-store.json`
  under `~/.pi/agent`, since the round leaves `PI_CODING_AGENT_DIR` as the user
  has it. On the first start after an upgrade it fills the pane with the
  changelog, and it shows an "Update Available" banner.
- **The pane's stdin is the terminal.** The headless rule that stdin must be
  `/dev/null` does not apply, and a person can type into the review.
- **The prompt is shown whole in the pane**, as the first user message.
- **1.0.0 makes `--tui-mode fullscreen` the default**, and its `--no-extensions`
  also turns off its built-in extensions. Neither changed anything measured.

## Limits

- **One real review, on 0.85.1, of a one-line change with no known defect.** On
  1.0.0 only the refusals, one rejected finding, one accepted finding and
  `finish_review` were run. A pane round that reports findings on a real change
  was not run.
- **The refusals were exercised through `bash`**, under a grant that carried it.
  No grant carries it now.
- **What a person typing into a running pane does to a round** was not measured.
- **Herdr, Linux, and what a pane close or `SIGTERM` reaches** were not tried.
- **Whether headless `pi` writes the same config files** was not checked.
