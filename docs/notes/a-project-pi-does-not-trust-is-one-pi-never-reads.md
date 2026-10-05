---
settles: "§ 4 — which settings an installed `pi` resolves for the line every shell runs, and what a tree under review may configure"
issue: 242
recorded: 2026-10-03
versions: { pi: 0.85.1, node: 24.15.0, macos: 26.6.2 }
recheck-when: pi upgrades, or pi's project trust resolution changes
---

# A project pi does not trust is one pi never reads

## Intent

- Which `shellCommandPrefix` an installed `pi` resolves where the tree under
  review has one of its own.
- What decides whether `pi` trusts a tree under review.
- What else a trusted tree under review configures.
- How a round keeps the prefix it wrote effective without writing into the tree.

## Decisions

- **Put `--no-approve` on the command line.** `pi` reads it as the project being
  untrusted, and an untrusted project's `.pi/settings.json` is loaded as `{}`
  rather than merged. Nothing else in `pi`'s configuration can be reached from
  outside the settings files, and the settings `pi` resolves are then the round's
  mirror alone.

- **Resolve the project's own prefix in the adapter, and write the recording line
  in front of it.** `pi` no longer reads the project's file, so a prefix it
  configured runs only if the mirror carries it. The project's value replaces the
  global one rather than adding to it, which is what merging two strings comes to.

- **Do not write `<cwd>/.pi/settings.json`.** It is the one other way to make the
  round's line effective, and the file stands in the worktree under review, where
  the round's own reading of the files hashes untracked paths and reports it as a
  change the round made.

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
  `--no-approve`, and only the project's shell command prefix still applies.

## Reference

`SettingsManager.create(cwd, agentDir, { projectTrusted })` resolves the global
settings to `<agentDir>/settings.json` and the project's to
`<cwd>/.pi/settings.json`, and holds `deepMergeSettings(global, project)`. The
merge recurses into plain objects and replaces everything else, so one string key
replaces the other. `getShellCommandPrefix()` returns the merged value, and
`_buildRuntime` passes it to the bash tool as `commandPrefix`.

Driven through `SettingsManager` and `createBashToolDefinition`, with a global
`shellCommandPrefix` of squiz's recording line and a project one of
`export PROJECT_PREFIX=1`:

```
--- projectTrusted: true ---
  effective prefix carries the recording line: false
  model pi would review with: "a-model-the-tree-chose"
  groups recorded: []
--- projectTrusted: false ---
  effective prefix carries the recording line: true
  model pi would review with: "the-user-model"
  groups recorded: [48267]
```

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
any ancestor of a worktree decides for the worktree. Because the round mirrors the
agent directory by linking every entry, the user's own trust decisions are
reachable from inside a round.

## Limits

- **One machine, one `pi`.** macOS 26.6.2 and `pi` 0.85.1.

- **No model ran.** The settings manager and the bash tool are the installed
  `pi`'s own, driven directly. That `pi --print` passes its parsed trust override
  through to the settings manager is read from the installed `main.js` rather than
  measured in a round.

- **Nothing was measured about a project `.pi/` holding more than
  `settings.json`.** What such a directory requires trust for is read from the
  installed code.
