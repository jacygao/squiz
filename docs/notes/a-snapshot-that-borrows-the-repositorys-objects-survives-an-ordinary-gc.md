---
settles: "§ 5 The snapshot: what it shares with the coding agent's repository, and what a gc there does to it"
issue: [302, 570]
recorded: 2026-10-06
versions: { git: 2.54.0 (Apple Git-157), macos: 26.6.2 }
recheck-when: git changes what clone --shared writes, or how gc expires unreachable objects or cruft packs
---

# A snapshot that borrows the repository's objects survives an ordinary gc

## Intent

- Whether a clone has the head commit when no ref points at it, and the history
  the history tools read.
- What a `git gc` in the coding agent's repository does to a snapshot while a
  round runs, and whether the round needs to guard against it.

## Decisions

- **Clone with `--shared`, not `--no-local`.** A `--no-local` clone copies only
  what the repository's refs reach, so it lacks a head commit fetched by its
  name and on no ref, and its checkout fails with `fatal: unable to read tree`.
  A `--shared` clone reads every object in the repository through
  `objects/info/alternates`, so it has that commit and the history behind it,
  and copies nothing.
- **Add no ref to keep the head commit alive.** A plain or automatic `git gc`
  in the coding agent's repository moves an object no ref reaches into a cruft
  pack and keeps it for `gc.pruneExpire`, two weeks by default, so a commit
  fetched minutes before survives. Only `git gc --prune=now` or `git prune`
  deletes it, and the snapshot's `log`, `blame` and `status` then fail with
  `fatal: bad object HEAD`. A ref to prevent that would be a write to the
  repository's refs, and one a killed round leaves behind.
- **Set the clone's `remote.origin.pushurl` to `/dev/null`.** A clone's
  `origin` is the coding agent's repository, so without it a `git push` from
  the snapshot would write that repository's refs, which a worktree's push
  never could.

## Needs your input

- **A branch name passed to `git_show` can resolve differently in the clone.**
  The clone holds the repository's branches as `refs/remotes/origin/<branch>`,
  so `origin/main` there is the repository's local `main`, where in a worktree
  it was the repository's own `origin/main`. Hashes and revisions from `HEAD`
  resolve alike, and those are what the tool's description offers. Recommend
  leaving it.

## Limits

- **A repository whose objects are themselves borrowed**, through alternates of
  its own, was not tried. Git follows alternates transitively (unverified).
- **A repository with local config the checkout needs**, such as an LFS filter
  installed with `--local` or a local `core.autocrlf`, checks out in the
  snapshot without it, as a fresh clone would. Not measured against a real
  project.
- **macOS only**, on full clones with no promisor remote.
