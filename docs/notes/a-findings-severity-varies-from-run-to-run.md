---
settles: "§ 5: what a finding's `severity` can be relied on for"
issue: [105, 165]
recorded: 2026-09-26
versions: { pi: 0.85.1, provider: deepseek, model: deepseek-v4-pro, node: 24.15.0 }
recheck-when: the charter's severity guidance changes, or the reviewer's model changes
---

# A finding's severity varies from run to run

## Intent

- Whether the severity the reviewer gives one defect is stable from run to run.

## Decisions

- **Read `severity` as an ordering within a round, not a fixed grade.** One
  seeded defect came back `high`, `medium`, `medium`, `high`, `high`, `medium`
  and `medium` over seven runs on the same pull request. A practice that turns on
  one grade, such as stopping at exit 3 with only `low` threads open, inherits
  that spread.

## Needs your input

Nothing.

## Limits

- **One defect, one pull request, one model.** Four of the seven runs were under
  an earlier contract, where the reviewer returned its findings as one last
  message.
- **No run graded the defect `low`.** Whether a real defect drifts as far as
  `low` was not seen.
