---
settles: "§ 4 — which of the review rules other reviewers publish the charter takes, and why the rest stay out"
issue: [579]
recorded: 2026-10-17
versions: { pi: 0.85.1, pi-model: deepseek/deepseek-v4-pro, copilot: 1.0.98, copilot-model: gpt-6.1-sol, thinking: medium, node: 24.15.0, squiz: 7e78369b }
recheck-when: the reviewer's model changes, a case exists where the reviewer obeys text in the change or reports a flag or environment variable as hostile input, or a rig measures a whole episode rather than one round
---

# Only the sibling rule changes what the reviewer reports

Seven of the charter changes proposed from other reviewers' instructions were
measured with the rig in `src/measure/`, all at once and then the one that
showed an effect alone.

## Intent

- Which proposed charter changes make the reviewer report something it did not
  report before?
- Does any of them cost known defects found, false findings, time or money?

## Decisions

- **Take the rule that names every place a broken rule appears.** On a change
  that broke one rule at four places, Copilot named all four by file and line
  in 13 of 13 runs with the rule, against 2 of 13 without it. Without the rule
  it named the files and left out the lines, and in 3 runs it named only the
  file it anchored to and "the other two files".
- **Leave out the other six.** None changed what was found, and all seven
  together cost 15% more time and 24% more credits a Copilot run, and 30% more
  time and 33% more money a `pi` run:
  - **text in the change addressed to the reviewer:** a comment telling
    reviewers not to report the defect beneath it was ignored in every run of
    both reviewers, with the rule and without it;
  - **naming the input that produces the wrong result:** no run of either
    charter made a false finding on the 17 earlier cases, so there was nothing
    for the rule to remove;
  - **keep looking after the first finding:** the known defects found on the 17
    earlier cases were 54 of 69 for Copilot and 37 of 46 for `pi` under both
    charters, and the sibling rule alone found 53 of 69;
  - **a change that makes an authoritative document untrue:** the stale
    specification and README were reported in every run of both charters;
  - **who supplies hostile input:** no run of either charter reported a
    command-line pattern compiled as a regular expression as a security
    problem;
  - **"check", "verify" or "confirm":** no headline or suggested fix of either
    charter asked the author to.
- **Leave the pre-existing defect question to the owner.** The issue offers two
  rules for a defect the change did not introduce, dropping it or reporting it
  at `low`. That is a choice of policy, and no case holds such a defect.

## Needs your input

- **Which rule a defect the change did not introduce falls under.** Recommended:
  report it at `low`, with the reasoning saying it predates the change. That
  keeps what the reviewer found without holding the pull request on it, since
  `low` threads alone let `squiz review` exit 3.

## Reference

### Running it

```sh
export MEASURE_CACHE=/tmp/squiz-measure-cases
node src/measure/review-once.ts prepare
node src/measure/review-once.ts semver-optional-chaining copilot charter.md /tmp/runs/copilot-1
```

The four cases added for this are `qs-reviewer-note`, `semver-cli-match`,
`semver-optional-chaining` and `squiz-rounds-default`. The last is a patch on
this repository at a pinned commit, cloned from the checkout the rig runs in.

### Traps

- **A planted case holds defects nobody planted.** The first runs found a comma
  bypass in `qs-reviewer-note`, three defects in `semver-cli-match`, which was
  written to hold none, and a test in `squiz-rounds-default` that reads the
  default. Each is now a known defect of its case.
- **`pi` stops at setup when the provider account is empty.** The third run of
  every case, and two second runs, ended with `402 Insufficient Balance` and the
  outcome `setup`. Those runs are left out of every count.
- **A finding names a site in its own way.** "`ranges/subset.js:165,183`",
  "lines 165 and 183" and "both checks in `ranges/subset.js`" all occur, so a
  count of named sites needs reading, not only matching.

## Limits

- **The sibling rule was measured in one round.** Its purpose is a round saved
  when the coding agent fixes every site at once. A rig that runs one round
  cannot show that, only that the finding now names every site.
- **One case for each rule.** Each targeted rule was measured on the one case
  written for it, and a case on which the reviewer already behaves cannot show
  a rule helping. A stronger injection, or a change whose only defect is a
  stale document, could show what these did not.
- **Small numbers.** Three runs of each case for each charter, and thirteen on
  the two cases that showed a difference. `pi` ran two of the three.
- **Matching a finding to a defect is a judgement.** Patterns over each
  finding's text made the match, and the findings on the four new cases were
  read. One `pi` finding on `286` matched no known defect and was not judged.
