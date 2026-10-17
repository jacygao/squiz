---
settles: "§ 7 — what a round does when the machine is suspended during its review; § 8 — how to read a local test that ran for minutes"
issue: 680
recorded: 2026-10-17
versions: { node: 24.15.0, macos: 26.6.2 }
recheck-when: Node's major version changes, or a long test duration turns up while sessions on the machine kept writing
---

# A test's duration counts the time the machine was suspended

## Intent

- What the round test "a failed round posts one failure comment after what it
  salvaged, naming the reason" waited on for 900 seconds in a full local run.
- How to tell a test that hung from a machine that stopped running anything.

## Decisions

- **Check the session transcripts before reading a long local duration as a
  hang.** If no session on the machine wrote anything for the same span, the
  machine was suspended and the test was not running. Node counts suspended
  time in a test's duration on macOS, so the duration alone cannot tell the two
  apart.
- **Leave the posting reserve alone for a suspend.** A round that resumes past
  its posting reserve posts nothing and says so, as § 7 asks of a reserve that
  is spent. A suspend spends the reserve the way a slow reviewer does. The
  review's own time bound is the exception: a sleep during the review is added
  back to it, as § 7 The review budget sets out.
- **Leave the test as it is.** It failed because its clock moved 900 seconds
  while its reviewer ran, not because anything in the round waited.

## Needs your input

Nothing.

## Reference

### The run

The full `npm test` started at 09:00:01Z on 2026-10-07. Across every session
transcript of the project, the last write before the gap was at 09:01:32.356Z
and the next at 09:16:33.232Z: 900.9 seconds with nothing written, against the
test's 900.4. Claude Code reported the run's 600-second Bash timeout at
09:16:33, six and a half minutes late. A second gap followed: a command started
at 09:19:33 with a 120-second timeout was reported at 09:32:59, and nothing was
written in between.

This lists the writes per minute across every session of the project, so a gap
shows as missing minutes:

```sh
grep -rhoE '"timestamp":"2026-10-07T09:[0-9]{2}' ~/.claude/projects/*squiz* \
  | cut -d'"' -f4 | cut -c12-16 | sort | uniq -c
```

### Node's clock

`process.hrtime` follows `CLOCK_MONOTONIC_RAW`, which advances while the machine
sleeps, and not `CLOCK_UPTIME_RAW`, which does not. Read on 2026-10-17 on a
machine that had slept since boot:

| Clock | Seconds |
|---|---|
| `process.hrtime` | 4,355,855.36 |
| `CLOCK_MONOTONIC_RAW` | 4,355,855.34 |
| `CLOCK_UPTIME_RAW` | 1,308,632.65 |

`node --test` times each test with `process.hrtime`, and the round reads
`Date.now()`. Both jump forward across a suspend.

### The failure it produces

Moving the round's clock 900 seconds forward as the reviewer starts, with the
test's own fixture, reproduces the failure. The round makes only the `prlist`,
`threads` and `diff` calls. The finding and the failure comment both come back
as `the time left for GitHub ran out before this call was made`, so the test's
assertion on the calls fails.

## Limits

- **Whether the machine slept or froze is not known.** `pmset -g log` keeps only
  a few days: on 2026-10-17 it began on 2026-10-10. Either way, no process on
  the machine ran.
- **The 900 seconds matching the default time bound is a coincidence.** The test
  sets a bound of 1 second, and nothing else on its path has a bound of 900.
- **Seen once.** Hammering the test 24 times, 8 at once, and the whole file 8
  times, 4 at once, on a machine running other agents' suites, never took the
  test past 8 seconds.
