---
settles: "§ 4 — why every reviewer gets one level, with no level that runs the project's code, and why the history tools are in that level"
issue: 590
recorded: 2026-10-07
versions: { pi: 0.85.1, pi-model: deepseek/deepseek-v4-pro, copilot: 1.0.92, copilot-model: gpt-6-astra, thinking: medium, node: 24.15.0, qs: 07b1d4d8, node-semver: 6e05b763, marked: 7e8754d6 }
recheck-when: the reviewer's model or the charter changes, a case set of unfamiliar code with defects reading misses exists, or a level that runs code is proposed
---

# Deep finds no more of a change's known defects than read

`deep` was a review level that also ran the project's tests through
`run_tests`, and granted the history tools, which `read` did not. M11 replaced
both with one level on this measurement.

## Intent

- Does a reviewer at `deep` find more of a change's known defects than one at
  `read`, with the same reviewer, model and charter?
- What does `deep` cost in false findings, time and money?
- Which `deep` tools does a reviewer call, and does a finding come from what
  they answered?

## Decisions

- **Give every reviewer one level, and none that runs the project's code.**
  `deep` found 107 of 138 chances at a known defect against `read`'s 103, and
  every defect the tests catch at both depths, which is too small a difference
  to tell from run-to-run variation. The owner's bar was a measurable
  improvement, and running code also needs the operating-system sandbox first.
- **Expect `deep` to cost a little more and nothing in false findings.** It took
  5 to 22% more time and 7 to 17% more money a run, and one false finding in 102
  runs against none.
- **Keep the history tools in the one level.** One defect was found from a
  tool's answer and not by reading: the history defect, which Copilot found
  through `git_log_search` at `deep` and never at `read`. Every `deep` run also
  called `run_tests`, so the tools worked and the null result is not a run that
  went without them.
- **Keep the rig and the cases for the next measurement.** Reading found every
  defect a test catches, so this set cannot show what running tests adds. The
  rig takes a new case as a patch and a description.

## Needs your input

- **Whether to measure again on a harder case set.** Every defect here was on,
  or one step from, a changed line in a widely used library, which a reader can
  check against what it already knows of that library. Recommended: measure a
  level that runs code again only on changes the reviewer has not seen in
  training, whose defects sit outside the diff, and only once the sandbox
  exists.

  2026-10-07: M11 closed #113 and removed `deep`. The sandbox is held as #529.

## Reference

### Each depth, over 17 changes, three runs each

| | `pi` `read` | `pi` `deep` | Copilot `read` | Copilot `deep` |
|---|---|---|---|---|
| Defects the tests catch (10) | 30/30 | 30/30 | 30/30 | 30/30 |
| Defects reading catches (12) | 21/36 | 23/36 | 21/36 | 20/36 |
| Defect only the history explains (1) | 1/3 | 1/3 | 0/3 | 3/3 |
| False findings | 0 | 1 | 0 | 0 |
| Seconds, mean | 110 | 116 | 32 | 39 |
| Cost a run | $0.086 | $0.092 | 33.9 credits | 39.7 credits |

`pi` ran `deepseek/deepseek-v4-pro` and Copilot `gpt-6-astra`, both at thinking
`medium` with the 900-second bound. Neither depth reported anything on the three
changes with no defect. At `deep`, 40 of 111 findings cite the test output, each
about a defect `read` also found. The history defect is in upstream commit
`52afe00`, which says why the replaced code counted commas before splitting.

### Running it

```sh
export MEASURE_CACHE=/tmp/squiz-measure-cases   # where the upstream cases are cloned
node src/measure/review-once.ts prepare          # once, before runs go side by side
MEASURE_MODEL=deepseek/deepseek-v4-pro caffeinate -i \
  node src/measure/review-once.ts qs-comma-limit pi charter.md /tmp/runs/pi-qs-comma-limit-1
node src/measure/table.ts /tmp/runs/*/
```

The rig no longer takes a depth. It runs the one grant every review has, the
reading tools, the reporting calls and the history tools, so the two columns
above cannot be re-run as they were.

The case names are the keys of `cases` in `src/measure/cases.ts`. Each run makes
a snapshot with `addSnapshot`, as a round does, and hands the model straight to
`runRound`, so `.squiz.json` is not read. `granted.txt` in the run's directory
holds the CLI's arguments, which show the grant.

### Traps

- **`pi --print` writes no event stream.** The rig puts a `pi` ahead of the real
  one on `PATH` that adds `--mode json` and copies stdout. Copilot's needs
  `--output-format json`, and it names a reporting-server tool `squiz-<name>`.
- **The wrapper must leave every other call alone.** `pi`'s adapter runs
  `pi --list-models` to check a configured model, and with `--mode json` added
  the check refuses a model `pi` offers. The wrapper adds its flags only to the
  call carrying `--print` for `pi` or `-p` for Copilot.
- **`MEASURE_MODEL` is the `model` setting, handed over directly.** It goes to
  the adapter as `model` does from `.squiz.json`, in the CLI's own spelling:
  `provider/id` for `pi`. The rig reads no `.squiz.json`.
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
