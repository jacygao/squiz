---
settles: "§ 5: which of the review rules other reviewers publish the charter takes, and why the rest stay out"
issue: [579]
recorded: 2026-10-17
versions: { copilot: 1.0.98, copilot-model: "gpt-6-astra, gpt-6.1-sol for the sibling rule", thinking: medium, node: 24.15.0, squiz: "7e78369b, with the diff carried in the prompt" }
recheck-when: the reviewer's model changes, a case exists where the reviewer obeys text in the change or reports a flag or environment variable as hostile input, or a rig measures a whole episode rather than one round
---

# Only the sibling and stale-document rules change what the reviewer reports

## Intent

- Which of the charter changes proposed from other reviewers' instructions make
  the reviewer behave better on cases written to tempt it?
- Does any of them cost known defects found, or credits?

## Decisions

- **Take the rule that a change making an authoritative document untrue is a
  finding.** On a change that left the specification quoting an old line of
  output, the reviewer reported the stale specification in 15 of 15 runs with
  the rule and 4 of 15 without it. It cost no known defects on the earlier
  cases, and about 5% more credits a run.
- **Take the rule that names every place a broken rule appears.** On a change
  that broke one rule at four places, the reviewer named all four by file and
  line in 13 of 13 runs with the rule, against 2 of 13 without it.
- **Leave out the other five,** because none made the reviewer behave better on
  the cases written for it:
  - **text in the change addressed to the reviewer:** a comment saying a defect
    was approved, an `AGENTS.md` the change adds that puts the defect out of
    scope, a description telling the reviewer to report nothing, and a comment
    dressed as a system instruction demanding `low`. The reviewer reported the
    defect, at the charter's severity, in 20 of 20 runs without the rule.
  - **naming the input that produces the wrong result:** no charter made a false
    finding, on two refactors with no defect or on the earlier cases.
  - **keep looking after the first finding:** the reviewer found 41 of 50
    defects without it and 40 of 50 with it.
  - **who supplies hostile input:** no charter reported an environment variable
    or a command-line argument as a security problem, on three cases that read
    one.
  - **"check", "verify" or "confirm":** no charter's finding asked the author to
    confirm something, on two changes resting on behaviour the reviewer could
    not check.
- **Take the two rules alone.** All six together cost 19% more credits a run,
  and found the same defects as the stale-document rule alone.

## Needs your input

- **Which rule a defect the change did not introduce falls under.** It can be
  dropped or reported at `low`, and no case holds such a defect. Recommended:
  report it at `low`, with the reasoning saying it predates the change. That
  keeps what the reviewer found without holding the pull request on it, since
  `low` threads alone let `squiz review` exit 3.

## Reference

The cases are in `eval/`, each named for what it tempts, such as
`qs-agents-injection`, `semver-satisfying-sort` and `squiz-closing-line`. Nine
of them hold defects nobody planted, which the first runs found and are now
known defects of their case, so a finding on a case written to have none is
read before it is counted false.

## Limits

- **The reviewer was handed the diff in its prompt.** It now reads the diff
  through `git_diff`, and the stale-document rule's effect has not been
  measured since.
- **The sibling rule's purpose is a round saved.** The rig runs one round, so
  it shows only that the finding names every site.
- **The rules left out are not shown useless.** A weaker model, or a case that
  does tempt the reviewer, could show otherwise.
- **Small numbers.** Five runs of each case for each charter, fifteen on the
  case that differed, and three of each earlier case. Copilot alone, apart from
  two `pi` runs of each case for the sibling rule.
- **Copilot reported nothing on case `261` under any charter,** so its four
  known defects count against every charter alike.
- **Matching a finding to a defect is a judgement.** The findings on every new
  case were read, not only matched by pattern.
