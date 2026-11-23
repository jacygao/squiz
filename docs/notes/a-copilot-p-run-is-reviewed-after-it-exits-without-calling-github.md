---
settles: "§ 3: whether a `copilot -p` run's review starts after the run has exited, and whether `--plugin-dir` hooks fire in a folder Copilot does not trust; § 4: that the local venue under a `copilot -p` run calls no GitHub and keeps its record in `.squiz/local/`, and where `shell(squiz)` allows its `(cd '…' && squiz …)` form"
issue: [805, 787]
recorded: 2026-11-23
versions: { copilot: 1.0.110, coding-model: gpt-6.1-sol, reviewer-model: gpt-6-astra, node: 24.15.0, git: 2.54.0, macos: 26.6.2, squiz: 6a82920 }
recheck-when: Copilot CLI changes how `--plugin-dir` hooks fire in a folder it does not trust, or how `shell(...)` grants match a subshell or a path; or the local venue's record or reply form changes
---

# A `copilot -p` run is reviewed after it exits, without calling GitHub

## Intent

- Whether a review starts and finishes after a `copilot -p` run has exited,
  with nothing holding the run.
- Whether `--plugin-dir` loads squiz's hooks under `copilot -p`, and whether
  they fire in a folder Copilot does not trust, with no `COPILOT_ALLOW_ALL`.
- Whether anything calls GitHub under the local venue, and whether squiz writes
  anything outside `.squiz/local/` or into git.
- Whether the outcome can be read from `.squiz/local/` afterwards.
- Whether a `shell(squiz)` grant allows the local venue's
  `(cd '<worktree>' && squiz …)` form.

## Decisions

- **Expect a `copilot -p` run's review to start as the run exits.** The coding
  agent exited at 12:49:08.2 UTC and round 1 began reviewing at 12:49:08.3. The
  round host wrote the note for the run's session and exited with nothing
  queued, and no squiz or reviewer process was left.
- **Rely on `--plugin-dir` to load squiz's hooks under `copilot -p`, trusted or
  not.** The scratch repository was in no `trustedFolders` entry, and a
  `copilot -p` run without `--yolo` or `COPILOT_ALLOW_ALL` still fired `Stop`,
  whose round recorded that run's session as its owner. The coding agent's
  `SessionStart` wrote `base.json` before the agent made its change.
- **Count the local venue as calling no GitHub and writing nothing into git.**
  Every `gh` call in the run was `gh auth token`, made by a `copilot` process
  signing in, and none by squiz. Squiz's files were all under `.squiz/`, which
  stayed ignored, and no commit was added.
- **Read the outcome from `.squiz/local/` after the run.** `threads.json`,
  `summary.md` and `closed.json` gave every thread, reply and ruling once the
  episode closed.
- **Expect `shell(squiz)` to allow `(cd '<worktree>' && squiz …)` only from
  inside that worktree.** Run from the worktree, `(cd '<worktree>' && squiz
  threads)` ran. From a directory outside it, Copilot refused it as a path:
  `Denied, no one to approve shell path`.

## Needs your input

Nothing.

## Reference

### Telling the local venue's run apart

- `git remote -v` printed nothing, `git for-each-ref` listed `refs/heads/main`
  alone, and `base.json` held the only commit.
- `git status --short --ignored` listed the change, with `.squiz/` and
  `.squiz.json` as ignored. `.squiz/.gitignore` holds `*`, and `.squiz.json`
  was kept out by `.git/info/exclude`.
- The snapshot in `TMPDIR` was removed after each round.

### What `.squiz/local/` held at the close

- `threads.json`: `T1` with `isResolved: true`, its comments `C1` (the finding),
  the replies, and `C4` headed `**Squiz reviewer · fixed**`.
- `summary.md`: `2 rounds, 1 finding` and
  `Fixed 1 · Withdrawn 0 · Open 0 · Disputed 0`.
- `closed.json`: `{"head": "0e7db84…", "exitStatus": 0, "openThreads": []}`.

A run whose episode never closed has no `summary.md`, and `squiz status` shows
where it stopped (unverified: this run closed its episode).

### What `host.log` held for round 1

```
round 1: reviewing 31ba9b5
round 1: 31ba9b5 reviewed, 1 threads open
31ba9b5: noted its owner, d6b0dc3a-9526-47a8-ab05-6cf228e7ab85
```

A `copilot -p` run without experimental features records no socket, so the log
has no wake line.

### The coding agent's command line

`copilot --prompt=<task> --yolo --output-format json --disable-builtin-mcps --no-auto-update --disable-client-telemetry --no-ask-user --plugin-dir <checkout> --excluded-tools web_fetch web_search`,
with `.squiz.json` naming `"venue": "local"` and `"reviewer": "copilot"`.

## Limits

- **One run, one planted defect, one finding.**
- **The run's later rounds were driven by a fixer squiz no longer starts.** The
  `Stop` that fired without trust or `--yolo` was that fixer's, and the close
  above followed its fix. A `copilot -p` run today leaves its note waiting in
  `.squiz/local/notes/` (unverified).
- **No Claude Code run was made.**
