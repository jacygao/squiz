---
settles: "§ 4 — where the snapshot is made, and why no component of its path begins with a dot"
issue: 541
recorded: 2026-10-06
versions: { mocha: a9fc5296, minimatch: 10.2.5, glob: 13.0.6, node: 24.15.0, git: 2.54.0 (Apple Git-157), macos: 26.6.2 }
recheck-when: minimatch changes what `**` matches by default, mocha passes `dot: true` to its `--ignore` match, or a review level that runs the project's code is proposed
---

# A suite that globs its absolute paths misses files under any dot-directory

This was found when a review level ran the project's tests in the snapshot. No
level does now, so nothing a round runs globs the snapshot's path. The snapshot
still goes where no component of its path begins with a dot, so that a level
that runs code, if one returns, reads the same tree a fresh checkout would.

## Intent

- Why mocha's `test/integration/options/ignore.spec.cjs` fails in a snapshot at
  `.squiz/<number>/rounds/<k>/tree` and passes at an ordinary path.
- Whether the cause is the dot-directory, or the snapshot sitting inside another
  repository or under its `.gitignore`.
- Where the snapshot has to go for the spec to pass.

## Decisions

- **Put the snapshot where no component of its path begins with a dot.** The
  failure follows a dot-directory anywhere in the absolute path, and follows
  nothing else. A worktree at `<clone>/.squiz/541/rounds/1/tree` failed, and so
  did one at `$TMPDIR/squiz-541/.outside/tree`, outside any repository. One at
  `<clone>/squiz-nodot/541/rounds/1/tree`, inside the clone, passed.
- **Put it outside the repository, in the temporary directory.** A non-dot
  directory inside the repository does not meet the first decision wherever the
  coding agent's worktree itself sits under a dot-directory. Claude Code puts a
  subagent's worktree at `.claude/worktrees/agent-<id>`.

## Needs your input

Nothing.

## Reference

- Mocha filters its spec files with
  `minimatch(filename, pattern, { windowsPathsNoEscape: true })` in
  `lib/cli/collect-files.cjs`, against each file's absolute path. Without
  `dot: true`, `**` matches no path segment that begins with a dot.
- The failing case is `--ignore '**/fail.fixture.js'`. It ignores nothing, so
  the two fixtures that throw `should not run` run and fail, and the spec sees
  exit 2 where it expects 0. The spec file paths themselves are found, because
  the dot-directory is a literal part of the pattern and not matched by `**`.
- In isolation:

  ```
  minimatch("/a/b/tree/x/fail.fixture.js", "**/fail.fixture.js")                     true
  minimatch("/a/.squiz/41/rounds/2/tree/x/fail.fixture.js", "**/fail.fixture.js")    false
  minimatch("/a/.squiz/41/rounds/2/tree/x/fail.fixture.js", "**/fail.fixture.js", { dot: true })  true
  ```


## Limits

- Only mocha was traced. Other runners that match absolute paths with `**` and
  no `dot` option fail the same way (unverified).
- Run on macOS only, where `TMPDIR` is a per-user directory under
  `/var/folders/`. On Linux the temporary directory is usually the shared `/tmp`.
