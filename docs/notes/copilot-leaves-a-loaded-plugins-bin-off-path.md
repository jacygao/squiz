---
settles: "§ 7 The squiz binary and squiz init: how `squiz` reaches a Copilot session's shell"
issue: [534, 553]
recorded: 2026-10-06
versions: { copilot: 1.0.92, model: gpt-5-mini, node: 24.15.0, macos: 26.6.2 }
recheck-when: Copilot CLI upgrades past 1.0.92, or changes how it reads a plugin's manifest or bin/
---

# Copilot leaves a loaded plugin's `bin/` off `PATH`

## Intent

- Whether a shell call in a Copilot session with squiz's plugin loaded runs
  `squiz` by name.
- Where it does not, what Copilot offers in place of Claude Code's `bin/`.

## Decisions

- **Put `squiz` on a Copilot shell's `PATH` through the link `squiz init`
  makes.** Copilot does not add a plugin's `bin/` to `PATH`: the shell saw
  exactly the `PATH` Copilot was started with, and `squiz` was
  `command not found`, exit 127, with the plugin loaded. Copilot's help, its
  plugin reference and its changelog name no `bin/` directory and no manifest
  field or setting that adds one, so nothing in the plugin can do it instead.
- **Make the one link serve every coding agent on the machine.** The owner chose
  the link over naming the binary by path, on the condition that two coding
  agents on one machine never run different squizzes, so `squiz review` and
  `squiz reply` keep the same names under both runtimes. § 7 `squiz init` says
  which directory and which conflicts.

## Needs your input

Nothing.

## Reference

The plugin had loaded: `copilot --plugin-dir <checkout> plugin list` listed
`squiz (v0.1.0)`, and the debug log (`--log-dir <dir> --log-level debug`)
recorded `Plugins loaded: ["squiz"]`. Without `--plugin-dir` nothing was listed.
A missing `squiz` is therefore not a failed load.

The hook is unaffected: it is registered as `"${CLAUDE_PLUGIN_ROOT}/bin/squiz"
hook`, and Copilot sets `CLAUDE_PLUGIN_ROOT`, `COPILOT_PLUGIN_ROOT` and
`PLUGIN_ROOT` to the plugin root for it.

## Limits

- **One machine, one model, `-p` only.**
- **That no `bin/` mechanism exists was read from Copilot's help, its online
  plugin reference and its changelog**, not from its source.
