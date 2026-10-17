---
settles: "§ 4 — the prompt lists the changed files and carries no diff, the reviewer reads each file's diff through git_diff, and the diff is read from the snapshot rather than downloaded"
issue: 715
recorded: 2026-10-17
versions: { copilot: 1.0.98, copilot-model: gpt-6.1-sol, pi: 0.85.1, pi-model: deepseek/deepseek-v4-pro, thinking: medium, node: 24.15.0, qs: 07b1d4d8, node-semver: 6e05b763, marked: 7e8754d6 }
recheck-when: the reviewer's model or the charter changes, or a case set of changes too large to paste is built
---

# A reviewer handed the changed files and `git_diff` finds what the pasted diff finds

## Intent

- Does a reviewer that reads the diff through `git_diff` find as many of a
  change's known defects as one handed the whole diff in its prompt?
- Does it matter whether the prompt also lists the changed files?
- What does reading on demand cost in tokens?

## Decisions

- **Stop pasting the diff, and list the changed files with `git_diff` granted.**
  Copilot found 55 of 69 chances at a known defect with the diff pasted, 55 with
  the list and the tool, and 56 with the tool alone. Every defect a test catches
  was found under all three prompts. A prompt that no longer grows with the
  change cannot be too large to start the reviewer, which is the failure that
  opened #715.
- **Keep the list rather than the tool alone.** The tool alone found one defect
  more and spent 8% more tokens a run against the list's 3%, which is too small a
  difference to choose on. The list is what a skipped file is counted against:
  with it, every one of the 74 runs that finished read every changed file's diff.
- **Read the diff from the snapshot.** `git diff <base>...HEAD` in the snapshot
  is the diff the anchor validator needs, and no size of change is one GitHub
  refuses.

## Needs your input

Nothing.

## Reference

### Each prompt, over 17 changes

| Reviewer, prompt | Runs reviewed | Defects the tests catch | Defects reading catches | Defect only the history explains | Findings matching no known defect | Tokens a run, mean | Tokens a run, median | Seconds, mean | Cost a run |
|---|---|---|---|---|---|---|---|---|---|
| Copilot, diff pasted | 51 of 51 | 30/30 | 22/36 | 3/3 | 0 | 110,852 | 102,163 | 34 | 6.6 credits |
| Copilot, list and `git_diff` | 51 of 51 | 30/30 | 22/36 | 3/3 | 0 | 114,161 | 103,497 | 33 | 6.7 credits |
| Copilot, `git_diff` alone | 51 of 51 | 30/30 | 23/36 | 3/3 | 0 | 119,290 | 112,369 | 34 | 6.8 credits |
| `pi`, diff pasted | 21 of 34 | 13/13 | 10/20 | 0/0 | 1 | 367,089 | 201,805 | 98 | $0.083 |
| `pi`, list and `git_diff` | 23 of 34 | 14/14 | 9/16 | 1/2 | 0 | 361,640 | 325,276 | 89 | $0.077 |
| `pi`, `git_diff` alone | 25 of 34 | 17/17 | 10/12 | 1/1 | 1 | 395,795 | 251,069 | 92 | $0.082 |

Copilot ran three runs of each change under each prompt, and `pi` two. A run
that did not review is left out of every column but the count.

### Copilot, each change

| Case | Known | diff: found | list: found | tool: found | diff: tokens, mean | list: tokens, mean | tool: tokens, mean |
|---|---|---|---|---|---|---|---|
| 261 | 4 | 0/12 | 0/12 | 0/12 | 176k | 209k | 190k |
| 286 | 3 | 7/9 | 7/9 | 8/9 | 176k | 150k | 143k |
| 20f8a1d | 0 | 0/0 | 0/0 | 0/0 | 68k | 80k | 86k |
| marked-rtrim | 1 | 3/3 | 3/3 | 3/3 | 78k | 87k | 88k |
| marked-escaped-pipe | 1 | 3/3 | 3/3 | 3/3 | 79k | 107k | 119k |
| marked-list-start | 1 | 3/3 | 3/3 | 3/3 | 112k | 98k | 114k |
| marked-heading-ids | 2 | 6/6 | 6/6 | 6/6 | 110k | 132k | 123k |
| marked-blank-line | 1 | 3/3 | 3/3 | 3/3 | 118k | 129k | 131k |
| marked-list-digits | 1 | 3/3 | 3/3 | 3/3 | 191k | 171k | 176k |
| qs-comma-empty | 1 | 3/3 | 3/3 | 3/3 | 92k | 92k | 104k |
| qs-comma-limit | 2 | 6/6 | 6/6 | 6/6 | 113k | 143k | 142k |
| qs-encode-chunk | 1 | 3/3 | 3/3 | 3/3 | 103k | 95k | 104k |
| qs-key-length | 2 | 6/6 | 6/6 | 6/6 | 119k | 106k | 119k |
| qs-limit-error | 0 | 0/0 | 0/0 | 0/0 | 92k | 78k | 117k |
| semver-inc | 2 | 6/6 | 6/6 | 6/6 | 113k | 124k | 110k |
| semver-min-version | 1 | 3/3 | 3/3 | 3/3 | 77k | 66k | 74k |
| semver-compare-pre | 0 | 0/0 | 0/0 | 0/0 | 66k | 75k | 88k |

### `pi`, each change

A dash is a change none of whose runs reviewed.

| Case | Known | diff: found | list: found | tool: found | diff: tokens, mean | list: tokens, mean | tool: tokens, mean |
|---|---|---|---|---|---|---|---|
| 261 | 4 | 2/8 | 1/4 | — | 800k | 934k | — |
| 286 | 3 | 2/6 | 2/6 | 4/6 | 394k | 368k | 852k |
| 20f8a1d | 0 | — | — | 0/0 | — | — | 203k |
| marked-rtrim | 1 | 1/1 | 2/2 | 2/2 | 125k | 103k | 59k |
| marked-escaped-pipe | 1 | 2/2 | 2/2 | 1/1 | 257k | 302k | 286k |
| marked-list-start | 1 | 1/1 | 1/1 | 2/2 | 104k | 194k | 172k |
| marked-heading-ids | 2 | 2/2 | 2/2 | 2/2 | 758k | 531k | 817k |
| marked-blank-line | 1 | 2/2 | 2/2 | 2/2 | 806k | 552k | 1364k |
| marked-list-digits | 1 | 2/2 | 1/1 | 2/2 | 482k | 1158k | 394k |
| qs-comma-empty | 1 | — | 1/1 | 2/2 | — | 221k | 247k |
| qs-comma-limit | 2 | — | 3/4 | 2/2 | — | 363k | 877k |
| qs-encode-chunk | 1 | 2/2 | 2/2 | 2/2 | 74k | 204k | 174k |
| qs-key-length | 2 | 2/2 | 4/4 | 2/2 | 152k | 280k | 296k |
| qs-limit-error | 0 | 0/0 | 0/0 | 0/0 | 189k | 325k | 77k |
| semver-inc | 2 | 4/4 | — | 4/4 | 129k | — | 171k |
| semver-min-version | 1 | 1/1 | 1/1 | 1/1 | 398k | 115k | 99k |
| semver-compare-pre | 0 | 0/0 | 0/0 | 0/0 | 98k | 247k | 185k |

### #714's head

One Copilot round on `668d38b` against its base `38296aa`, with the list and
`git_diff`, reviewed in 73 seconds. Its prompt was 1,172 bytes where the diff it
no longer carries is 484,550, and it read the diff of all 13 changed files.

### Running it

```sh
export MEASURE_CACHE=/tmp/squiz-measure-cases
node src/measure/review-once.ts prepare
caffeinate -i node src/measure/review-once.ts qs-comma-limit copilot charter.md /tmp/runs/copilot-list-qs-comma-limit-1
MEASURE_PROMPT=tool caffeinate -i node src/measure/review-once.ts qs-comma-limit copilot charter.md /tmp/runs/copilot-tool-qs-comma-limit-1
node src/measure/table.ts /tmp/runs/*/
```

The rig composes the prompt a round composes. `MEASURE_PROMPT=tool` takes the
list out and tells the reviewer to call `git_diff` with no path to list the
files. The pasted-diff column ran the rig from a checkout of `main` at
`7e78369`, which has no `git_diff`, so that reviewer was granted exactly what a
round granted then.

### Traps

- **Run the rig from a checkout nothing edits during the runs.** Each run
  starts `node` afresh and reads `src/` as it stands, so an edit made while runs
  are going measures two versions under one name.
- **A known defect can be reported on another file.** Copilot reported
  `marked-heading-ids`'s uniqueness defect on `src/Renderer.ts` rather than
  `src/MarkedOptions.ts`, and `qs-key-length`'s decoding defect on
  `lib/parse.js` rather than `README.md`, in every run. Both are counted as found.

## Limits

- **Small numbers.** 17 changes, 23 known defects. A difference of one defect
  between prompts is inside run-to-run variation.
- **Every change here is small enough to paste.** The prompt with the diff
  pasted was never large. What reading on demand does to a
  review of a change of hundreds of files is not measured, beyond the one round
  on #714's head.
- **`pi` is measured on 69 of 102 runs.** The DeepSeek account ran out of
  balance during the runs: 32 ended on `402 Insufficient Balance` and one on
  `429` for concurrency, unevenly across prompts. Its column supports the
  Copilot result and settles nothing alone.
- **Matching a finding to a defect is a judgement.** Patterns over each
  finding's file, line and headline made the match, and a sample of the
  matches was read to check it. The two that matched no known defect, both `pi`'s, were not
  checked against the code.
- **One model and one thinking level for each CLI.**
