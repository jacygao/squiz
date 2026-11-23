---
settles: "§ 5: whether other code reviewers are precedent for granting the reviewer a shell or running the project's tests"
issue: [579]
recorded: 2026-10-06
versions: { pr-agent: 8175540f, claude-code: 8e60c4ca, claude-code-security-review: 0c6a49f1, claude-code-action: 86d88e61, codex: 822e58cc, no-mistakes: main, kodus-ai: main, run-gemini-cli: main }
recheck-when: a vendor publishes a measurement that separates running code from reading it, or Copilot, CodeRabbit or Claude Code Review documents what its reviewer runs
---

# No published measurement shows that running code improves a review

## Intent

- Whether the most used code reviewers give their model a shell or run the
  project's tests.
- Whether any of them publishes a measurement of what running code adds to a
  review.

## Decisions

- **Take no reviewer as precedent for running the project's code.** Squiz's
  tools are the common design: read and search tools, and no shell. Of the four
  reviewers documented to grant a shell, Codex confines it with Seatbelt or
  Landlock, CodeRabbit runs it in a microVM, Ellipsis in "isolated cloud
  sessions" of a kind it does not name, and no-mistakes leaves it unconfined.
  None documents running the project's tests by default. Kodus runs a type
  checker or linter, CodeRabbit runs third-party linters, and no-mistakes
  forbids tests in review. A level that runs code needs a case of its own, and
  `running-the-projects-tests-finds-no-more-known-defects-than-reading.md` records the one squiz
  measured.
- **Expect no outside evidence for it either.** OpenAI reports that repository
  access plus code execution makes a stronger reviewer than the diff alone, and
  does not separate the two. The only cross-vendor benchmark is Greptile's own,
  and whether Greptile runs code is not documented.

## Needs your input

Nothing.

## Reference

The claims a proposal would otherwise look up again:

| Who | Claim | Separates execution? |
|---|---|---|
| OpenAI | "providing repository access and code execution abilities to a GPT-5 model ... results in a stronger reviewer, catching more critical issues and raising fewer false alarms" | No |
| Codex launch post | The reviewer "runs your code and tests" (unverified) | No measurement |
| Anthropic | Pull requests with substantive review comments went from 16% to 54%, and under 1% of findings are marked incorrect | No |
| Greptile | Its own benchmark of 50 reintroduced bugs: Greptile 82%, Copilot 54%, CodeRabbit 44%, false positives not counted | No |
| no-mistakes | Schema conformance only: "not a finding-accuracy or recall evaluation" | No |

## Limits

- **The closed tools were read from their own documentation and blogs.** What
  Copilot, CodeRabbit, Greptile, Ellipsis and Sourcery grant their models was not
  observed.
- **OpenAI's figure was not seen,** only a summary of it, so whether it held the
  model fixed is unknown.
- **Codex's pages on sandboxing and cloud environments did not render.** What is
  said of its sandbox comes from search summaries.
- **Every measurement was run by its vendor,** and none publishes a
  false-positive rate that compares across tools.
- Graphite's reviewer was not covered.
