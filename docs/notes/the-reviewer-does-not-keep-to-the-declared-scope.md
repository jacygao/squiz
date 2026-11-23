---
settles: "§ 5: whether the reviewer keeps to the scope a change's description declares"
issue: [105, 165]
recorded: 2026-09-26
versions: { pi: 0.85.1, provider: deepseek, model: deepseek-v4-pro, node: 24.15.0 }
recheck-when: the charter changes, or the reviewer's model changes
---

# The reviewer does not keep to the declared scope

## Intent

- Whether the reviewer honours the scope the change's description declares.

## Decisions

- **Do not rely on the reviewer honouring the declared scope.** Of nine findings
  over seven runs on one pull request, one was outside the scope its description
  declared: true on its own facts, and not a finding. Nothing in the round weighs
  a finding against the description, so a person dismisses such a comment.

## Needs your input

Nothing.

## Reference

The finding outside the scope was a `file` finding that the change's tests are
not discovered by the project's suite. The description declared its scope as
"The backoff arithmetic and the schedule. Nothing else in the repository is
touched".

## Limits

- **One pull request, one defect, one model.** Four of the seven runs were under
  an earlier contract, where the reviewer returned its findings as one last
  message. The three under the reporting calls stayed inside the scope.
- **The reviewer knew a defect was there.** The description said so.
