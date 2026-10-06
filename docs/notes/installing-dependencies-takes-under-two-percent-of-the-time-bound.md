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
  a warm one. The slowest is 1.5% of the bound. Installing and running the whole
  suite together took at most 53 seconds, 6% of it, on an otherwise quiet
  machine.
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

### What was measured

Each run makes a snapshot as `src/worktree/snapshot.ts` does, then runs the
install and the test command in it, timed apart. The snapshot was proven empty
before each install: `git status --porcelain --ignored` printed nothing, and
neither `node_modules` nor `.venv` existed.

```
git -C <clone> -c core.hooksPath=/dev/null worktree add --quiet --detach <clone>/.squiz/496/rounds/<k>/tree <commit>
cd <clone>/.squiz/496/rounds/<k>/tree
npm_config_cache=<cache> UV_CACHE_DIR=<cache> <install>
<test>
git -C <clone> worktree remove --force <clone>/.squiz/496/rounds/<k>/tree
git -C <clone> worktree prune
```

A cold run used a new, empty cache directory. A warm run used one that a
previous run had filled. Neither touched `~/.npm`. Flask ran on a uv-managed
Python 3.12 that was installed beforehand, with `UV_PYTHON_DOWNLOADS=never`.

| Project | Commit | Tracked files | Packages | Install | Test | Tests run |
|---|---|---|---|---|---|---|
| `markedjs/marked` | `e80938648225` | 538 | 489 | `npm ci` | `npm test`, which builds with esbuild and `tsc` first | 2,060, all pass |
| `mochajs/mocha` | `a9fc52968316` | 692 | 651 | `npm ci` | `npm run test-node`, which builds with rollup first | 389, 1 fails (below) |
| `nestjs/nest` | `35142c3eca8e` | 2,468 | 1,589 | `npm ci --legacy-peer-deps` | `npm test` (vitest) | 3,814, all pass |
| `pallets/flask` | `d73fa1cdcbd8` | 236 | 46 | `uv sync --frozen` | `uv run --frozen pytest` | 494, all pass |

nest's `npm ci` fails on a peer-dependency conflict without
`--legacy-peer-deps`, which its own CI passes. mocha's run stops at its first
failing script, so it ran the integration suite and not the rest.

### Times, in seconds

Median, with the range. Each install column is three runs, and the other
columns are all six.

| Project | Snapshot add | Install, cold | Install, warm | Test | Remove, after |
|---|---|---|---|---|---|
| marked | 0.05 | 4.40 (4.30–4.94) | 2.05 (2.02–2.05) | 9.63 (9.57–9.75) | 0.90 (0.82–1.10) |
| mocha | 0.08 | 4.44 (3.97–4.91) | 2.17 (2.10–2.18) | 48.5 (47.7–48.7) | 1.18 (1.03–1.35) |
| nest | 0.21 | 8.63 (8.45–13.09) | 6.39 (6.37–6.44) | 9.43 (9.32–9.85) | 3.79 (3.26–4.22) |
| flask | 0.05 | 3.59 (3.03–4.00) | 0.21 (0.20–0.21) | 1.70 (1.65–1.86) | 0.47 (0.46–0.49) |

mocha's test column is its five quiet runs. It leaves out two warm runs made
under load: 259.7 seconds at
a load average of 18, and 396.6 seconds at 8. A fourth warm install under that
load took 1.95 seconds. What loaded the machine was not established.

The empty caches filled to 73 MB (marked), 54 MB (mocha), 113 MB (nest) and
198 MB (flask, which uv keeps unpacked). On a link a tenth as fast as this one,
nest's cold install would take about 90 seconds, 10% of the bound (a
prediction, extrapolated from 113 MB in 8.6 to 13 seconds).

`npm ci` deletes `node_modules` first, so a test command that begins with it
pays the install on every `run_tests` call, at the warm figure after the first.

### Rounds at `read`, for scale

Rounds at `read` recorded so far ran 15 to 370 seconds: 70 to 370 seconds for
`pi` on `deepseek-v4-pro`, 324 for an interactive `pi`, 248.3 in the state file
of pull request #477's round, and 15 seconds for small changes. Two rounds on
2026-10-03 reached the 480-second bound in force then.

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
