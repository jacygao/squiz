---
settles: "§ 7 — why `squiz review` straight after a push waits for GitHub to report the pushed commit"
issue: [852, 855]
recorded: 2026-11-22
versions: { squiz: f06a3f5 }
recheck-when: GitHub changes how quickly a pull request's head follows a push, or squiz stops reading the head from GitHub
---

# GitHub reports a pull request's old head for seconds after a push

`git push -q && squiz review 851` reported the closed review of the head before
the push and exited 0. Run a few seconds later, it reviewed the pushed commit.
The local `@{push}` already named the new commit when the first run asked.

## Intent

- Whether the head GitHub reports can be trusted straight after a push.

## Decisions

- **Decide nothing while GitHub's head does not contain `@{push}` and the
  repository has that head.** Ask again once a second, for up to 60 seconds, and
  act on the first head that contains the pushed commit.
- **Compare `@{push}`, not `HEAD`.** Commits not yet pushed leave `@{push}`
  where it was, so they are never read as a push GitHub has not reported.

## Needs your input

Nothing.

## Reference

The run on #851:

```
$ git push -q && ./bin/squiz review 851
Squiz's review of PR #851 closed at 37503ea after 1 round, with nothing open. Only a new head commit starts another review in this worktree.
exit=0

$ git log --oneline -1; gh pr view 851 --json headRefOid --jq .headRefOid
ce4108c Keep carryLogins in sessions/copilot-settings.ts, …
ce4108c4d65ce567d185a6abdba2a4048a07e974
```

## Limits

- **One occurrence, and the lag is inferred from it.** What GitHub reported at
  the moment of the first run was not captured. How long the lag lasts was not
  measured; 60 seconds is a bound chosen, not one observed.
- **The `gh` version is not recorded.**
