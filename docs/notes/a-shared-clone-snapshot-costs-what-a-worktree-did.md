---
settles: "§ 5 The snapshot: how it is made and removed, and what it costs in time and disk; § 8: whether making it fits the 30 seconds a call before the review has"
issue: [302, 570]
recorded: 2026-10-06
versions: { git: 2.54.0 (Apple Git-157), macos: 26.6.2 }
recheck-when: git changes what clone --shared writes, or squiz runs on Linux
---

# A shared-clone snapshot costs what a worktree did

## Intent

- How long making and removing a snapshot as a clone takes, beside the
  worktree it replaces, on this repository and on a large one.
- How much disk one snapshot takes, and where its removal belongs in the round.

## Decisions

- **Make the snapshot with `git clone --shared --no-checkout`, then a detached
  checkout.** On `rust-lang/rust`, 63,465 files, the clone and checkout took
  4.93 seconds against 4.66 for `git worktree add`: a sixth of the 30 seconds,
  as the worktree was. On this repository both took under a tenth of a second.
  The checkout alone would fill the 30 seconds at between 300,000 and 400,000
  tracked files on this machine (unverified: extrapolated from 73 to 96 µs per
  file), a size few repositories reach.
- **Expect a snapshot to take about as much disk as the checkout itself.** One
  snapshot of `rust-lang/rust` was 417 MB, of which its `.git` was 8.2 MB,
  nearly all of it the index. Each round running at once holds one.
- **Remove the snapshot by deleting its directory.** Node's `rmSync` took 2.45
  seconds on `rust-lang/rust`, against 3.03 for `git worktree remove --force`.
  Nothing in the repository refers to a clone, so no prune follows, and no
  entry appears in `git worktree list`.
- **Remove it after the round's result is recorded, not before.** Removal grows
  with every file in the snapshot: a `rust-lang/rust` worktree holding 50,000
  untracked files beside its checkout took up to 11.9 seconds to remove.
  Nothing bounds what the snapshot holds.

## Needs your input

Nothing.

## Reference

The commands, as the round host runs them:

```
git clone -q --shared --no-checkout --config remote.origin.pushurl=/dev/null <git-common-dir> <path>
git -C <path> -c core.hooksPath=/dev/null checkout -q --detach <commit>
```

The checkout is almost all system time, creating files on APFS rather than
reading objects. `-c checkout.workers=0` brought a 4.6-second checkout to
between 3.0 and 4.0 seconds. Submodule entries are checked out as empty
directories, and nothing initialises a submodule.

## Limits

- **The clone and checkout were not timed with a cold file cache.** A worktree
  add straight after the clone took 6.1 seconds, against 4.6 warm, so a round
  on a repository untouched for days may take longer.
- **Fetching a head commit the repository lacks was not timed.** That is the
  network.
- **The machine was otherwise idle**, an Apple M4 with an internal SSD. A coding
  agent building while the snapshot is checked out would compete for the disk.
- **One large repository, at one commit, on macOS only.**
