---
settles: "§ 7 — how long a round's posting reserve is"
issue: 278
recorded: 2026-10-03
versions: {}
recheck-when: a round records a postingSeconds near 60, or posting gains calls per finding
---

# Sixty seconds of posting is several times what rounds have needed

## Intent

- How long a round needs to post its findings, its verdicts, the summary and the
  failure comment, so the posting reserve can be sized.

## Decisions

- **Reserve 60 seconds for posting.** The busiest round seen posted its findings
  within about 25 seconds, and a typical one within 4, so 60 leaves room for a
  slow GitHub without taking time from the review.
- **Record each round's `postingSeconds`.** A reserve that has grown tight then
  shows in the state files before it shows as lost findings.

## Needs your input

Nothing.

## Reference

| Round | Posted | Took |
|---|---|---|
| Pull request #275's round | Three findings | Within 4 seconds |
| Pull request #261's busiest round | Its findings | Within about 25 seconds |

## Limits

- Two pull requests' rounds, on one machine and one connection. The versions of
  `gh` and Node they ran under were not recorded.
- Neither figure separates the findings from the verdicts and the summary.
