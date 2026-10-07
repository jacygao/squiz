---
settles: "§ 4 — whether depth `deep` reviews measurably better than `read`, and so whether configuration accepts it"
issue: 590
recorded: 2026-10-07
versions: { pi: 0.85.1, pi-model: deepseek/deepseek-v4-pro, copilot: 1.0.92, copilot-model: gpt-6-astra, thinking: medium, node: 24.15.0, qs: 07b1d4d8, node-semver: 6e05b763, marked: 7e8754d6 }
recheck-when: the reviewer's model or the charter changes, a case set of unfamiliar code with defects reading misses exists, or `deep` gains a tool
---

# Deep finds no more of a change's known defects than read

## Intent

- Does a reviewer at `deep` find more of a change's known defects than one at
  `read`, with the same reviewer, model and charter?
- What does `deep` cost in false findings, time and money?
- Which `deep` tools does a reviewer call, and does a finding come from what
  they answered?

## Decisions

- **Do not accept `deep` in configuration on this evidence.** Over 17 changes,
  each reviewed three times at each depth by `pi` and by Copilot, `read` found
  103 of 138 chances at a known defect and `deep` found 107. Of the 60 chances at
  a defect the project's tests catch, each depth found all 60. The net four
  are Copilot finding a defect only the history explains in 3 runs of 3 at
  `deep` and none at `read`, less one reading defect, and `pi` finding two more
  on squiz's own notes. That is too small to tell from run-to-run variation.
  The owner's bar for #113 was a measurable improvement, and this is not one.
- **Expect `deep` to cost a little more and to cost nothing in false findings.**
  `deep` took 5 to 22% more time and 7 to 17% more money a run. Neither depth
  reported anything on the three changes with no defect, in 18 runs each. Across
  all 204 runs one finding was false, at `deep`.
- **Count the `deep` tools as working.** Every one of the 102 `deep` runs called
  `run_tests`, and every first call ended as the case says it should: a non-zero
  exit on the ten changes whose suite fails, zero on the rest. The tools were
  used as confirmation. 40 of the 111 findings at `deep` cite the test output,
  and each of them names a defect `read` also found.
- **Keep the rig and the cases for the next measurement.** On this set reading
  found every defect a test catches, so the set cannot show what running tests
  adds. A set that can is the next step, and the rig takes new cases as a patch
  and a description each.

## Needs your input

- **Whether #113 closes, or waits for a harder case set.** Recommended: leave
  `deep` refused, keep #113 open under a later milestone, and measure again on
  changes the reviewer has not seen in training, whose defects sit outside the
  diff. Every defect here was on, or one step from, a changed line in a widely
  used library, which a reader can check against what it already knows of that
  library.

## Reference

### Running it

```sh
export MEASURE_CACHE=/tmp/squiz-measure-cases   # where the upstream cases are cloned
node src/measure/review-once.ts prepare          # once, before runs go side by side
MEASURE_MODEL=deepseek/deepseek-v4-pro caffeinate -i \
  node src/measure/review-once.ts qs-comma-limit pi deep charter.md /tmp/runs/pi-deep-qs-comma-limit-1
node src/measure/table.ts /tmp/runs/*/
```

The case names are the keys of `cases` in `src/measure/cases.ts`. Each run makes
a snapshot with `addSnapshot`, as a round does, and hands the depth and the
case's test command straight to `runRound`, so `.squiz.json` and its refusal of
`deep` are not read. `granted.txt` in the run's directory holds the CLI's
arguments and `SQUIZ_ROUND`, which show whether the `deep` tools were granted
and handed a round.

### Traps

- **`pi --print` writes no event stream.** The rig puts a `pi` ahead of the real
  one on `PATH` that adds `--mode json` and copies stdout. Copilot's needs
  `--output-format json`, and it names a reporting-server tool `squiz-<name>`.
- **A reviewer reports the snapshot by its resolved path.** On macOS the
  temporary directory is reached through `/var`, and both CLIs report
  `/private/var/...`.
- **Prepare the cases before running them concurrently.** Two first
  preparations of one case race on its clone.
- **`git_log_search` reaches the upstream project's whole history.** The
  planted commit is authored `measure` on 2026-01-01, with the case name as its
  message, and the commits under it are the project's own.
- **`run_tests` shows the last 16,384 bytes.** qs's suite under `nyc` prints
  the instrumented source of `lib/parse.js` when it crashes, and the stack trace
  still fell inside what was shown.
- **Up to seven runs went at once, four of them `pi`,** with no refusal from
  either provider.

## Limits

- **Reading found every defect a test catches, so this does not show that tests
  add nothing.** Ten defects were planted for tests. Eight were refactors whose
  wrong input the description does not mention. Two were added after the first
  runs to be harder: one in what the lexer does with a changed rule, and one
  against CommonMark's nine-digit limit. Both were still found by reading.
- **The libraries are well known.** qs, node-semver and marked are likely in
  both models' training, so a reader can compare a change with the code it
  replaced from memory. Squiz's own two notes are the only unfamiliar changes,
  and `deep` found 8 and 5 of their 21 chances against `read`'s 6 and 6.
- **Small numbers.** 17 changes, 23 known defects, three runs of each change at
  each depth for each reviewer. No difference here is significant. Every one
  of the 60 test chances was found at each depth, which bounds what `deep` can
  add on such defects to about 5 percentage points (three misses in 60, the rule
  of three); it does not bound it on defects that are harder to read.
- **The history defect was not planted.** The first `deep` run on
  `qs-comma-limit` found it through `git_log_search`, and it was added to the
  case then. It is one defect on one change.
- **Matching a finding to a defect is a judgement.** Patterns over each
  finding's headline and reasoning made the match, and every finding was read
  to check it. Six findings that matched no known defect were judged real and
  one false.
- **One model and one thinking level for each CLI,** with the CLI's own default
  model passed explicitly.
- **Squiz's own changes ran `npm run typecheck` as their test command,** not the
  whole suite, because the suite's timing tests fail under the load of other
  agents on the machine. No test reads a note, so this affects only `20f8a1d`.
