---
settles: "§ 4 — what keeps a tree under review from configuring `pi`, and what decides whether `pi` trusts a tree"
issue: 242
recorded: 2026-10-03
versions: { pi: 0.85.1, node: 24.15.0, macos: 26.6.2 }
recheck-when: pi upgrades, or pi's project trust resolution changes
---

# A project pi does not trust is one pi never reads

## Intent

- What decides whether `pi` trusts a tree under review.
- What a trusted tree under review configures.
- Whether a round can untrust the tree without writing into it.

## Decisions

- **Put `--no-approve` on the command line.** `pi` reads it as the project being
  untrusted, and an untrusted project's `.pi/settings.json` is loaded as `{}`
  rather than merged over the user's global settings. Without it, a tree under
  review that carries its own `.pi/settings.json` could name the model that
  reviews it, and a trust decision the user saved against any directory above
  the tree would trust the tree.

- **Write nothing into the tree to change `pi`'s settings.** A
  `<cwd>/.pi/settings.json` is the one other route to them, and the tree is the
  code under review.

- **Do not expect a trust prompt in a round.** A trust override given on the
  command line is returned before anything else is consulted, so no round reaches
  the prompt, the trust store or `defaultProjectTrust`.

- **Do not expect `defaultProjectTrust: "never"` to hold a tree back.** A tree
  with nothing trust-requiring under `.pi/` is trusted without that setting being
  read at all.

## Needs your input

- **Whether a project's own `pi` settings should stop applying to a review.**
  `--no-approve` drops the whole file, so a `defaultModel` or a `retry` block a
  project pinned no longer reaches the reviewer, and nor do project skills,
  prompts, themes or `.pi/APPEND_SYSTEM.md`. Recommended: take it. The harness
  already withholds project extensions, and a tree that could name the model
  reviewing it could name a blind one.

  2026-10-05: settled as recommended. § 4 The `pi` adapter passes
  `--no-approve`, and none of the project's `pi` settings applies.

## Reference

`SettingsManager.create(cwd, agentDir, { projectTrusted })` resolves the global
settings to `<agentDir>/settings.json` and the project's to
`<cwd>/.pi/settings.json`, and holds `deepMergeSettings(global, project)`. The
merge recurses into plain objects and replaces everything else, so one string key
replaces the other.

Driven through `SettingsManager` with a project `defaultModel` of
`a-model-the-tree-chose`, the model `pi` would review with was the tree's where
`projectTrusted` was `true`, and the user's own where it was `false`.

`--no-approve` and `-na` set the trust override false; `--approve` and `-a` set it
true. `pi`'s own parser reads either spelling with no diagnostics and does not
take it for an extension flag.

Trust is resolved in this order, and the first answer wins: the command-line
override; then `true` where nothing under `.pi/` requires trust; then a
subscribed extension's answer; then the trust store; then
`defaultProjectTrust`, where `always` is `true` and `never` is `false`; then
`false` where there is no interactive UI; then the prompt.

What requires trust is any of `settings.json`, `extensions`, `skills`, `prompts`,
`themes`, `SYSTEM.md` or `APPEND_SYSTEM.md` under the project's `.pi/`.

The trust store is `trust.json` in the agent directory, keyed by canonical
absolute path. The nearest entry walking upward wins, so a decision saved against
any ancestor of a worktree decides for the worktree. The round leaves
`PI_CODING_AGENT_DIR` as the user has it, so the user's own trust decisions are
in force in a round wherever the command line does not override them.

## Limits

- **One machine, one `pi`.** macOS 26.6.2 and `pi` 0.85.1.

- **No model ran.** The settings manager is the installed `pi`'s own, driven
  directly. That `pi --print` passes its parsed trust override
  through to the settings manager is read from the installed `main.js` rather than
  measured in a round.

- **Nothing was measured about a project `.pi/` holding more than
  `settings.json`.** What such a directory requires trust for is read from the
  installed code.
