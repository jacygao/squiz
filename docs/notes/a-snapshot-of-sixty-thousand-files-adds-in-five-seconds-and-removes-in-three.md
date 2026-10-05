---
settles: "§ 4 and § 8 — what a snapshot costs in time and disk; § 7 — whether it fits the 30 seconds before the review"
issue: 302
recorded: 2026-10-04
versions: { git: 2.54.0 (Apple Git-157), macos: 26.6.2 }
recheck-when: git changes how worktree add checks out or how worktree remove deletes, or squiz runs on Linux
---

# A snapshot of sixty thousand files adds in five seconds and removes in three

## Intent

- How long `git worktree add --detach`, `git worktree remove --force` and
  `git worktree prune` take, on this repository and on a large one.
- How much disk one snapshot takes.
- Whether that fits inside the 30 seconds before the review, and what follows
  where it does not.

## Decisions

- **Take a snapshot on every round, as § 4 says.** On `rust-lang/rust`, 63,424
  tracked files, adding one took 4.6 seconds warm and 6.1 the first time.
  Removing a clean one took 2.9 seconds and pruning took 0.01. On this
  repository every step took under a tenth of a second.
- **Expect a snapshot to take about as much disk as the checkout itself.** One
  snapshot of `rust-lang/rust` was 408 MB, plus 8.1 MB of index and metadata
  under `.git/worktrees/`. The object store is shared, so nothing else is
  copied. Each concurrent round holds one, so three episodes reviewing at once
  hold three.
- **Count the add against the 30 seconds before the review.** At 63,424 files it
  takes a fifth of that part. The rest of the part is GitHub calls, which may
  each take up to 30 seconds, so a slow GitHub alone can still spend it; the
  snapshot does not change that. The add alone would fill the 30 seconds at
  somewhere between 300,000 and 400,000 tracked files on this machine
  (unverified: extrapolated linearly from 96 µs per file on the first add and
  73 µs warm), a size few repositories reach.
- **Take the removal off the round's path to a result.** Removing a snapshot
  costs time in proportion to every file in it, tracked or not. With 5,000
  untracked files it took 3.1 seconds. With 50,000, the size of a modest
  `node_modules` or `target/` that a `deep` round's build leaves, it took 7.9
  and 11.9. Nothing bounds what a reviewer leaves, so the round's outcome is
  recorded and returned first and the snapshot removed after.

## Needs your input

- **§ 7 places the snapshot in no part of the round.** Its parts table lists the
  pull request lookup, the threads listing and the diff before the review, and
  the posting after. Neither the add nor the removal appears, so neither is
  bounded. The decisions above recommend counting the add before the review and
  running the removal after the round's result is recorded. What a round
  becomes when the add outlasts the part is not specified either. Recommend
  amending § 7's parts table to place both, and to give that case the outcome
  of a round that could not start.

  2026-10-05: settled. § 7 The review budget counts the fetch and the add in
  the 30 seconds before the review, and a snapshot not made in time is the row
  for calls before the review that run out of time. § 4 The snapshot removes it
  after the round's result is recorded, outside the round's deadline.
- **§ 4's What it costs and § 8's Prerequisites still list the snapshot's time
  as not measured.** The time and disk part is settled here. What installing
  dependencies at `deep` adds is still open. Recommend narrowing both to that.

  2026-10-05: settled. The times are in Reference below, and § 8
  Prerequisites lists them as measured and leaves `deep`'s install and very
  large repositories open.

## Reference

The commands, as the round host runs them. Each was timed with zsh's `time`,
with the commit confirmed local beforehand (`git cat-file -e <commit>`):

```
git worktree add -q --detach <repo>/.squiz/<n>/rounds/<k>/tree <commit>
git worktree remove --force <repo>/.squiz/<n>/rounds/<k>/tree
git worktree prune
```

| Repository | Tracked files | Snapshot | First add | Add, median (max) | Remove, median (max) | Prune |
|---|---|---|---|---|---|---|
| squiz `0c009c0` | 166 | 2.1 MB | 0.050 s | 0.057 s (0.077) | 0.025 s (0.065) | 0.014 s |
| rust-lang/rust `4ddbc06` | 63,424 | 408 MB | 6.09 s | 4.64 s (4.89) | 2.93 s (3.27) | 0.011 s |

Removal with files a reviewer left behind, half 4 KB object files under
`target/debug/deps/` and half small files under `node_modules/pkg/`:

| Repository | Untracked files | Remove, median (max) | Runs |
|---|---|---|---|
| squiz | 5,000 | 0.34 s (0.40) | 5 |
| rust-lang/rust | 5,000 | 3.14 s (3.24) | 5 |
| rust-lang/rust | 50,000 | 7.9 s and 11.9 s | 2 |

Squiz had six add runs and six clean removals, `rust-lang/rust` seven. Both
were full clones with no promisor remote, so no checkout fetched a blob. The
12 submodule entries in `rust-lang/rust` are checked out as empty directories,
and `worktree add` does not initialise submodules.

The add is almost all system time: 3.8 of its 4.6 seconds on
`rust-lang/rust`. That is creating files on APFS, not reading objects. Setting
`-c checkout.workers=0` brought it to between 3.0 and 4.0 seconds over three
runs, which is not enough to change any decision above.

Machine: Apple M4, 10 cores, 24 GB, internal Apple SSD (APFS). No global or
system git config sets anything under `core.` or `feature.`. Both repositories
had only the defaults `git init` and `git clone` write, so fsmonitor, the
untracked cache and `core.preloadIndex` were all at their defaults.

## Limits

- **A cold file cache was not reached.** The first add after the clone was 6.1
  seconds, but the clone had just written the pack, so it was probably still
  in memory. A round on a repository untouched for days, its pack evicted, may
  take longer than 6.1 seconds. Clearing the cache with `purge` needs root and
  was not run. A round in an active repository, whose coding agent has just
  committed and pushed, is likely to see the warm number.
- **Linux was not run.** ext4 and a Linux page cache may differ in either
  direction.
- **One large repository, at one commit.** The 300,000 to 400,000-file ceiling
  is extrapolated, not measured.
- **The machine was otherwise idle.** A coding agent building in another
  worktree while the snapshot is added would compete for the same disk.
- **Fetching a head commit the repository lacks was not timed.** That is the
  network, and depends on how far behind the repository is.
