# Working in this repository

The skills named here come from the `core` and `brownfield` plugins of the
`jacygao/skills` marketplace, which `.claude/settings.json` enables. They hold the
method; this file holds what is specific to squiz, and they read it from here.

## Specs

**Load the `core:writing-specs` skill before writing or editing anything under
`docs/specs/`.** Every time, without being asked.

`docs/specs/review-harness-spec.md` is the specification. Its § 8, The project,
fixes the language rules and the `src/` layout: erasable syntax only, and no
directory the layout does not have.

**A spec's version number changes once a release.** The pull request that sets
the release's version bumps it. Every other pull request leaves it alone, so
that two of them never conflict on the version line.

## Notes

**Load the `core:writing-notes` skill before writing or editing anything under
`docs/notes/`.** Every time, without being asked.

`docs/notes/` holds durable findings: what earlier work established, recorded so
that it is read rather than re-derived.

## Checks

```bash
npm run typecheck && npm test
```

Squiz has no build step. Node strips the types and runs the `.ts` files as they
are, so nothing checks the types unless `npm run typecheck` runs. CI runs both.

Several suites running at once on one machine fail the timing-sensitive tests.
While agents run theirs, run only the test files a change touches.

## Silent failures

- **The hook exits 0 on every failure path, by design.** A hook that throws looks
  exactly like a branch with no pull request. A test or a brief names what tells
  the two apart.
- **Squiz resolves a review by `git rev-parse --show-toplevel`.** Two subagents
  working in one tree read as one, and a subagent dispatched by path is reviewed
  against the tree it was dispatched from. Dispatch with `isolation: "worktree"`.

## The reviewer

Squiz reviews its own pull requests. Once a pull request is open, run
`squiz review <number>` and work it to exit 0, or to exit 3 with only `low`
threads open. It prints the open threads: fix what applies, answer each with
`squiz reply <id> <text>`, push, and run it again.

Squiz reviews a subagent's work whether or not the subagent ran the command. The
hook queues a review when the subagent finishes, and the session that dispatched
it is woken with the result.

## Running agents here

- **Load squiz from a checkout outside the repository.** With
  `--plugin-dir ./` every worktree is inside the loaded plugin, and auto mode
  refuses a subagent's `Write` there. Make the checkout once, and start every
  session from it:

  ```bash
  git worktree add --detach ../squiz-plugin origin/main     # once
  claude --plugin-dir ../squiz-plugin
  ```

- **Merged is not loaded until the checkout is refreshed.** Refresh it after
  each merge:

  ```bash
  git fetch -q origin && git -C ../squiz-plugin checkout -q --detach origin/main
  ```

  Each firing of the hook runs `bin/squiz` as a new process, which reads `src/`
  from the checkout, so a refreshed `src/` or `bin/` reaches the next round
  without a restart. `hooks/hooks.json` is read when the session starts, so a
  change to it waits for a restart (unverified).

**Load the `core:working-issues` skill before dispatching any issue to
subagents.** Every time, without being asked.

## Issues and releases

**A release is a GitHub milestone named by its version**, such as `0.1.0`. It
holds the issues that ship in that release. The `Backlog` milestone holds every
triaged issue that no release has taken yet. Each open issue carries one
milestone and one priority label:

- **`P0`** blocks the release it is in: a user on the default setup gets no
  review, or a wrong one, in ordinary use.
- **`P1`** is wanted in the next release or the one after: real users, or squiz's
  own CI, will hit it.
- **`P2`** waits in `Backlog` until a release's theme pulls it in.

The version is in `package.json`, `package-lock.json`,
`.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`.

**Load the `brownfield:triaging-issues` skill before triaging issues or planning
a release, and the `brownfield:cutting-releases` skill before cutting one.**
Every time, without being asked.

## Pull requests and issues

**Load the `core:writing-pull-requests` skill before running `gh pr create`, and
the `core:writing-issues` skill before running `gh issue create`.** Every time,
without being asked.
