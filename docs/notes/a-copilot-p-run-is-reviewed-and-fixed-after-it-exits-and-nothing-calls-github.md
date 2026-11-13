---
settles: "§ 3 — whether a `copilot -p` run's review, fixer and close all finish after the run has exited, and what the fixer's command line lets it do; § 4 — that the local venue under a headless run calls no GitHub and keeps its record in `.squiz/local/`; § 5 — the hosts a Copilot reviewer reaches from a fresh `COPILOT_HOME`"
issue: [805, 787]
recorded: 2026-11-13
versions: { copilot: 1.0.110, coding-model: gpt-6.1-sol, reviewer-model: gpt-6-astra, fixer-model: gpt-6.1-sol, node: 24.15.0, git: 2.54.0, macos: 26.6.2, squiz: 6a82920 }
recheck-when: Copilot CLI changes how `--plugin-dir` hooks fire in a folder it does not trust, how `shell(...)` grants match a subshell or a path, or which hosts a fresh `COPILOT_HOME` reaches; or the fixer's command line changes
---

# A `copilot -p` run is reviewed and fixed after it exits, and nothing calls GitHub

A `copilot -p` coding agent ran suss's flags in a scratch repository: no remote,
one base commit, and `.squiz.json` naming `"venue": "local"`, `"reviewer":
"copilot"` and `"fixer": "copilot"`. Squiz was loaded from this repository's
checkout with `--plugin-dir`. The agent was told to add
`pageCount(total, size)` as `Math.floor(total / size)`, word for word, and
exited 0 after 12.5 seconds. The reviewer opened one `high` thread, `Page count
omits the final partial page`. The round host started a fresh Copilot fixer,
which changed `Math.floor` to `Math.ceil`, added a test file and replied on the
thread. Its own stop queued round 2, which ruled the thread `fixed` and closed
the episode with `closed.json` at exit status 0. From the run's exit to the
close took 84 seconds.

## Intent

- Whether a review, the fixer and the close all finish after a `copilot -p` run
  has exited, with nothing holding the run.
- Whether `--plugin-dir` loads squiz under `copilot -p`, and whether its hooks
  fire in a folder Copilot does not trust, with no `COPILOT_ALLOW_ALL`.
- Whether the fixer's grants, `write`, `shell(squiz)` and `shell(git)`, let it
  fix and reply, and whether `shell(squiz)` matches the local venue's
  `(cd '…' && squiz reply …)` form.
- Whether anything calls GitHub, and whether squiz writes anything outside
  `.squiz/local/` or into git.
- Which hosts the reviewer reaches.
- Whether the outcome can be read from `.squiz/local/` afterwards.

## Decisions

- **Count the headless handoff as working end to end under `copilot -p`.** The
  coding agent exited at 12:49:08.2 UTC, and round 1 began reviewing at
  12:49:08.3. The fixer started at 12:49:30.8, and its stop queued round 2,
  which began at 12:50:12. `closed.json` was written at 12:50:32, and no squiz,
  reviewer or fixer process was left after it.
- **Rely on `--plugin-dir` to load squiz's hooks under `copilot -p`, trusted or
  not.** The scratch repository was in no `trustedFolders` entry, and the fixer
  ran without `--yolo` or `COPILOT_ALLOW_ALL`. Its `Stop` still fired the hook,
  and round 2's record names the fixer's session as its owner. The coding
  agent's `SessionStart` wrote `base.json` before the agent made its change.
- **Keep `shell(squiz)` as the fixer's grant for squiz.** The fixer's
  `squiz reply T1 '…'` ran. The subshell form also runs where the fixer runs:
  `(cd '<worktree>' && squiz threads)` ran from the worktree itself, and was
  refused as a path, `Denied, no one to approve shell path`, from a directory
  outside it. The fixer always starts in the worktree, so the form it is told
  to use is allowed.
- **Treat the fixer's missing test grant as a defect, #864.** It tried
  `node --test src/paging.test.js` twice, and both were refused with
  `✗ Denied, no one to approve shell command (node)`. It said so in a second
  reply, `C3`: "test execution remains unverified".
- **Treat the fixer's missing network flags as a defect, #863.** The fixer runs
  without `--no-auto-update`, `--disable-client-telemetry` and
  `--disable-builtin-mcps`, and reached `cafe.github.com` and
  `telemetry.enterprise.githubcopilot.com`, which the reviewer and the coding
  agent did not.
- **Count the reviewer as reaching only Copilot's own hosts.** It reached
  `api.github.com`, `api.enterprise.githubcopilot.com` and
  `exp.enterprise.githubcopilot.com`. The third is new since 1.0.107. A
  suss-flagged coding agent reaches it too when its `COPILOT_HOME` is empty, as
  a fresh sandbox's is, and the reviewer always runs from an empty one under
  its round's `session/`. Suss allows only the first two, so a suss run
  blocks it. Whether a run still works without it was not tried.

## Needs your input

Nothing.

## Reference

### What each of #787's criteria rests on

| Criterion | Evidence |
|---|---|
| Reviewed against a base, no remote, no PR, no commits beyond it | `base.json` holds `ec2e102`, the only commit. `git remote -v` prints nothing, `git for-each-ref` lists `refs/heads/main` alone, and `git log --all` has one commit. |
| Nothing calls GitHub | A logging `gh` was first on `PATH` for every process. Each of its 13 calls was `gh auth token`, and each parent was a `copilot` process: the coding agent, a reviewer or the fixer. None was squiz's `node`. |
| Everything squiz writes is in `.squiz/local/` and out of git | `git status --short --ignored` lists ` M src/paging.js`, `?? src/paging.test.js`, and `.squiz/` and `.squiz.json` as ignored. `.squiz/.gitignore` holds `*`. `.squiz.json` was kept out by `.git/info/exclude`, so no commit was added. The snapshot in `TMPDIR` was removed after each round. |
| Nothing holds the run, and nothing wakes it | The coding agent's `result` event: `"exitCode": 0`, `"sessionDurationMs": 12509`. The review began after it ended. The fixer, not a wake, carried the findings. |
| The outcome is readable afterwards | `threads.json`: `T1`, `isResolved: true`, comments `C1` (the finding), `C2` and `C3` (the fixer's replies), `C4` (`**Squiz reviewer · fixed**`). `summary.md`: `2 rounds, 1 finding`, `Fixed 1 · Withdrawn 0 · Open 0 · Disputed 0`. `closed.json`: `{"head": "0e7db84…", "exitStatus": 0, "openThreads": []}`. |

### What `host.log` held

```
round 1: reviewing 31ba9b5
round 1: 31ba9b5 reviewed, 1 threads open
31ba9b5: noted its owner, d6b0dc3a-9526-47a8-ab05-6cf228e7ab85
round 1: wrote the handoff to …/.squiz/local/rounds/1/handoff.md
round 1: started the fixer, copilot, as process 18333, writing to …/.squiz/local/rounds/1/fixer.log
exiting: nothing is left queued
round 2: reviewing 0e7db84 with reply C3
round 2: 0e7db84 with reply C3 reviewed, episode closed (nothing-open)
0e7db84 with reply C3: noted its owner, 4953aaf0-84e3-45df-a906-9284a751912b
round 2: wrote the close to …/.squiz/local/closed.json
exiting: nothing is left queued
```

Round 1's record has `"fixer": {"outcome": "started", "agent": "copilot", "process": {"pid": 18333, …}}`.

**This contradicts § 3 Headless runs.** It says the round host writes
`<head>: no wake: .squiz.json names a fixer, so the run is headless` in place of
the wake. `src/host/host.ts` writes that line only where the hook recorded a
socket. A `copilot -p` run without experimental features records none, so the
log has no such line.

### How the hosts were observed

A logging forward proxy on `127.0.0.1`, named in `HTTPS_PROXY` and
`HTTP_PROXY`, recorded every `CONNECT` with its client's port. The variables
reached the reviewer and the fixer through the hook and the round host.
Each process was told apart by time and by `lsof`. An `lsof -i` sample of every
process carrying a marker variable, about every 150 ms, tied the coding
agent's and the fixer's ports to their pids. The reviewer's `copilot` never
showed in `ps -E`, so its connections are the ones made while it was the only
Copilot process alive: 12:49:09 to 12:49:11 for round 1, and 12:50:13 to
12:50:15 for round 2.

| Process | Hosts, all on port 443 |
|---|---|
| Coding agent, `~/.copilot` | `api.github.com`, `api.enterprise.githubcopilot.com` |
| Coding agent, empty `COPILOT_HOME`, a probe after the run | `api.github.com`, `exp.enterprise.githubcopilot.com`, `api.enterprise.githubcopilot.com` |
| Reviewer, rounds 1 and 2 | `api.github.com`, `exp.enterprise.githubcopilot.com`, `api.enterprise.githubcopilot.com` |
| Fixer | `api.github.com`, `api.enterprise.githubcopilot.com`, `cafe.github.com`, `telemetry.enterprise.githubcopilot.com` |

### The run's setup

- The coding agent's command line was suss's arm with `--plugin-dir` added:
  `copilot --prompt=<task> --yolo --output-format json --disable-builtin-mcps --no-auto-update --disable-client-telemetry --no-ask-user --plugin-dir <checkout> --excluded-tools web_fetch web_search`.
- It ran under `env -i` with `HOME`, `USER`, `TERM`, `TMPDIR`, the proxy
  variables and a `PATH` of a scratch `bin/` (the logging `gh`, `copilot`, and
  `squiz` linked to this checkout's `bin/squiz`) then the system directories.
  No `HERDR_*`, `TMUX` or `CLAUDE_*` variable reached it, so the reviewer ran
  detached.
- `squiz doctor` in the repository named this checkout and the local venue.
  The installed 0.2.0 squiz was disabled in Copilot.
- The coding agent and the fixer, each on Copilot's default, were told `An
  administrator-managed setting replaced model "gpt-6-astra" with
  "gpt-6.1-sol"`. The reviewer, given `--model gpt-6-astra`, ran on
  `gpt-6-astra`, as its `usage.json` records.

## Limits

- **One run, one planted defect, one finding.** The fix took one fixer, so a
  second fixer, a cap reached with threads open, and `closedAt` were not
  exercised.
- **The fixer went beyond the thread.** It added `src/paging.test.js`, which
  round 2 reviewed with the fix.
- **The reviewer's hosts are attributed by time, not by `lsof`.** A connection
  from another process that honoured the proxy in those windows would read as
  the reviewer's. No other Copilot process was alive then. A direct
  connection that bypassed the proxy and lasted under one sample would be
  missed.
- **DNS was not captured**, and only one plan's model host was seen.
- **Suss's own allowlist was not applied.** Whether the reviewer works with
  `exp.enterprise.githubcopilot.com` blocked, and whether the fixer works with
  telemetry blocked, was not tried.
- **No Claude Code fixer was run**, so whether its grants have the same gap as
  #864 says is unverified.
