---
settles: "§ 5: what keeps a tree under review from configuring `pi`"
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
- Whether a project's own `pi` settings should apply to a review.

## Decisions

- **Put `--no-approve` on the command line, and let none of the project's `pi`
  settings apply.** `pi` reads it as the project being untrusted, and loads an
  untrusted project's `.pi/settings.json` as `{}` rather than merging it over
  the user's global settings. Without it, a tree under review that carries its
  own `.pi/settings.json` could name the model that reviews it, and could name a
  blind one. A trust decision the user saved against any directory above the
  tree would also trust the tree. The cost is that a project's pinned
  `defaultModel` or `retry` block, and its skills, prompts, themes and
  `.pi/APPEND_SYSTEM.md`, no longer reach the reviewer.
- **Write nothing into the tree to change `pi`'s settings.** A
  `<cwd>/.pi/settings.json` is the one other route to them, and the tree is the
  code under review.
- **Do not expect a trust prompt in a round.** A trust override given on the
  command line is returned before anything else is consulted, so no round
  reaches the prompt, the trust store or `defaultProjectTrust`.
- **Do not expect `defaultProjectTrust: "never"` to hold a tree back.** A tree
  with nothing trust-requiring under `.pi/` is trusted without that setting
  being read.

## Needs your input

Nothing.

## Reference

- **Trust is resolved in this order, and the first answer wins:** the
  command-line override; then `true` where nothing under `.pi/` requires trust;
  then a subscribed extension's answer; then the trust store; then
  `defaultProjectTrust`, where `always` is `true` and `never` is `false`; then
  `false` where there is no interactive UI; then the prompt.
- **What requires trust** is any of `settings.json`, `extensions`, `skills`,
  `prompts`, `themes`, `SYSTEM.md` or `APPEND_SYSTEM.md` under the project's
  `.pi/`.
- **The trust store is `trust.json` in the agent directory**, keyed by canonical
  absolute path. The nearest entry walking upward wins. The round leaves
  `PI_CODING_AGENT_DIR` as the user has it, so the user's trust decisions are in
  force wherever the command line does not override them.
- **`--no-approve` and `-na` set the trust override false; `--approve` and `-a`
  set it true.** `pi`'s parser reads either spelling with no diagnostics and
  does not take it for an extension flag.
- **`SettingsManager.create(cwd, agentDir, { projectTrusted })`** resolves the
  global settings to `<agentDir>/settings.json` and the project's to
  `<cwd>/.pi/settings.json`, and holds `deepMergeSettings(global, project)`. The
  merge recurses into plain objects and replaces everything else.

## Limits

- **One machine, one `pi`:** macOS 26.6.2 and `pi` 0.85.1.
- **No model ran.** The installed `pi`'s settings manager was driven directly.
  That `pi --print` passes its parsed trust override to it is read from the
  installed `main.js`, not measured in a round.
- **What a project `.pi/` holding more than `settings.json` requires trust for**
  is read from the installed code, not measured.
