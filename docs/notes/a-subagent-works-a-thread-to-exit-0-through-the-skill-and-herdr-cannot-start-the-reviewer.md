---
settles: "§ 3 — whether the skill is enough for a dispatched subagent to run the loop to its end, and what the hooks queue during it; § 4 — starting the reviewer in a Herdr pane; § 9 — the skill's text"
issue: 338
recorded: 2026-10-05
versions: { claude-code: 2.1.289, coding-agent: claude-opus-5-5, reviewer: deepseek-v4-pro, pi: 0.85.1, herdr: 0.9.3, node: 24.15.0, squiz: "b30978d (runs 1 and 2), 6a5dabf (runs 3 and 4)" }
recheck-when: the skill's text or description changes, Herdr changes when `agent start` returns, or the round stops starting the reviewer through `herdr agent start`
---

# A subagent works a thread to exit 0 through the skill, and Herdr cannot start the reviewer

The skill is enough for the subagent. A `general-purpose` subagent was given a
brief that never named squiz. It opened a pull request, loaded
`squiz:squiz-review` on its own and ran `squiz review`, in all four runs. In run
4 the reviewer posted one thread on a planted off-by-one, and the command exited
2. The subagent fixed the code, added a test, pushed, replied with `squiz reply`
and ran the command again. Round 2 ruled the thread `fixed` and the command
exited 0. A reviewer in a Herdr pane never got that far. Before #447 Herdr refused
its prompt. Since #447 `herdr agent start` waits for the reviewer to finish, and
the round gives up after 15 seconds.

## Intent

- Whether a subagent dispatched with a brief that does not mention squiz loads
  the skill, runs `squiz review`, works the threads and ends on exit 0 or 3.
- Whether the `Stop` and `SubagentStop` hooks queue anything the command had not.
- Whether the pull request carries one set of threads per state.
- Whether the round's result wakes the dispatching session through its socket.
- Whether the reviewer runs in a Herdr pane, and its tab opens and closes.

## Decisions

- **Keep the § 9 skill text as it is.** Each subagent loaded the skill straight
  after `gh pr create`, without being told to, and did what it says for the exit
  it got. On exit 1 it reported the lines and stopped (runs 1 and 3). On exit 2
  it fixed the code, pushed, replied and ran the command again (run 4). On exit 0
  it stopped (runs 2 and 4). Each call was `squiz review <n>; echo "EXIT=$?"`
  with the 600000 timeout the skill names, and none was moved to the background.

- **Fix the Herdr start before a round is run inside Herdr.** `herdr agent start`
  returns only once the agent is ready for input. A `pi` started on its prompt is
  busy until the review is done, so the round's 15-second wait runs out first,
  and the pane is closed under a reviewer that was working. Run 3's reviewer had
  already reported the planted defect when it was closed. That finding was lost
  and the round failed. Filed as #449, P1.

- **Leave the hooks as they are.** No hook queued a state in any run. Each
  `SubagentStop` firing came after the subagent's own command had settled the
  state. The parent's `Stop` firing ran in a checkout whose branch has no pull
  request, and said so. Run 4's pull request carries the one thread round 1
  posted and one summary comment.

- **Do not count on the socket wake in this flow.** No owner was recorded on any
  state, so no note was written and nothing was posted to the parent's socket.
  § 3 sets this out for a subagent that runs `squiz review` itself: its command
  waits out each round inside its own turn, and the hook that would record the
  owner fires only after that turn ends.

## Needs your input

Nothing.

## Reference

### Per run

| | Run 1 | Run 2 | Run 3 | Run 4 |
|---|---|---|---|---|
| Test pull request | #441 | #444 | #448 | #451 |
| squiz | b30978d | b30978d | 6a5dabf | 6a5dabf |
| Herdr variables | kept | unset | kept | unset |
| Brief | a `paginate` function | the same | a given `pageCount` with `Math.floor`, and a test that covers only 10 items in pages of 5 | the same as run 3 |
| Round 1 | failed in 3 s: `invalid_agent_argument` | 0 findings | failed after 18 s: `herdr agent start: refused: timeout: timed out waiting for agent startup` | 1 finding, `high`, in 19 s |
| Round 2 | — | — | — | the reply ruled `fixed`, 0 new findings, in 27 s |
| Exits, in order | 1 | 0 | 1 | 2, 0 |
| Posted | failure comment | summary, `1 round, 0 findings` | failure comment | 1 thread, resolved; summary, `2 rounds, 1 finding`, `Fixed 1` |
| Spend recorded | — | $0.0335 | $0, though the reviewer made two model calls (#450) | $0.0102 and $0.0136 |

Run 4's thread, `PRRT_kwDOUEd2qM6o9q-F` on `scratch/e2e-338/pages.ts`, was
headed `pageCount floors instead of ceils, dropping items on a partial last
page`. The subagent appended a test for 11 items in pages of 5, saw it fail,
changed `Math.floor` to `Math.ceil`, committed and pushed. It then replied
`Fixed: pageCount now uses Math.ceil, and a new test covers 11 items in pages of
5 …` and ran `squiz review 451` in the same Bash call. Round 2 took the new head
together with that reply, `ec9712a with reply PRRC_kwDOUEd2qM75R9G-` in
`host.log`, and its only report was
`{"call":"report_verdict","value":{"thread":"PRRT_kwDOUEd2qM6o9q-F","verdict":"fixed"}}`.

Each round wrote `resume.txt` as
`pi --session-dir .squiz/451/rounds/1/session --session <id>`, and kept
`prompt.md` beside it.

### What Herdr does with `agent start`

In run 3, the tab `squiz-448-r1` opened at 08:48:10 and was gone at 08:48:24.
Probes in fresh tabs gave:

| `agent start` arguments | Returned after | `agent_status` |
|---|---|---|
| none | 3 s | `idle` |
| `--no-extensions` | 3 s | `idle` |
| `--no-extensions --no-session --tools read @<a prompt for a 400-word story>` | 13 s | `done` |
| an argument holding a newline or a tab, before #447 | at once | refused, `invalid_agent_argument` |

So the call returns when `pi` settles, not when it starts.

### The reviewer's environment

The round host is started from the subagent's Bash shell. In run 2 the reviewer
`pi` carried `CLAUDE_CODE_MESSAGING_TOKEN` from it, and that shell's socket and
token are the dispatching session's. At depth `deep` the reviewer's `bash` could
start a turn in the coding agent's session. Filed as #445.

### How the runs were set up

- `claude -p --plugin-dir /Users/jacy/Documents/Dev/squiz-plugin --permission-mode auto --input-format stream-json --output-format stream-json --verbose --debug-file <file>`,
  with every `CLAUDE*` variable unset, and every `HERDR*` one too in runs 2 and
  4. Stdin was a FIFO held open so that a wake could reach the session. No
  global setting was changed.
- The session started in a scratch worktree of this repository on a fresh
  branch. The prompt told it to dispatch one `general-purpose` subagent with
  `isolation: "worktree"` and a brief, word for word. The brief asked for code
  and a `node:test` test under `scratch/e2e-338/`, a commit, a push of a named
  branch, and a pull request titled `[e2e #338] …` that says it will be closed
  unmerged. It named neither squiz, review nor the skill. Runs 3 and 4 gave the
  first version of the code and its test verbatim, with the off-by-one in it.
- From run 2 on, the prompt told the parent not to file issues. Run 1's parent
  had filed #442 on its own under the dogfooding rule.

## Limits

- **No round ran in a pane.** Thread working was seen only with the reviewer
  detached. Nothing here shows a pane reviewer posting threads, its tab closing
  after a finished round, or a person reading `resume.txt` in it.
- **Exit 3 and a disputed or withdrawn thread were not reached.** The one thread
  was fixed as the reviewer suggested.
- **The socket wake was not exercised.** No round recorded a result for an owner
  a hook had recorded.
- **What the `SubagentStop` hook printed was not captured.** That it queued
  nothing is read from the state files.
- **The subagent's worktree was not cut from the scratch checkout.** Claude Code
  put it under the main checkout's `.claude/worktrees/` and based it on that
  checkout's `HEAD`, which was origin/main each time. The change under review was
  the one planned.
- **Four runs, one coding model, print mode only.** Opus 5.5 for the parent and
  the subagent, and `deepseek-v4-pro` for the reviewer. No interactive session.
