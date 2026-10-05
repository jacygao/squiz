---
settles: "§ 4 — whether interactive pi in a pane can be the reviewer, how its reports reach the round, and how it ends"
issue: 277
recorded: 2026-10-03
versions: { pi: "0.85.1 and 1.0.0", model: deepseek-v4-pro, tmux: 3.7b, node: 24.15.0 }
recheck-when: pi upgrades past 1.0.0, or the extension API's ctx.shutdown, agent_settled or sendUserMessage changes
---

# An interactive pi in a pane reviews like the headless one

`pi` run in a tmux pane without `--print --mode json`, and with squiz's grant,
`--no-approve`, `--no-extensions --extension` and the charter, starts the review
at once from a positional prompt. It loads squiz's extension and registers the
three reporting calls, and the refusals still refuse. When the extension calls
`ctx.shutdown()` after `finish_review`, it exits with status 0. The same held on
0.85.1 and on 1.0.0. The real round over `20f8a1d` ran 324 seconds for $0.26,
reported no findings, which is right for that change, and exited 3.4 seconds
after `finish_review`.

## Intent

- Can `pi` run interactively in a pane with squiz's `--tools` grant and
  `--extension`, with the calls registered and the refusals refusing?
- How does the harness hand it the prompt and read its findings back?
- Does it exit by itself when the review is done, and if not, how does the
  harness know?
- Is RPC or JSON mode in a pane a better fit than true interactive mode?

## Decisions

- **Host the reviewer as interactive `pi`, on the command line `argv.ts` builds
  today minus `--print`, `--mode json` and `--no-session`.** Everything the
  round depends on behaved as it does headless: `ctx.mode` was `"tui"`, the
  active tools were exactly the grant, `git commit --amend` was refused with
  squiz's reason, and a malformed finding was refused with the extension's own
  error. Dropping `--no-session` keeps `--session-dir`, so `pi` writes the
  round's session file there, as `<timestamp>_<uuid>.jsonl`. The runs here
  pointed it at a scratch directory; the round host would point it at
  `.squiz/<number>/`. With `--no-session` kept there is no session to resume.

- **Hand it the prompt as the positional argument.** It ran at once, with no
  keystroke. For a round host that starts `pi` before the prompt exists,
  `pi.sendUserMessage()` from the extension's `session_start` handler works as
  well, and started the agent 1 ms after the session. Do not type it in with
  `send-keys`: the prompt holds a diff, and in the editor Enter submits.

- **Read the findings from a file the extension writes, not from `pi`'s output.**
  In interactive mode stdout is the screen. The extension's tool `execute`
  receives the same `details` the JSON stream carries, and a wrapper that
  appended them to a file recorded every report and every refusal in order. A
  reviewer in a pane depends on that report file.

- **Have the extension end the session. `pi` does not end it.** Interactive `pi`
  waits for input when the agent settles, indefinitely. Two calls end it:
  - `ctx.shutdown()` inside `finish_review`'s `execute`. It is deferred until
    the agent is idle, so the reviewer writes its closing message first. That
    took 1.5 to 3.4 seconds, as in headless mode.
  - `ctx.shutdown()` from an `agent_settled` handler, for a reviewer that stops
    without `finish_review`. It exited 0.06 seconds after settling. Before it
    shuts down, the extension writes that the round ended unfinished, so the
    harness can tell the two endings apart from the file.

  The harness then waits for the process to exit, and needs no idle detector.

- **Close a settled reviewer's pane once the review finishes, keeping its
  session.** The owner decided this on #295. The pane run drops `--no-session`,
  and `--session-dir` points at `.squiz/<number>/`, where the session file
  stays. Before the pane closes, it prints the
  `pi --session-dir … --session <id>` line that resumes the session. Closing
  is also what bounds a reviewer that never calls `finish_review`, and
  questions put after the round would not be part of the review.

- **Do not use RPC or JSON mode for the pane.** JSON mode is print mode: `hasUI`
  is false and it exits after the prompt. RPC mode works for squiz. The
  extension loaded, `ctx.mode` was `"rpc"`, the stream carried the same
  `tool_execution_end` details, and `ctx.shutdown()` exited the process although
  stdin was still open. But the harness then owns stdin and stdout, so a person
  watching the pane sees JSON lines and cannot type. Interactive mode with the
  report file gives the person `pi`'s own screen, and gives squiz the same data.

## Needs your input

Nothing.

## Reference

### What the round's extension adds for a pane

| Hook | Does | Seen |
|---|---|---|
| each reporting call's `execute(id, params, signal, onUpdate, ctx)` | append `details`, or the refusal's error, to the report file | every call, in order |
| `finish_review`'s `execute` | `ctx.shutdown()` after recording it | exit 1.5 to 3.4 s later, status 0 |
| `on("agent_settled", (event, ctx) => …)` | record an unfinished end, then `ctx.shutdown()` | exit 0.06 s later, status 0 |
| `on("session_start", …)` | `pi.sendUserMessage(prompt)`, where no positional prompt was given | agent started 1 ms later |

The fifth argument to `execute` is the context `ctx.shutdown()` hangs off. Today's
extension declares `execute` with two parameters, so a pane needs the type
widened.

### Traps

- **Interactive `pi` writes to its config directory.** At startup it set
  `lastChangelogVersion` in `settings.json` and refreshed `models-store.json`.
  On the first start after an upgrade it fills the pane with the changelog, and
  it shows an "Update Available" banner. Whether headless runs write the same
  files was not checked. A round
  host either accepts those writes in the user's `~/.pi/agent`, or points
  `PI_CODING_AGENT_DIR` at a copy, which carries `auth.json` with it.
- **The pane's stdin is the terminal.** The headless rule that stdin must be
  `/dev/null` does not apply, and a person can type into the review.
- **A positional prompt is shown whole in the pane**, diff included, as the
  first user message.
- **When `pi` exits, the pane keeps its last frame** and the `To resume this
  session` line, then returns to whatever the pane runs next.
- **1.0.0 makes `--tui-mode fullscreen` the default**, and its
  `--no-extensions` also turns off its built-in extensions. Neither changed
  anything measured here.

## Limits

- One real review, on 0.85.1 only, of a one-line change with no known defect.
  On 1.0.0 only the cheap probe ran: the refusals, one rejected finding and one
  accepted, and `finish_review`. A pane round that reports findings on a real
  change was not run.
- The refusals were exercised through `bash` alone, at the `deep` grant. `edit`
  and `write` are outside the grant, so the model could not call them.
- Nobody typed into a running pane, and what a person's input does to a round
  is not measured.
- Herdr was not tried. Neither was what `kill-window`, a pane close or SIGTERM
  reaches, which is spike S4, nor Linux.
- `--thinking medium` showed as `high`. `deepseek-v4-pro` maps only `high` and
  `max`, so `pi` clamps the level. That is the model, not the pane, and it
  applies headless too.
