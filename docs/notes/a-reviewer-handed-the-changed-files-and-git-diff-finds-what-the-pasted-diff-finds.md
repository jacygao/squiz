---
settles: "§ 5: whether the prompt carries the diff or lists the changed files for `git_diff`, and where the diff is read from"
issue: 715
recorded: 2026-10-17
versions: { copilot: 1.0.98, copilot-model: gpt-6.1-sol, pi: 0.85.1, pi-model: deepseek/deepseek-v4-pro, thinking: medium, node: 24.15.0 }
recheck-when: the reviewer's model or the charter changes, or a case set of changes too large to paste is built
---

# A reviewer handed the changed files and `git_diff` finds what the pasted diff finds

## Intent

- Whether a reviewer that reads the diff through `git_diff` finds as many of a
  change's known defects as one handed the whole diff in its prompt.
- Whether it matters that the prompt also lists the changed files.
- What reading on demand costs in tokens.

## Decisions

- **Put no diff in the prompt, list the changed files, and grant `git_diff`.**
  Copilot found 55 of 69 chances at a known defect with the diff pasted, 55 with
  the list and the tool, and 56 with the tool alone. Every defect a test catches
  was found under all three prompts. A prompt that does not grow with the change
  cannot be too large to start the reviewer. On one head whose diff was 484,550
  bytes, the prompt was 1,172, and the reviewer read the diff of all 13 changed
  files.
- **Keep the list rather than the tool alone.** The difference of one defect is
  inside run-to-run variation, and the tool alone spent 8% more tokens a run
  than the pasted diff, against the list's 3%. The list is what a skipped file
  is counted against: with it, every one of the 74 runs that finished read every
  changed file's diff.
- **Read the diff from the snapshot with `git diff <base>...HEAD`.** It is the
  diff the anchor validator needs, and no size of change is one GitHub refuses.

## Needs your input

Nothing.

## Limits

- **Small numbers.** 17 changes, 23 known defects, three runs a prompt for
  Copilot and two for `pi`.
- **Every change measured was small enough to paste.** What reading on demand
  does to a review of hundreds of files is not measured, beyond the one large
  head.
- **`pi` was measured on 69 of 102 runs**, after its provider account ran out of
  balance, unevenly across prompts. Its result agrees with Copilot's and settles
  nothing alone.
- **Matching a finding to a defect is a judgement**, made by patterns over each
  finding's file, line and headline, with a sample read to check it.
- **One model and one thinking level for each CLI.**
