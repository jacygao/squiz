---
settles: "§ 3: whether a state-file lock taken after its writer's deadline passed is used; § 7: how long `squiz status` and `squiz review` wait for `ps` to say whether a round host still runs"
recorded: 2026-11-22
versions: { squiz: 94545aa, platform: macOS }
recheck-when: squiz stops using `ps` to tell a holder running from gone, or runs on Linux
---

# `ps` can be slow enough to outlast a lock's deadline

## Intent

- Whether a writer's deadline on the state lock can pass while the lock is
  being taken.
- How long to let `ps` take before a holder counts as one that cannot be told
  running or gone.

## Decisions

- **Use a lock once it is taken, even where the deadline passed while taking
  it.** On a loaded machine one `ps` can take longer than the whole wait: a
  50 ms wait on a live holder ran to 777 ms. Giving up a lock already held would
  turn a slow machine into a state file that cannot be written.
- **Bound each `ps` in the wait by the time the wait has left**, the writer's
  read of its own identity included. Only an update whose deadline was spent
  before it began keeps a fixed floor, of 2,000 ms.
- **Give `ps` 2,000 ms in `squiz status` when telling whether a round host
  still runs.** That is long enough for a loaded machine, and short enough that
  `squiz status` over many records still returns promptly. A `ps` that does not
  answer shows as a host that could not be checked, not as one that is gone.
- **`squiz review` gives `ps` what is left of its 540-second deadline** when it
  asks whether a round host still runs before queueing a round, and 5,000 ms
  when it asks whether the host of a failed close that is still posting its
  summary has stopped. A `ps` that does not answer is reported, not read as
  gone:

  ```
  squiz: no review ran: whether round host 4242 for PR #41 is still running could not be told: ps did not answer within 2000ms
  ```

## Needs your input

Nothing.

## Reference

- The lock wait's floor is `PS_FLOOR_MS` in `src/loop/state-update.ts`, used
  only where `lastAttemptOnly` is set.
- `squiz status`'s bound is `PS_BOUND_MS` in `src/review/status.ts`.
- `squiz review`'s are the remaining deadline in `hostPresence`
  (`src/host/trigger.ts`) and `HOST_CHECK_MS` in `src/review/review.ts`.
- A `ps` cut off by any of them answers `ps did not answer within <n>ms`, from
  `src/sessions/process.ts`.

## Limits

- **One observation.** The 777 ms was seen once, on macOS, and how loaded the
  machine was is not recorded. How slow `ps` gets, and how often, was not
  measured.
- **The 2,000 ms is a judgement, not a measurement.** Nothing established it
  as the shortest bound that never misreads a running host.
- **Linux was not run.**
