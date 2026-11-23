---
settles: "§ 5: whether a real reviewer reports through `report_finding` and `finish_review`; § 8: how a round that found nothing is told from one that reviewed nothing"
issue: [105, 165]
recorded: 2026-09-26
versions: { pi: 0.85.1, provider: deepseek, model: deepseek-v4-pro, node: 24.15.0 }
recheck-when: pi upgrades, the reviewer's model changes, or the charter or its reporting calls change
---

# The reviewer reports only through its calls

## Intent

- Whether a reviewer steered by the charter and the call descriptions reports
  through `report_finding`, rather than describing findings in prose nobody
  reads.
- Whether `finish_review` arrives, and where it falls among the reports.
- How a round that reported nothing is told from a round that reviewed nothing.

## Decisions

- **Read the reviewer's findings and finish from its calls alone, and read none
  of its prose.** In three rounds of three the reviewer called `report_finding`
  and then `finish_review`, the seeded defect was reported every time, and no
  assistant message carried a line of prose: each held thinking and tool calls
  only.
- **Tell an empty review from an absent one by the finish.** A round that
  reported nothing and recorded a finish found nothing. One with no finish
  stopped without finishing. The round reads that from the report file, which
  records reports, refusals, usage and the finish, and no read-tool call.
- **Look in the round's `pi` session for how widely a reviewer read.** The
  report file does not hold it. The session is under `rounds/<k>/session/`.

## Needs your input

Nothing.

## Reference

- `report_finding` and `finish_review` each arrived alone in their own assistant
  message, in every round, and `finish_review` came last.
- The rounds made 4, 43 and 24 calls of `read`, `ls`, `grep` and `find` before
  reporting.
- No reporting call was refused. The four refusals across the rounds were read
  tools: `ls` and `read` on `.git`, which is a file rather than a directory in a
  worktree, and `ls` on a path that did not exist.

## Limits

- **Three rounds, one defect, one small pull request, one model.** The diff was
  1,950 bytes. Three of three is not a rate.
- **No thread existed**, so `report_verdict` was not tried, nor the refusal of a
  second ruling on one thread.
- **`finish_review` never shared a message with a report.**
- **The reviewer knew a defect was there.** The pull request's description said
  it carried one, and two rounds grepped for what it was meant to be.
- **The history tools were not granted.** The rounds had the reading tools and
  the reporting calls alone.
