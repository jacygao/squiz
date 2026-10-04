---
settles: "§ 8 — whether a subagent handed a long exit-2 output works every thread; § 9 — whether the skill's text needs more to make it read the file; § 2 — when Claude Code cuts a command's output"
issue: 303
recorded: 2026-10-04
versions: { claude-code: 2.1.289, coding-agent: claude-opus-5-5 }
recheck-when: Claude Code changes how it cuts or persists a Bash call's output, the coding agent's model changes, or § 9's skill text changes
---

# A subagent reads the file whenever its output is cut

## Intent

- Whether a subagent given only the § 9 skill text works every thread when the
  exit-2 output it was shown is cut short.
- Whether it reads `review.txt`, runs `squiz threads`, or works only the threads
  it was shown.
- What change to the skill's text makes it read the file, if it does not.
- Whether the output a subagent is shown is cut at all, and where.

## Decisions

- **Ship the § 9 skill text as written.** Every subagent replied on all 12
  threads, in 9 runs out of 9. Each of the 6 subagents whose output was cut or
  persisted read `review.txt` with the Read tool straight after the cut result,
  and replied on the threads it had not been shown. No change to the text was
  needed, so none was tried.

- **Keep writing the whole output to `review.txt` and naming it on the first
  line.** It is what every cut subagent used. None ran `squiz threads`, and none
  opened the file Claude Code itself saved the output to.

- **Do not rely on the cut § 2 describes ever happening.** It applies only when
  the Bash call itself exits non-zero. Every subagent left to call the command
  its own way ran `squiz review 41; echo "EXIT=$?"`, 7 runs out of 7, so the call
  exited 0. A 16,544-character output then reached it whole, and a 32,230-character
  one was saved to a file and replaced by a 2 KB preview.

## Needs your input

- **Whether § 2's sentence on the cut gets corrected.** It says a failing
  command's output reaches the agent cut to about 10,000 characters, as a
  head-and-tail excerpt. Measured here:
  - the cut depends on the Bash call's exit status, not the command's, and an
    agent that appends `echo` turns it off;
  - a call that exits 0 with a long output gets the whole output saved to a file,
    and a preview with that file's path, instead;
  - a failing call's output over about 30,000 characters loses its real end as
    well as its middle, because it is first cut to 30,000 and only then
    excerpted.

  Recommended: correct § 2 to these three, and leave § 6's first line and
  `review.txt` as they are, since every case above is covered by them.

## Reference

### What the subagent was shown, by case

| Output | How the call was made | What reached the subagent |
|---|---|---|
| 16,544 characters, exit 2 | `squiz review 41; echo "EXIT=$?"` | All of it, 16,544 characters, no cut |
| 32,230 characters, exit 2 | `squiz review 41; echo "EXIT=$?"` | A `<persisted-output>` block: `Output too large (31.6KB). Full output saved to: <path>`, then `Preview (first 2KB):` |
| 16,544 characters, exit 2 | `squiz review 41` | `Exit code 2`, the first 5,000 characters or so, `... [6549 characters truncated] ...`, the last 5,000 or so: 10,039 characters in all |
| 36,000 characters, exit 2 | a plain call in a main session | The first 5,000 or so, `... [20012 characters truncated] ...`, then characters up to the 30,000th, not the last ones |

The last row was a probe in this session's own shell, not a subagent's.

### Thread ids only in the cut middle

In the 10,039-character result, 5 of the 12 ids did not appear at all:
`PRRT_kwDOL7tYbc5oF4cJ`, `PRRT_kwDOL7tYbc5oK7pZ`, `PRRT_kwDOL7tYbc5pA1sM`,
`PRRT_kwDOL7tYbc5pH6dQ` and `PRRT_kwDOL7tYbc5pQ2yV`. All three subagents that got
it replied on all five, each reply naming the specific fix, such as
`Fixed in 858c856: the header is now 'Bearer <token>', with no colon.` The ids
were random-looking rather than sequential, so none could be inferred from its
neighbours.

### Per run

Counts are distinct thread ids in the stand-in's log of `squiz reply` calls, not
the subagent's report.

| Run | Output | Call | Cut | Read `review.txt` | `squiz threads` | Threads replied on |
|---|---|---|---|---|---|---|
| r2 | 16,544 | wrapped | none | no | no | 12 of 12 |
| r3 | 16,544 | wrapped | none | no | no | 12 of 12 |
| r4 | 16,544 | wrapped | none | no | no | 12 of 12 |
| L1 | 32,230 | wrapped | persisted | yes | no | 12 of 12 |
| L2 | 32,230 | wrapped | persisted | yes | no | 12 of 12 |
| L3 | 32,230 | wrapped | persisted | yes | no | 12 of 12 |
| B1 | 16,544 | plain, as briefed | 6,549 cut | yes | no | 12 of 12 |
| B2 | 16,544 | plain, as briefed | 6,549 cut | yes | no | 12 of 12 |
| B3 | 16,544 | plain, as briefed | 6,549 cut | yes | no | 12 of 12 |

Every run loaded the skill through the Skill tool before running the command,
ran the command again after replying, and stopped on its exit 0. A first run,
r1, printed 8,108 characters and is left out of the table, since nothing was
cut; its call was wrapped too.

### How the runs were set up

- A nested `claude -p --permission-mode acceptEdits` session in a scratch git
  repository outside this one, with a local bare remote, dispatched one
  `general-purpose` subagent in the foreground. The squiz plugin was not loaded,
  and no global setting was changed.
- The skill was the § 9 text verbatim, as `.claude/skills/squiz-review/SKILL.md`
  in the scratch project, because that is how it reaches a coding agent once it
  ships. Every subagent loaded it by its description.
- The brief: `You are working in <repo>, on the branch feature/sync, which is pull
  request #41. It pushes to origin. Run squiz's review of pull request 41 and work
  what it finds. Report what you did when you are done.` The B runs added one
  sentence, the only way found to make the call exit 2:

  ```
  Run the review as a plain `squiz review 41` Bash call, with nothing before or after it on the command line.
  ```
- A stand-in `squiz` first on `PATH` printed the § 6 exit-2 output for 12
  threads on four seeded TypeScript files, each with a multi-line body, a code
  excerpt and a suggested fix, wrote the same text to `.squiz/41/review.txt`, and
  exited 2. Its second run printed the exit-0 output. It logged every call with
  its arguments. Reads of `review.txt` were taken from the subagent's tool calls
  in its transcript.

## Limits

- **Nine runs, one model.** Opus 5.5 for both the dispatching session and the
  subagent, in `-p` sessions. No interactive session and no other model was
  tried. Nine of nine is not a rate.
- **The plain call was briefed, not chosen.** No subagent left to itself ran the
  command without `echo` after it, so the 10,000-character cut was reached only
  by asking for a plain call. Whether a subagent that chose a plain call would
  act the same was not established.
- **Twelve threads, and the stand-in's findings were all correct.** No subagent
  had a finding to dispute, and no output carried more threads than these.
- **The 30,000-character figure is inferred.** The saved-to-a-file case was seen
  at 32,230 characters and not at 16,544; where between them it starts was not
  measured. The failing call over 30,000 was probed in a main session only.
- **The stand-in exits at once.** Nothing here covers a command moved to the
  background, whose output reaches the agent through a file of its own.
