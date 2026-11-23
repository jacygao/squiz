---
settles: "§ 5 Tools: why every reviewer gets the same tools, none of which runs the project's code, and why the history tools are among them"
issue: 590
recorded: 2026-10-07
versions: { pi: 0.85.1, pi-model: deepseek/deepseek-v4-pro, copilot: 1.0.92, copilot-model: gpt-6-astra, thinking: medium, node: 24.15.0, qs: 07b1d4d8, node-semver: 6e05b763, marked: 7e8754d6 }
recheck-when: the reviewer's model or the charter changes, a case set of unfamiliar code with defects reading misses exists, or a tool that runs code is proposed
---

# Running the project's tests finds no more known defects than reading

## Intent

- Does a reviewer that can also run the project's tests, through a `run_tests`
  tool, find more of a change's known defects than one that only reads, with the
  same reviewer, model and charter?
- What does running them cost in false findings, time and money?
- Do the history tools contribute findings of their own?

## Decisions

- **Give every reviewer one set of tools, and none that runs the project's
  code.** With `run_tests`, reviewers found 107 of 138 chances at a known defect,
  and 103 without it, too small a difference to tell from run-to-run variation.
  Both found every defect the tests catch. The owner's bar was a measurable
  improvement, and running code also needs an operating-system sandbox first.
- **Expect running tests to cost a little more.** It took 5 to 22% more time and
  7 to 17% more money a run, and drew one false finding in 102 runs against
  none.
- **Keep the history tools in the one set.** Copilot found the one defect only the
  history explains through `git_log_search` in each of three runs that had the
  history tools, and in none of the three that did not.
- **Keep the rig in `eval/` and its cases in `eval/cases.ts` for the next
  measurement.** It takes a new case as a patch and a description.

## Needs your input

- **Whether to measure a tool that runs code again on a harder case set.**
  Every defect here was on, or one step from, a changed line in a widely used
  library, which a reader can check against what it already knows of that
  library. Recommended: measure again only on changes the reviewer has not seen
  in training, whose defects sit outside the diff, and only once the sandbox
  exists.

## Reference

The case set: 17 changes to qs, node-semver, marked and squiz itself, with 23
known defects. Ten are caught by the project's tests, twelve only by reading,
and one only by the history: qs's upstream commit `52afe00` says why the
replaced code counted commas before splitting. Three changes have no defect,
and neither reviewer reported anything on them.

## Limits

- **Reading found every defect a test catches, so this does not show that tests
  add nothing.** It bounds what running tests adds on such defects to about 5
  percentage points (no misses in 60 chances, the rule of three). It does not
  bound it on defects that are harder to read.
- **The libraries are well known.** qs, node-semver and marked are likely in
  both models' training. Squiz's own two changes are the only unfamiliar ones,
  and the reviewer found 8 and 5 of their 21 chances with tests against 6 and 6
  without.
- **Small numbers.** Three runs of each change for each reviewer and each set of
  tools. No difference here is significant.
- **The history defect was not planted.** It is one defect on one change.
- **Matching a finding to a defect is a judgement.** Every finding was read to
  check the match.
- **One model and one thinking level for each CLI.**
- **Squiz's own changes ran `npm run typecheck` as their test command**, not the
  whole suite.
