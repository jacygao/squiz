---
settles: "§ 4 — what the build before tests costs a round at `deep`; § 7 — whether the 900-second time bound changes at `deep`"
issue: 496
recorded: 2026-10-06
versions: { node: 24.15.0, npm: 11.12.1, uv: 0.12.23, python: 3.12.15, git: "2.54.0 (Apple Git-157)", macos: 26.6.2 }
recheck-when: squiz reviews a project whose test command compiles (Rust, Go, C++), a round at `deep` is first run end to end, or rounds at `deep` record a time near the bound
---

# Installing dependencies takes under two percent of the time bound

## Intent

- How long a snapshot with no installed dependencies takes to install what the
  tests need, from an empty package cache and from a warm one.
- Whether that takes enough of the 900-second time bound to cut a review at
  `deep` short.

## Decisions

- **Keep the 900-second default at `deep`, and add no shared dependency
  cache.** On four projects of 46 to 1,589 packages, installing into a fresh
  snapshot took 3 to 13 seconds from an empty cache and 0.2 to 6.4 seconds from
  a warm one. The slowest is 1.5% of the bound. Installing and then running the
  test command took at most 53 seconds, 6% of it, on an otherwise quiet
  machine; mocha's command, the longest, stopped at its first failing script
  rather than running its whole suite.
- **Expect the tests, not the install, to be what spends a round at `deep`.**
  The same mocha suite that took 48 seconds on a quiet machine took 260 and 397
  seconds at load averages of 18 and 8, with 11 and 9 tests failing, timeouts
  among them. The install beside it moved by less than a second.

## Needs your input

- **A test command's install can change the coding agent's repository, outside
  the snapshot.** `npm ci` on nest runs `husky` as its `prepare` script, which
  set `core.hooksPath=.husky/_` in the `.git/config` the snapshot shares with
  every worktree. From then on the coding agent's commits look for hooks in a
  directory its own worktree may not have. The comparison on the snapshot cannot
  see it. Recommend the round compare the repository's local config before and
  after `run_tests`, and name a change. Filed as #540 under M11.
- **A suite can fail in the snapshot and pass in a fresh checkout of the same
  commit.** mocha's `--ignore` integration spec fails at a path under `.squiz/`
  and passes at an ordinary path. `run_tests` would report that as the code's
  failure. Recommend making snapshots at a path with no component beginning with
  a dot. Filed as #541 under M11.

## Reference

### The figures the decisions rest on

Medians in seconds, from an empty cache directory (cold) and from one a
previous run filled (warm), each install in a fresh snapshot. The test column
is the command after the install, and mocha's stops at its first failing
script, so it is not the whole suite.

| Project | Packages | Install | Cold | Warm | Test command |
|---|---|---|---|---|---|
| `markedjs/marked` | 489 | `npm ci` | 4.4 | 2.1 | `npm test`: 9.6 |
| `mochajs/mocha` | 651 | `npm ci` | 4.4 | 2.2 | `npm run test-node`: 48.5 |
| `nestjs/nest` | 1,589 | `npm ci --legacy-peer-deps` | 8.6 (13.1 at most) | 6.4 | `npm test`: 9.4 |
| `pallets/flask` | 46 | `uv sync --frozen` | 3.6 | 0.2 | `uv run --frozen pytest`: 1.7 |

Rounds at `read` recorded so far ran 15 to 370 seconds.

On a link a tenth as fast as this one, nest's cold install would take about 90
seconds, 10% of the bound (a prediction, from its 113 MB of packages).

### Traps

- **`npm ci` deletes `node_modules` first**, so a test command that begins with
  it pays the install on every `run_tests` call, at the warm figure after the
  first.
- **nest's `npm ci` fails on a peer-dependency conflict** without
  `--legacy-peer-deps`, which its own CI passes. A test command that works in a
  fresh checkout has to carry whatever flags the project's CI does.

## Limits

- **This measures the command in a snapshot, not a round at `deep`.** The typed
  tools `run_tests` and the `git_*` tools are not built, so no reviewer ran. How
  many times a reviewer calls `run_tests`, and how long it reads around those
  calls, is not measured.
- **No compiled language.** Neither cargo nor Go was on the machine. A test
  command that compiles a Rust or C++ project from nothing may take minutes, and
  nothing here bounds that.
- **One fast connection.** The cold figures are as fast as this network and
  the registries' CDNs were that afternoon.
- **"Warm" is a cache that holds exactly these packages.** The user's own
  `~/.npm` was not used, so how warm it is for a given project is not known.
- **The machine was shared.** Other agents ran throughout, at load averages
  from 2.3 to 18. The quiet figures are the ones in the table.
- **Why mocha's spec fails under `.squiz/` was not traced.** Glob libraries skip
  dot-directories by default, which may be the cause (unverified).
