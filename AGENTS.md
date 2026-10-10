# Working in this repository

## Specs

**Load the `writing-specs` skill before writing or editing anything under
`docs/specs/`.** Every time, without being asked.

`docs/specs/` holds design documents, as Markdown.

**A spec's version number changes once a release.** The pull request that sets
the release's version bumps it. Every other pull request leaves it alone, so
that two of them never conflict on the version line.

## Notes

**Load the `writing-notes` skill before writing or editing anything under
`docs/notes/`.** Every time, without being asked.

`docs/notes/` holds durable findings: what earlier work established, recorded so
that it is read rather than re-derived.

## Releases

**A release is a GitHub milestone named by its version**, such as `0.1.0`. It
holds the issues that ship in that release. The `Backlog` milestone holds every
triaged issue that no release has taken yet. Each open issue carries one
milestone and one priority label:

- **`P0`** blocks the release it is in.
- **`P1`** is wanted in the next release or the one after.
- **`P2`** waits in `Backlog` until a release's theme pulls it in.

Versions follow semantic versioning, and each number counts up without limit,
so `0.9.0` is followed by `0.10.0`. GitHub's latest release is the version
users have.

**Cutting a release is the owner's call.** Once its milestone has no open issue:

1. A pull request sets the version in `package.json`, `package-lock.json`,
   `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, and
   bumps each spec's version.
2. Once that merges, the release is tagged and published from `main`:

   ```bash
   gh release create v0.1.0 --target main --title 0.1.0 --generate-notes
   ```

3. The milestone is closed.

**Load the `planning-milestones` skill before planning a release's issues, and
the `executing-milestones` skill before dispatching any of them to subagents.**
Every time, without being asked.

## Pull requests and issues

**Load the `writing-pull-requests` skill before running `gh pr create`, and the
`writing-issues` skill before running `gh issue create`.** Every time, without
being asked.
