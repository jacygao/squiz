---
settles: "§ 7: whether a subagent handed a long exit-2 output works every thread, and what makes it read the whole of it"
issue: 303
recorded: 2026-10-04
versions: { claude-code: 2.1.289, coding-agent: claude-opus-5-5 }
recheck-when: Claude Code changes how it cuts or persists a Bash call's output, the coding agent's model changes, or `squiz review`'s first line changes
---

# A subagent reads the file whenever its output is cut

## Intent

- Whether a subagent works every thread when the exit-2 output it was shown is
  cut short.
- Whether it reads `review.txt`, runs `squiz threads`, or works only the threads
  it was shown.
- What has to change to make it read the file, if it does not.
- Whether the output a subagent is shown is cut at all, and where.

## Decisions

- **Expect a subagent to work every thread, cut or not.** Each subagent whose
  output was cut or persisted read `review.txt` with the Read tool straight
  after the cut result, and replied on the threads it had not been shown,
  including the ids that appeared nowhere in what it saw. Those subagents had a
  skill, since removed, that named the file. `squiz review`'s first line now
  names it instead.
- **Keep writing the whole output to `review.txt` and naming it on the first
  line.** It is what every cut subagent used. None ran `squiz threads`, and none
  opened the file Claude Code itself saved the output to.
- **Do not count on Claude Code's head-and-tail cut ever happening.** It applies
  only when the Bash call itself exits non-zero, and every subagent left to call
  the command its own way ran `squiz review 41; echo "EXIT=$?"`, which exits 0.
  A long output then reaches it whole, or saved to a file behind a preview.

## Needs your input

Nothing.

## Reference

The first line `squiz review` prints, for exits 0, 2, 3 and 4:

```
Full output, to read where this is cut short: /work/squiz/.squiz/41/review.txt
```

What Claude Code 2.1.289 shows an agent of a long Bash output:

| The Bash call | Output | What reaches the agent |
|---|---|---|
| Exits 0, as with `; echo "EXIT=$?"` after it | 16,544 characters | All of it |
| Exits 0 | 32,230 characters | `Output too large (31.6KB). Full output saved to: <path>`, then `Preview (first 2KB):` and the first 2 KB, in a `<persisted-output>` block |
| Exits non-zero | 16,544 characters | `Exit code 2`, about the first 5,000 characters, `... [6549 characters truncated] ...`, about the last 5,000 |
| Exits non-zero | 36,000 characters | About the first 5,000, `... [20012 characters truncated] ...`, then characters up to the 30,000th: the real end is lost too |

## Limits

- **Nine runs, one model.** Opus 5.5 for both the dispatching session and the
  subagent, in `-p` sessions. No interactive session and no other model was
  tried. Nine of nine is not a rate.
- **Every subagent had the skill.** Whether `squiz review`'s first line alone
  sends a cut subagent to the file was not run.
- **The plain call was briefed, not chosen.** No subagent left to itself ran the
  command without `echo` after it, so the head-and-tail cut was reached only by
  asking for a plain call.
- **Twelve threads, all of them correct findings.** No subagent had a finding
  to dispute, and no output carried more threads than these.
- **Where the persisted case starts is inferred.** It was seen at 32,230
  characters and not at 16,544. The failing call over 30,000 was probed in a
  main session only.
- **A command moved to the background** reaches the agent through a file of its
  own, and was not covered.
