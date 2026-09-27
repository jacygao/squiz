# Merging

Merging is the owner's call. Do it only when asked, and check these first.

## Do

- **Read the check's conclusion**, not the pull request page. `gh pr checks <n>`
  prints a conclusion once the run ends; until then there is nothing to act on.
- **Confirm the run is the one for the current head.** A force-push leaves the
  older run on the page, and its result is about code that is no longer there.
- **Resolve or answer every review thread.** An unresolved thread is either work
  not done or an answer the reviewer has not seen.
- **Check what the branch will collide with.** Where two branches change the same
  line, rebase before merging rather than after.
- **Watch the merge's own run on the default branch.** A branch that passed can
  still break it.

## Never

- **Read a pending check as a passing one.** No conclusion is no answer.
- **Read a missing check as a passing one.** GitHub drops a queued run without
  saying so, and then reports no checks at all — which looks exactly like a
  repository that runs none. Both cases print nothing; only one is safe.
- **Merge to unblock yourself.** A red check on a branch whose change cannot have
  caused it is a flake worth naming, not a reason to proceed.

## The test

Say out loud what the check concluded and for which commit. Not being able to is
the answer.
