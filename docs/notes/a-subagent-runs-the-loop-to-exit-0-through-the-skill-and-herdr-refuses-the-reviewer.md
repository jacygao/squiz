---
settles: "§ 3 — whether the skill is enough for a dispatched subagent to run the loop to its end, and what the hooks queue during it; § 4 — starting the reviewer in a Herdr pane; § 9 — the skill's text"
issue: 338
recorded: 2026-10-05
versions: { claude-code: 2.1.289, coding-agent: claude-opus-5-5, pi: 0.85.1, herdr: 0.9.3, node: 24.15.0, squiz: b30978d }
recheck-when: the skill's text or description changes, Herdr changes which agent arguments it accepts, or the pi adapter stops passing the prompt as an argument
---

# A subagent runs the loop to exit 0 through the skill, and Herdr refuses the reviewer

A `general-purpose` subagent whose brief never named squiz opened a pull request,
loaded `squiz:squiz-review` on its own and ran `squiz review`, in both runs. Run 2
ended on exit 0 after one round with nothing found. Run 1 never reached a
reviewer: inside Herdr, every round fails at `herdr agent start`, because the
prompt `pi` is given holds newlines and Herdr refuses an argument that does.

## Intent

- Whether a subagent dispatched with a brief that does not mention squiz loads
  the skill, runs `squiz review`, works the threads and ends on exit 0 or 3.
- Whether the `Stop` and `SubagentStop` hooks queue anything the command had not.
- Whether the pull request carries one set of threads per state.
- Whether the round's result wakes the dispatching session through its socket.

## Decisions

- **Keep the § 9 skill text as it is.** Both subagents loaded it straight after
  `gh pr create`, without being told to, and followed it: run 1 stopped on the
  exit 1 and put the lines in its report, and run 2 stopped on the exit 0. Each
  ran the command as `squiz review <n>; echo "EXIT=$?"` with the 600000 timeout
  the skill names, and neither call was moved to the background.

- **Fix the Herdr start before any round is run inside Herdr.** The pane's
  command line ends with the reviewer's prompt, which has newlines, and Herdr
  0.9.3 refuses any `agent start` argument holding a newline or a tab, as
  `invalid_agent_argument`, before it looks at the pane. The round fails, posts
  its failure comment, and the episode stays live. Filed as #442.

- **Leave the hooks as they are.** In neither run did a hook queue a state. The
  `SubagentStop` firing came after the subagent's own command had settled the
  state, failed in run 1 and closed in run 2, and the parent's `Stop` firing ran
  in a checkout whose branch has no pull request and said so. Each pull request
  carries one comment from squiz, and no thread.

- **Do not count on the socket wake in this flow.** No owner was recorded on any
  state, so no note was written and nothing was posted to the parent's socket.
  This is what § 3 sets out for a subagent that runs `squiz review` itself: its
  command waits out the round inside its own turn, and the hook that would record
  the owner fires only after that turn ends.

## Needs your input

- **Whether #338 counts as done with no thread worked.** Run 2's reviewer found
  nothing, so the half of the first criterion about working threads, and the
  half of the second about threads per state, were not exercised. The brief
  planted nothing, as asked. Recommended: take run 2 as reaching exit 0 through
  the skill, and leave a seeded-defect run, which would exercise exit 2 and the
  replies, to be done once #442 is fixed, inside Herdr.
- **What P-level #442 carries.** It stops every round started inside Herdr, which
  is the setting M7 was built for, so it reads as P1, and the repository has no
  label for P1. Recommended: P1.

## Reference

### Per run

| | Run 1 | Run 2 |
|---|---|---|
| Test pull request | #441 | #444 |
| Environment the nested session got | the owner's Herdr variables | none of Herdr's, and no `TMUX`, so the reviewer ran with no terminal |
| Skill loaded unprompted | yes | yes |
| Round 1 | failed in 3 s: `herdr agent start: refused: invalid_agent_argument: agent arguments cannot be encoded safely for the target shell` | reviewed in 65 s, 0 findings, $0.0335, 81,739 tokens; reviewer backend `detached` |
| Exit | 1 | 0 |
| What squiz posted | the failure comment | the summary comment, `1 round, 0 findings` |
| Threads | none | none |
| Notes written | none | none |
| Herdr tab | none left; the pane was closed by the failed start | not used |

### What Herdr refuses

```
$ herdr agent start probe --kind pi --pane nonexistent --timeout 1000 -- pi $'line1\nline2'
{"error":{"code":"invalid_agent_argument","message":"agent arguments cannot be encoded safely for the target shell"},"id":"cli:agent:start"}
```

A tab character is refused the same way. Quotes, `$`, backticks and an em dash are accepted,
and reach `agent_pane_not_found` instead. The argument is `invocation.prompt`,
the last one `argv()` builds in `src/reviewers/pi/argv.ts`.

### The reviewer's environment

The round host is started from the subagent's Bash shell, and the reviewer `pi`
it started carried `CLAUDE_CODE_MESSAGING_TOKEN` from it. That shell's socket and
token are the dispatching session's, so at depth `deep` the reviewer's `bash`
could start a turn in the coding agent's session. Filed as #445, held for M9.

### How the runs were set up

- `claude -p --plugin-dir /Users/jacy/Documents/Dev/squiz-plugin --permission-mode auto --input-format stream-json --output-format stream-json --verbose`,
  run 2 adding `--debug-file`, with every `CLAUDE*` variable unset and stdin a
  FIFO held open so that a wake could reach it. The plugin checkout was at
  b30978d. No global setting was changed.
- The session started in a scratch worktree of this repository on a fresh
  branch. The prompt told it to dispatch one `general-purpose` subagent with
  `isolation: "worktree"` and a brief, word for word, asking for a `paginate`
  function and a `node:test` test under `scratch/e2e-338/`, a commit, a push of a
  named branch, and a pull request titled `[e2e #338] …` that says it will be
  closed unmerged. The brief named neither squiz, review nor the skill. Run 2's
  prompt also told the parent not to file issues, because run 1's parent filed
  #442 on its own under the dogfooding rule.

## Limits

- **No thread was ever posted.** Exit 2, `squiz reply`, a second round and exit 3
  were not reached in either run.
- **The reviewer in a pane was not seen to run.** Herdr refused it, and tmux was
  not tried.
- **The socket wake was not exercised.** No round recorded a result for an
  owner a hook had recorded.
- **What the `SubagentStop` hook printed was not captured.** That it queued
  nothing is read from the state file, which holds one record per run.
- **The subagent's worktree was not cut from the scratch checkout.** Claude Code
  put it under the main checkout's `.claude/worktrees/` and based it on that
  checkout's `HEAD`: b30978d in run 1 and a7ef4af in run 2, both origin/main at the time. The change under review was the one planned.
- **Two runs, one model, print mode only.** Opus 5.5 for the parent and the
  subagent, and the reviewer on whatever model the default settings gave it, which was not recorded. No interactive session.
