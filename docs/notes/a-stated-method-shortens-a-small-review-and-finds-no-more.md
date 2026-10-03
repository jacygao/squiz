---
settles: "§ 4 — the method the charter gives the reviewer"
issue: 281
recorded: 2026-10-03
versions: { pi: 0.85.1, model: deepseek-v4-pro, node: 24.15.0 }
recheck-when: the charter's method changes, the reviewer's model or thinking level changes, or pi upgrades
---

# A stated method shortens a small review and finds no more

## Intent

- Whether a charter that prescribes a review method finds the defects a change is
  known to hold at least as often as the charter before it, in fewer messages
  and less time.
- Whether two reviews of one change under one charter find the same things.

## Decisions

- **Keep the method in `charter.md`.** It found the known defects as often as
  the charter before it, 8 times in 18 chances against 8 in 18, and it took the
  one-line change from 24 messages to 17 and from a review that once hit the
  480-second bound to about 200 seconds. On the two larger changes it was no
  faster.
- **Measure a charter change with at least three runs per change.** Two reviews
  of one change under one charter do not find the same things. On #261 one run
  found three of its known defects and the next found one, and a run took from
  258 to 419 seconds.
- **Do not count on the rule for reading outside the diff to cut reading.** Under
  both charters, half to nearly all of the reviewer's reads, greps, finds and
  listings were outside the diff, on every change.

## Needs your input

- **Whether the method is enough for #281.** It met the bar on the number of
  defects found and on the small change, and missed it on time for the two
  larger ones. Recommended: merge it, and keep #281 open for an iteration that
  works on recall of the description's and the note's claims, which is where
  every miss was.

## Reference

The rig runs the real reviewer once, as the hook does: the `pi` adapter, depth
`read`, thinking `medium`, a 480-second bound, no threads. `src/measure/cases.ts`
holds the changes and the defects each is known to hold.

```sh
git show af6cebf:charter.md > /tmp/charter-before.md
caffeinate -i node src/measure/review-once.ts 261 /tmp/charter-before.md /tmp/runs/before-261-1
caffeinate -i node src/measure/review-once.ts 261 charter.md /tmp/runs/after-261-1
node src/measure/table.ts /tmp/runs/*/
```

The case is `261`, `286` or `20f8a1d`. Which known defect a finding reports is
judged by reading its headline.

- **Run under `caffeinate -i` on macOS.** Two runs that spanned an idle sleep
  took 1,117 seconds of wall clock against the 480-second bound, and were
  discarded.
- **Run no more than three at once.** At six, the provider refused with 429 for
  concurrency and 402 for balance, and four runs ended as `setup` partway through.

Each run cost $0.08 to $0.27. The results, as times found over runs, with the
mean messages and seconds:

| Change | Known defect | Before | After |
|---|---|---|---|
| #261, base `3ada723`, head `9276dea` | `sleep 900` against the quoted `120` | 3 of 3 | 5 of 6 |
| | An empty group is neither signalled nor refused | 1 of 3 | 1 of 6 |
| | The age test without its 2 seconds of slack | 0 of 3 | 1 of 6 |
| | A round without the holder signals a user's process | 1 of 3 | 1 of 6 |
| | Messages, seconds | 19, 292 | 22, 324 |
| #286, base `45dc53b`, head `78c86a7` | Restart after every merge, against § 8 | 3 of 3 | 3 of 3 |
| | `plugin.json` for `.claude-plugin/plugin.json` | 0 of 3 | 0 of 3 |
| | The measurement table belongs in the pull request | 1 of 3 | 2 of 3 |
| | Messages, seconds | 17, 175 | 15, 229 |
| `20f8a1d`, one line, no defect known | None reported by any run | | |
| | Messages, seconds | 24, 310 | 17, 207 |

The 8 in 18 counts the first three runs after, on the three named defects of
each change. #261's three runs more, the consistency set, found `sleep 900` in
all three, the empty group in one, and nothing else.

## Limits

- No change in the set had threads, so ruling on threads first was not measured.
- No change in the set was large. The size tiers were not exercised beyond small
  and medium.
- One model and one thinking level were measured.
- A second iteration, which had the reviewer write its claims out and forbade
  listing a directory, ran three times on #261 only. It found `sleep 900` twice
  and nothing else, in 17 messages and 248 seconds. In one run it named the empty
  group's defect and then argued it away as imprecision.
