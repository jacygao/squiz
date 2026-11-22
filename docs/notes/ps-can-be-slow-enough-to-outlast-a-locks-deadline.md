---
settles: "§ 3 — why a state-file lock taken after its writer's deadline passed is still used; § 7 — how long `squiz review` and `squiz status` wait for `ps` to say whether a round host still runs"
recorded: 2026-11-22
versions: { squiz: 94545aa, platform: macOS }
recheck-when: squiz stops using `ps` to tell a holder running from gone, or runs on Linux
---

# `ps` can be slow enough to outlast a lock's deadline

On a loaded machine one `ps` can take longer than a whole wait on the state
file's lock. A 50 ms wait on a live holder once ran to 777 ms, because each
process check was then given at least 2 seconds.

## Intent

- Whether a writer's deadline on the state lock can pass while the lock is
  being taken.
- How long to let `ps` take before a holder counts as one that cannot be told
  running or gone.

## Decisions

- **Use a lock once it is taken, even where the deadline passed while taking
  it.** The deadline bounds the wait. A slow `ps` can spend it during the take
  itself, and giving up a lock already held would turn a slow machine into a
  state file that cannot be written.
- **Bound each `ps` in the wait by the time the wait has left.** Only an
  attempt made on a deadline already spent, and the once-per-process read of
  the writer's own identity, keep a fixed floor.
- **Give `ps` 2,000 ms when telling whether a round host still runs.** That is
  long enough for a loaded machine, and short enough that `squiz status` over
  many records still returns promptly. A `ps` that does not answer in time is
  reported, not read as gone:

  ```
  squiz: no review ran: whether round host 4242 for PR #41 is still running could not be told: ps did not answer within 2000ms
  ```

## Needs your input

Nothing.

## Reference

- The bound is `PS_BOUND_MS` in `src/review/status.ts`. A `ps` cut off by it
  answers `ps did not answer within <n>ms` from `src/sessions/process.ts`.
- The 777 ms figure comes from commit `94545aa` (2026-10-05), which bounded each
  `ps` in the lock wait by the time left.

## Limits

- **One observation.** The 777 ms was seen once, on macOS, and how loaded the
  machine was is not recorded. How slow `ps` gets, and how often, was not
  measured.
- **The 2,000 ms is a judgement, not a measurement.** Nothing established it
  as the shortest bound that never misreads a running host.
- **Linux was not run.**
