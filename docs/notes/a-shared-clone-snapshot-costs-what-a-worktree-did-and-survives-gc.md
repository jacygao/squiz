---
settles: "§ 4 — how the snapshot is made and removed, what it shares with the coding agent's repository, and what a gc there does to it; § 7 — whether making it still fits the 30 seconds before the review"
issue: 570
recorded: 2026-10-06
versions: { git: 2.54.0 (Apple Git-157), macos: 26.6.2 }
recheck-when: git changes what clone --shared writes, how gc expires unreachable objects or cruft packs, or squiz runs on Linux
---

# A shared-clone snapshot costs what a worktree did, and survives gc

## Intent

- How long making and removing a snapshot as a clone takes, beside the
  worktree it replaces, on this repository and on a large one.
- Whether a clone has the head commit when no ref points at it, and the history
  the three history tools read.
- What a `git gc` in the coding agent's repository does to a snapshot while a
  round runs, and whether the round needs to guard against it.

## Decisions

- **Make the snapshot with `git clone --shared --no-checkout`, then a detached
  checkout.** On `rust-lang/rust` the clone and checkout took 4.93 seconds
  against 4.66 for `git worktree add`, about 0.3 seconds more. That is a sixth
  of the 30 seconds before the review, as the worktree was. On this repository
  both took under a tenth of a second.
- **Choose `--shared` over `--no-local`.** A `--no-local` clone copies only
  what the repository's refs reach, so it lacks a head commit that was fetched
  by its name and is on no ref; its checkout fails with
  `fatal: unable to read tree`. A `--shared` clone reads every object in the
  repository through `objects/info/alternates`, so it has that commit and the
  whole history behind it, and copies nothing.
- **Remove the snapshot by deleting its directory.** Node's `rmSync` took 2.45
  seconds on `rust-lang/rust`, against 3.03 for `git worktree remove --force`.
  Nothing in the repository refers to a clone, so no prune follows, and no entry
  ever appears in `git worktree list`.
- **Set the clone's `remote.origin.pushurl` to `/dev/null`.** A clone's
  `origin` is the coding agent's repository, so without it a `git push` from
  the snapshot would write that repository's refs, which a worktree's push
  never could.
- **Add no ref to keep the head commit alive.** A plain or automatic `git gc`
  in the coding agent's repository moves an object no ref reaches into a cruft
  pack and keeps it for `gc.pruneExpire`, two weeks by default, so a commit
  fetched minutes before survives. Only `git gc --prune=now` or `git prune`
  deletes it, and that breaks the snapshot. A ref to prevent it would itself be
  a write to the repository's refs, and one a killed round leaves behind.

## Needs your input

- **A branch name passed to `git_show` can resolve differently in the clone.**
  The clone holds the repository's branches as `refs/remotes/origin/<branch>`,
  so `origin/main` there is the repository's local `main`, where in a worktree
  it was the repository's own `origin/main`. Hashes and revisions from `HEAD`
  resolve alike, and those are what the tool's description offers. Recommend
  leaving it; § 4 states it.

## Reference

The commands, as the round host runs them, timed with bash's `time`, worktree
and clone alternating, with the commit confirmed local beforehand:

```
git -c core.hooksPath=/dev/null worktree add -q --detach <path> <commit>
git worktree remove --force <path>
git worktree prune

git clone -q --shared --no-checkout <git-common-dir> <path>
git -C <path> -c core.hooksPath=/dev/null checkout -q --detach <commit>
rm -rf <path>      # and node's fs.rmSync(path, { recursive: true }), five runs
```

Seven runs of each, median (max), in seconds:

| Repository | Files | Worktree add | Remove | Prune | Clone | Checkout | Clone + checkout | `rm -rf` | `rmSync` |
|---|---|---|---|---|---|---|---|---|---|
| squiz `21ed14b` | 281 | 0.044 (0.047) | 0.024 (0.043) | 0.011 (0.012) | 0.023 (0.029) | 0.040 (0.041) | 0.063 (0.070) | 0.023 (0.024) | 0.016 (0.019) |
| rust-lang/rust `b57eb9a` | 63,465 | 4.66 (4.88) | 3.03 (3.28) | 0.010 (0.011) | 0.033 (0.048) | 4.90 (5.57) | 4.93 (5.60) | 4.20 (4.83) | 2.45 (2.54) |

Disk on `rust-lang/rust`: the worktree was 409 MB plus 8.1 MB under
`.git/worktrees/`. The clone was 417 MB, of which its `.git` was 8.2 MB, nearly
all of it the index.

A `gc` in the coding agent's repository, with the snapshot checked out at a
commit fetched by its name and on no ref:

| Run in the repository | The commit afterwards | The snapshot |
|---|---|---|
| `git gc` | In a cruft pack, with a `.mtimes` file | `log -S`, `blame`, `status` and `fsck` all as before |
| `git gc --auto`, triggered, run in the foreground | In a cruft pack | As before |
| `git gc --prune=now` | Gone | `fatal: bad object HEAD` from `log`, `blame` and `status` |

Both repositories were full clones with no promisor remote, on the machine the
2026-10-04 worktree measurements used: Apple M4, 10 cores, 24 GB, internal SSD
(APFS), no global config under `core.` or `feature.`.

## Limits

- **The clone and checkout were not timed with a cold file cache**, for the
  same reason the worktree add was not: clearing it needs root.
- **Linux was not run.**
- **One large repository, at one commit**, with the machine otherwise idle.
- **A repository whose objects are themselves borrowed**, through alternates of
  its own, was not tried. Git follows alternates transitively, so it is expected
  to work (unverified).
- **A repository with local config the checkout needs**, such as an LFS filter
  installed with `--local` or a local `core.autocrlf`, checks out in the
  snapshot without it, as a fresh clone would. Not measured against a real
  project.
