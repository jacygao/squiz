---
settles: "§ 7: why `squiz review` straight after a push waits for GitHub to report the pushed commit"
issue: [852, 855]
recorded: 2026-11-22
versions: { squiz: f06a3f5 }
recheck-when: GitHub changes how quickly a pull request's head follows a push, or squiz stops reading the head from GitHub
---

# GitHub reports a pull request's old head for seconds after a push

## Intent

- Whether the head GitHub reports can be trusted straight after a push.

## Decisions

- **Decide nothing while GitHub's head does not contain `@{push}` and the
  repository has that head.** Run straight after `git push`, `squiz review`
  reported the closed review of the head before the push and exited 0, though
  `@{push}` already named the new commit. Ask again once a second, for up to 60
  seconds, and act on the first head that contains the pushed commit.
- **Compare `@{push}`, not `HEAD`.** Commits not yet pushed leave `@{push}`
  where it was, so they are never read as a push GitHub has not reported.

## Needs your input

Nothing.

## Reference

Where GitHub still has not reported the push after 60 seconds, the run queues
nothing and prints:

```
squiz: no review ran: PR #41 still has 3f9c2e0 as its head after 60 seconds, though this worktree pushed 8d21a4f to it
```

A head pushed from elsewhere, which the repository lacks, and a branch with no
push destination are taken as GitHub reports them. The hooks never wait.

## Limits

- **One occurrence, and the lag is inferred from it.** What GitHub reported at
  the moment of the first run was not captured. How long the lag lasts was not
  measured; 60 seconds is a bound chosen, not one observed.
- **The `gh` version is not recorded.**
