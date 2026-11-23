---
settles: "§ 3 The hooks: who reads the line a stop writes on stderr when it finds no pull request"
issue: 264
recorded: 2026-10-03
versions: { claude-code: 2.1.288 }
recheck-when: Claude Code changes how it reports a hook that exits 0
---

# An exit-0 hook's stderr never reaches the parent session

## Intent

- Where a line a `SubagentStop` hook writes to stderr goes when it exits 0.

## Decisions

- **Write a stop's no-pull-request line to stderr, and do not count on a person
  or the dispatching session seeing it.** In print mode the line reaches the
  subagent's transcript, the debug log, and the stream only under
  `--include-hook-events`. Neither the parent's model nor the result is given
  it. The defence against a mis-dispatched subagent is the dispatch shape
  `a-subagents-hook-runs-where-it-was-dispatched.md` records.

## Needs your input

- **Whether an interactive session shows an exit-0 hook's stderr to a person.**
  Print mode cannot show it. Recommendation: look once, in an interactive
  session, at a subagent stopping on a branch with no pull request. If nothing
  appears, the line is a record for whoever reads the transcript.

## Reference

- **The subagent's transcript** carries it as an attachment:

  ```json
  {"type":"hook_success","hookName":"SubagentStop","hookEvent":"SubagentStop",
   "stdout":"","stderr":"squiz: I264-STDERR-MARKER no open pull request has main as its head\n",
   "exitCode":0}
  ```

- **`--debug-file`** logs `Hook SubagentStop (SubagentStop) success:` followed by
  the line.
- **The `stream-json` output** carries it only with `--include-hook-events`, as
  the `stderr` and `output` of a `hook_response` event. Without that flag there
  is no `SubagentStop` event in the stream at all.
- **The parent session's transcript and the result** do not carry it. Asked to
  report any hook output it saw, the parent said it saw none.

## Limits

- **Print mode only.** What an interactive session displays was not observable.
- **`SubagentStop` only.** A `Stop` hook's stderr was not traced.
