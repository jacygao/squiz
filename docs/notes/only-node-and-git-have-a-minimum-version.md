---
settles: "§ 2: which dependencies have a minimum version; § 7: what the setup check reports of a version"
issue: [485, 969]
recorded: 2026-11-25
versions: { git: "2.25.1, 2.30.2, 2.54.0", gh: 2.97.0, pi: 0.84.2, copilot: 1.0.91, claude-code: "2.1.261, 2.1.288" }
recheck-when: a behaviour a note records stops holding on a later version, squiz starts calling a git option newer than 2.25, or the setup check starts checking versions
---

# Only Node and git have a minimum version

## Intent

- Whether any version a behaviour was seen on is a requirement, such as a
  minimum the setup check enforces.
- Which git squiz runs on, given that Ubuntu 20.04 ships 2.25.1 and Debian 11
  ships 2.30.2.
- How to tell whether a behaviour still holds after a dependency is upgraded.

## Decisions

- **Treat no dependency's version as a minimum, except Node's and git's.** § 2
  requires `gh` signed in, a runtime and a reviewer, and states no version for
  any of them. `squiz doctor` reports what is missing, unusable or
  unauthenticated, and prints each version without judging it. § 9 requires
  Node 24 or later, and the setup check fails an older one.
- **Support git 2.25 and later, and fall back where an option is newer.** § 2
  states the floor. A whole local-venue episode, from the base through
  `squiz review` to the summary, runs on git 2.25.1 and on 2.30.2. The setup
  check does not enforce the floor.
- **Re-check a behaviour on the new version before relying on it after an
  upgrade.** The version in a note's `versions` is the one the behaviour was
  seen on, and nothing tests it again on its own. The note's `recheck-when`
  names the upgrade that calls for it.

## Needs your input

Nothing.

## Reference

The git options squiz uses that are newer than 2.25, and what it does on an
older git:

| Option | Arrived in | On an older git |
|---|---|---|
| `git worktree list -z` | 2.36 | Exits 129, ``error: unknown switch `z'``. Squiz lists without `-z`, and reads a path holding a newline wrongly. |
| `git rev-parse --path-format=absolute` | 2.31 | Prints the option back as a line of output and exits 0. Squiz asks without it and resolves the answer against the worktree. |
| `git fetch --no-write-fetch-head` | 2.29 | Exits 129, ``error: unknown option `no-write-fetch-head'``. Squiz fetches without it and puts `FETCH_HEAD` back. |
| `git rev-parse --quiet --verify @{push}` with no push destination | After 2.30 (unverified which) | Exits 128, `fatal: no upstream configured for branch '<branch>'`, where a newer git exits 1. Squiz reads the push ref from `git for-each-ref --format=%(push)`. |
| `git diff <base>...<head>` failing where there is no merge base | After 2.25 (unverified which) | Exits 0 with the diff of the two commits, and a round reviews that diff instead of failing. |
| `GIT_NO_LAZY_FETCH` | 2.44 (unverified) | Ignored: the reviewer's git tools in a partial clone fetch a missing object through the transport the repository's config names. |

The setup check's Node row on a Node older than 24, as `src/review/doctor.ts`
writes it (unverified: not seen in output):

```
Node <version>: too old. Squiz needs Node 24 or later
```

## Limits

- **Only the versions recorded were run.** A later version that changes a
  behaviour is not ruled out.
- **No git older than 2.25 was run.** What squiz does on one is not known.
- **The episodes ran a scripted reviewer under the local venue.** The GitHub
  venue and a live reviewer's use of its git tools were run on old git only
  through the test suite.
