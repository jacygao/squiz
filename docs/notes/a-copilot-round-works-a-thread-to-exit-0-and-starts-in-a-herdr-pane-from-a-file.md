---
settles: "§ 4 — whether the Copilot adapter reviews a real pull request as it specifies when detached, whether a Copilot round starts and closes in a Herdr pane, and whether the charter governs the user's default model; § 5 — the summary's cost line for a Copilot review"
issue: [465, 516]
recorded: 2026-10-06
versions: { claude-code: 2.1.290, coding-agent: claude-opus-5-5, copilot: 1.0.92, reviewer: gpt-6-astra, herdr: 0.9.3, node: 24.15.0, squiz: "9dccf87, and the #516 fix" }
recheck-when: Copilot changes `--agent`, `--usage-output-file` or its usage file, the Herdr start changes how it hands a pane its line, or the charter or the Copilot adapter's command line changes
---

# A Copilot round works a thread to exit 0, and starts in a Herdr pane once its line runs from a file

Copilot reviewed a real pull request as § 4 sets out, once it ran detached. Test
pull request #515 carried a planted off-by-one, a `pageCount` using
`Math.floor`, and a test that only divided evenly. Round 1 posted one `high`
thread on it, and the command exited 2. The fix was pushed with tests, a reply
was posted with `squiz reply`, and round 2 ruled the thread `fixed`. The command
exited 0. The first attempt at round 1 ran in the owner's Herdr workspace and
never started: the round typed a 1.7 KB line into a fresh pane, and macOS cut it
at 1024 bytes. That is #516. Nothing ran and no quota was spent. Once a long
line ran from a file instead, a round on #518 started in a Herdr pane, and the
pane closed when the review ended.

## Intent

- Whether a project with `"reviewer": "copilot"` gets a round on a real pull
  request, with a finding posted as a thread.
- Whether the coding agent works that finding through `squiz review` to exit 0
  or 3.
- Whether the summary carries the round's cost as § 4 and § 5 set out for
  Copilot.
- Whether the reviewer keeps to the charter's reporting contract when the charter
  arrives as a custom agent's instructions, on the user's own default model.
- Where the reviewer runs, and whether its pane closes.

## Decisions

- **Keep the Copilot adapter's command line, grant, reporting server and read as
  § 4 sets them out.** Both detached rounds ran the line as specified, appended
  the usage line once Copilot exited 0, and were read back as reviewed. The
  resume line was written in the specified form.

- **Never type a pane line over 512 bytes.** The start types its gated line as
  soon as the pane's shell holds the foreground. The shell's line editor has not
  started yet, so the terminal is in canonical mode, and macOS keeps 1024 bytes
  of an unfinished line. Copilot's line is cut inside a quoted word, the shell
  waits for the quote to close, and the gate never writes its pid. The gate
  held, so the cut line ran nothing. Since #516, a longer line is written to a
  file in the gate directory and the line typed runs it. `pi`'s line from a
  coding agent's worktree is about 935 bytes, under the cut but not by much, so
  it runs from the file too.

- **Read a Copilot round's cost as § 4 does.** Round 1's 38,236 tokens are
  `inputTokens` 37,717 and `outputTokens` 519 from `modelMetrics`, and its 15.69
  AI credits are `totalNanoAiu` 15,687,150,000 over 10⁹. The summary carried
  both, with no dollar figure.

- **Keep the charter as Copilot's agent instructions.** On `gpt-6-astra`, the
  user's default model, the reviewer wrote no prose in either round. It read
  `AGENTS.md`, reported through `squiz-report_finding` or `squiz-report_verdict`,
  then called `squiz-finish_review`, and its last message was empty.

## Needs your input

Nothing.

## Reference

### The run

Test pull request #515, squiz at 9dccf87. The project's `.squiz.json` was
`{"reviewer": "copilot"}`, left uncommitted in the checkout, because the round
host reads it from the worktree.

| | Round 1, first attempt | Round 1 | Round 2 |
|---|---|---|---|
| State | `81d2878` | `81d2878` | `a1ec885 with reply PRRC_kwDOUEd2qM75ycD-` |
| Reviewer | Herdr tab `squiz-515-r1`, never started; the round closed it | `backend: detached` | `backend: detached` |
| Reported | nothing | one `high` finding on `scratch/live-465/pages.ts:4` | `report_verdict` `fixed` on `PRRT_kwDOUEd2qM6pSg5T`, then `finish` |
| Exit | 1 | 2 | 0 |
| Took | 36 s | 21.3 s, and 1.7 s posting | 16.6 s, and 1.5 s posting |
| Tokens | — | 38,236 | 40,002 |
| AI credits | — | 15.69 | 12.88 |
| Messages | — | 5 | 5 |

The first attempt printed:

```
squiz: review failed: the reviewer could not run: the reviewer could not be started: the command did not start in the pane within 15000ms
squiz: the failure is posted on PR #515
```

The detached rounds ran from the same shell with every `HERDR_*` and `TMUX*`
variable unset.

The thread was headed `pageCount drops the partially filled last page`, and
suggested `Math.ceil` with tests for a partial last page and a list shorter than
a page. The reply read `Fixed in a1ec885: pageCount now uses Math.ceil, and new
tests cover 11 items in pages of 5, 1 item in pages of 5, and no items.` The
thread is resolved. The summary read:

```
**Squiz review — 2 rounds, 1 finding**

Fixed 1 · Withdrawn 0 · Open 0 · Disputed 0
78,238 tokens over 2 rounds: 38,236, 40,002 · 28.57 AI credits
```

The failure comment from the first attempt stays on the pull request beside the
summary, as § 7 says it does.

Each round wrote `resume.txt`, for round 1 as
`COPILOT_HOME=.squiz/515/rounds/1/session copilot --resume=1ee7acf1-7a58-4ea4-a8f7-6df164adeb76`.

### What the reviewer did

From `session-state/<id>/events.jsonl`, each round's turns were the same shape:

1. `glob` for `**/AGENTS.md`, and `view` on the changed files and `package.json`.
2. `view` on `AGENTS.md`, and a search shown to the model as `rg`.
3. The report: `squiz-report_finding` in round 1, `squiz-report_verdict` in round 2.
4. `squiz-finish_review`.
5. An empty message, after which Copilot exited.

Every `view` named a path under the round's snapshot, then made at
`.squiz/515/rounds/<k>/tree/` and now in the temporary directory.

### The round in a pane, after #516

Test pull request #518, a throwaway draft with the same planted `Math.floor`,
run from the owner's Herdr workspace with `COPILOT_MODEL=gpt-5-mini` exported in
the shell that ran `squiz review`.

| | Round 1 |
|---|---|
| Reviewer | Herdr tab `squiz-518-r1`; `squiz status` named `herdr squiz-518-r1` |
| Reported | one `high` finding on `scratch/live-516/pages.ts:3` |
| Exit | 2 |
| Took | 28 s from the round's start |
| Model | `gpt-5-mini`, from `modelMetrics` |
| AI credits | 0.47, `totalNanoAiu` 466,055,000 |

The tab was gone from `herdr tab list` once the command returned. `resume.txt`
read `COPILOT_HOME=.squiz/518/rounds/1/session copilot --resume=eea6adca-d9ba-4f85-9594-11c990593393`.
The gate directory was left holding only `pid`: the file the line ran from had
removed itself, and the leftover `pid` is #453.

`herdr tab create --env COPILOT_ALLOW_ALL=` gives the pane's shell the variable
set and empty: `${COPILOT_ALLOW_ALL+set}` printed `set`, and the value printed
nothing.

### The pane line, by length

A line typed with `herdr pane run` into a tab made the moment before:

| Line | Ran |
|---|---|
| 456 bytes: the gate and `sh -c 'echo REACHED'` | yes, pid in 270 ms |
| 847 and 1007 bytes | yes |
| 1047 and 1247 bytes | no, nothing in 20 s |
| Copilot's line for this round, 1.7 KB | no; the screen shows it cut near byte 1024 |
| the same 1.7 KB line, typed into a pane open for some seconds | yes |

### Two earlier unknowns this run settled

The charter governed a model other than `gpt-5-mini`, and Copilot ran detached
with `/dev/null` as standard input.

### What Copilot wrote into `COPILOT_HOME`

Besides the agent file `confine` writes, the round's session directory held
`config.json`, holding only `firstLaunchAt`, with `session-store.db`,
`installed-plugins/`, `logs/`, `session-state/` and `usage.json`.

## Limits

- **The pane round was not watched.** The pane had closed before it was read,
  so the `Resume` line Copilot prints on exit was not seen there.
- **The empty `COPILOT_ALLOW_ALL` was seen in a pane, not in the reviewer.** It
  was read from a shell in a tab created with the same `--env`, after the round.
  The reviewer's own environment was not read.
- **One pane round, on `gpt-5-mini`.** The pane round was not taken to exit 0.
- **Herdr stalled once and it is not known why.** During the failed attempt,
  a `herdr tab list` polled every two seconds took from 12:46:13 to 12:46:42 to
  answer. The typed line cannot account for it: in the reproductions, Herdr
  answered at once with a cut line in the pane.
- **Exit 3, and a disputed or withdrawn thread, were not reached.** The one
  thread was fixed as suggested.
- **Two models.** The detached rounds ran `gpt-6-astra`, the owner's default,
  and the pane round `gpt-5-mini`. No round ran with `COPILOT_MODEL` unset.
- **Nobody resumed a session** from `resume.txt`.
- **The coding agent was the dispatching session's subagent**, running the
  commands itself, not one dispatched with a brief that never named squiz. The
  hooks and the socket wake were not part of the run.
- **The planted defect was the one `pi` found in M7.** A defect that takes
  reading across files was not tried.
