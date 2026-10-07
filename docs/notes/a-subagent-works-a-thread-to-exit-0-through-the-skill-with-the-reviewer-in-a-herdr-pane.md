---
settles: "§ 3 — whether the skill is enough for a dispatched subagent to run the loop to its end, and what the hooks queue during it; § 4 — starting the reviewer in a Herdr pane; § 9 — the skill's text"
issue: 338
recorded: 2026-10-05
versions: { claude-code: 2.1.289, coding-agent: claude-opus-5-5, reviewer: deepseek-v4-pro, pi: 0.85.1, herdr: 0.9.3, node: 24.15.0, squiz: "b30978d (runs 1 and 2), 6a5dabf (runs 3 and 4), 68bea94 (run 5)" }
recheck-when: the skill's text or description changes, Herdr changes `pane run` or `agent start`, or the round changes how it starts a reviewer in a pane
---

# A subagent works a thread to exit 0 through the skill, with the reviewer in a Herdr pane

The skill is enough for the subagent. A `general-purpose` subagent was given a
brief that never named squiz. It opened a pull request, loaded
`squiz:squiz-review` on its own and ran `squiz review`, in all five runs. In run
5 the reviewer ran in a Herdr tab of the owner's workspace and posted one thread
on a planted off-by-one, and the command exited 2. The subagent fixed the code,
added a test, pushed, replied with `squiz reply` and ran the command again.
Round 2, in a second tab, ruled the thread `fixed`, and the command exited 0.
Each tab closed when its round ended. Neither run 1 nor run 3 completed a round
in Herdr. In run 1 Herdr refused to start the reviewer, fixed by #447. In run 3
the reviewer ran, found the planted defect and spent tokens, then was killed
when the start's wait ran out, so its finding was never posted; #452 fixed that.

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
  it fixed the code, pushed, replied and ran the command again (runs 4 and 5). On
  exit 0 it stopped (runs 2, 4 and 5). Each call was
  `squiz review <n>; echo "EXIT=$?"` with the 600000 timeout the skill names, and
  none was moved to the background.

  2026-10-07: the `squiz-review` skill and the `AGENTS.md` section `squiz init`
  wrote are removed (#600). The stop hook starts every review on Claude Code and
  Copilot, and the wake delivers the result, so nothing relies on an
  instruction to run `squiz review`.

- **Start the Herdr reviewer as 68bea94 does.** Starting it there with
  `herdr agent start` failed twice. Herdr refused a prompt holding a newline
  (#442, fixed by #447). Once the prompt was a file, `agent start` waited for
  `pi` to finish, and the round gave up after 15 seconds (#449, fixed by #452).
  With `herdr pane run` behind a gate, both of run 5's rounds ran in their tabs
  to `finish_review`.

- **Leave the hooks as they are.** No hook queued a state in any run. Each
  `SubagentStop` firing came after the subagent's own command had settled the
  state. The parent's `Stop` firing ran in a checkout whose branch has no pull
  request, and said so. Runs 4 and 5 each left one thread, posted by round 1, and
  one summary comment.

- **Do not count on the socket wake in this flow.** No owner was recorded on any
  state, so no note was written and nothing was posted to the parent's socket.
  § 3 sets this out for a subagent that runs `squiz review` itself: its command
  waits out each round inside its own turn, and the hook that would record the
  owner fires only after that turn ends.

## Needs your input

Nothing.

## Reference

### Run 5, in the owner's Herdr

Test pull request #454, squiz at 68bea94.

| | Round 1 | Round 2 |
|---|---|---|
| State | `6066e68` | `721c871 with reply PRRC_kwDOUEd2qM75Tiix` |
| Tab | `squiz-454-r1`, seen 09:44:27 to 09:44:41 | `squiz-454-r2`, seen 09:45:23 to 09:45:37 |
| Reviewer | `backend: herdr`, pane `w1:p7`, 15.4 s | `backend: herdr`, pane `w1:p8`, 14.4 s |
| Reported | one `high` finding on `scratch/e2e-338/pages.ts` | `report_verdict` `fixed` on `PRRT_kwDOUEd2qM6o-stv`, then `finish` |
| Exit | 2 | 0 |
| Spend | $0.0097 | $0.0097 |

The thread, `PRRT_kwDOUEd2qM6o-stv`, was headed `pageCount drops the final
partial page when the item count is not a multiple of the page size`. The
subagent's reply read `Fixed in 721c871: pageCount now uses Math.ceil, and a new
test covers 11 items in pages of 5 …`. The thread is resolved, and the summary
reads `2 rounds, 1 finding` and `Fixed 1 · Withdrawn 0 · Open 0 · Disputed 0`.

Each round wrote `resume.txt` as
`pi --session-dir .squiz/454/rounds/<k>/session --session <id>`, and kept
`prompt.md` beside it. Tab times are from a poll of `herdr tab list` every two
seconds.

### Every run

| | Run 1 | Run 2 | Run 3 | Run 4 | Run 5 |
|---|---|---|---|---|---|
| Test pull request | #441 | #444 | #448 | #451 | #454 |
| squiz | b30978d | b30978d | 6a5dabf | 6a5dabf | 68bea94 |
| Herdr variables | kept | unset | kept | unset | kept |
| Brief | a `paginate` function | the same | a given `pageCount` with `Math.floor`, and a test of 10 items in pages of 5 only | as run 3 | as run 3 |
| Exits, in order | 1 | 0 | 1 | 2, 0 | 2, 0 |
| Why it ended | `invalid_agent_argument` (#442) | 0 findings | `herdr agent start` timed out after 15 s with the reviewer working (#449) | thread ruled `fixed` | thread ruled `fixed` |
| Spend recorded | — | $0.0335 | $0, though the reviewer made two model calls (#450) | $0.0102, $0.0136 | $0.0097, $0.0097 |

### What `herdr agent start` waited for

This applies to squiz before 68bea94. Probes in fresh tabs gave:

| `agent start` arguments | Returned after | `agent_status` |
|---|---|---|
| none | 3 s | `idle` |
| `--no-extensions` | 3 s | `idle` |
| `--no-extensions --no-session --tools read @<a prompt for a 400-word story>` | 13 s | `done` |
| an argument holding a newline or a tab | at once | refused, `invalid_agent_argument` |

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
  unmerged. It named neither squiz, review nor the skill. Runs 3 to 5 gave the
  first version of the code and its test verbatim, with the off-by-one in it.
- From run 2 on, the prompt told the parent not to file issues. Run 1's parent
  had filed #442 on its own under the dogfooding rule.

## Limits

- **The pane reviews were short.** Run 5's rounds took 15.4 and 14.4 seconds, so
  a pane review of several minutes was not seen. Nobody typed into a tab, and
  nobody resumed a session from `resume.txt`.
- **Exit 3 and a disputed or withdrawn thread were not reached.** The one thread
  was fixed as the reviewer suggested, in both runs that had one.
- **The socket wake was not exercised.** No round recorded a result for an owner
  a hook had recorded.
- **What the `SubagentStop` hook printed was not captured.** That it queued
  nothing is read from the state files.
- **The subagent's worktree was not cut from the scratch checkout.** Claude Code
  put it under the main checkout's `.claude/worktrees/` and based it on that
  checkout's `HEAD`, which was origin/main each time. The change under review was
  the one planned.
- **Five runs, one coding model, print mode only.** Opus 5.5 for the parent and
  the subagent, and `deepseek-v4-pro` for the reviewer. No interactive session.
