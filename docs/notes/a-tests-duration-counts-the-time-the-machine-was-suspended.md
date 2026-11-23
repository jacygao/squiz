---
settles: "§ 8 The review budget: what a round does when the machine is suspended during its review; § 9: how to read a local test that ran for minutes"
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
- What a round's bounds do with a suspend.

## Decisions

- **Check the session transcripts before reading a long local duration as a
  hang.** If no session on the machine wrote anything for the same span, the
  machine was suspended and the test was not running. Node counts suspended
  time in a test's duration on macOS, so the duration alone cannot tell the two
  apart. In this run nothing was written for 900.9 seconds, against the test's
  900.4.
- **Add a suspend back to the review's time bound alone.** Each call after the
  review has a deadline of its own, so a suspend costs at most the call it
  lands in.
- **Leave the test as it is.** It failed because its clock moved 900 seconds
  while its reviewer ran, not because anything in the round waited.

## Needs your input

Nothing.

## Reference

This counts the writes per minute across every session of the project, so a
suspend shows as missing minutes. Put the hour in question in the pattern:

```sh
grep -rhoE '"timestamp":"2026-10-07T09:[0-9]{2}' ~/.claude/projects/*squiz* \
  | cut -d'"' -f4 | cut -c12-16 | sort | uniq -c
```

`process.hrtime` follows `CLOCK_MONOTONIC_RAW`, which advances while the machine
sleeps, and not `CLOCK_UPTIME_RAW`, which does not. `node --test` times each
test with `process.hrtime`, and the round reads `Date.now()`, so both jump
forward across a suspend.

Moving the round's clock 900 seconds forward as the reviewer starts, with the
test's own fixture, reproduces the failure. The round makes only its pull request
listing, threads and diff calls to `gh`, and the finding and the failure comment both come
back as `the time left for GitHub ran out before this call was made`.

## Limits

- **Whether the machine slept or froze is not known.** `pmset -g log` keeps only
  a few days. Either way, no process on the machine ran.
- **The 900 seconds matching the default time bound is a coincidence.** The test
  sets a bound of 1 second, and nothing else on its path has a bound of 900.
- **Seen once.** Running the test 24 times, 8 at once, and the whole file 8
  times, 4 at once, beside other agents' suites, never took it past 8 seconds.
