---
settles: "§ 5: how the reporting calls reach the `pi` reviewer, and why no other extension loads"
issue: [11, 165]
recorded: 2026-09-25
versions: { pi: "0.84.2, 0.85.1", node: 24.15.0 }
recheck-when: pi upgrades, or pi changes how --extension and --no-extensions combine
---

# `pi` loads only the named extension under `--no-extensions`

## Intent

- Whether `pi` can be given a reporting call at all, so that a finding is not
  lost when a run is cut short before its last message.
- Whether an extension loads in print mode, when the documented use of
  extensions is the interactive TUI.

## Decisions

- **Register the reporting calls from a file named with `--extension`, and pass
  `--no-extensions` beside it.** The extension loads in print mode, and
  `--no-extensions` stops discovery while leaving the named file loading.
  Without it, an extension installed on the machine or sitting in the tree
  under review can register a tool of the same name and take the round's
  reports, because a later registration replaces an earlier one by name.

## Needs your input

Nothing.

## Reference

The flags, exactly: `--extension <path>` (repeatable, `-e`), and
`--no-extensions` (`-ne`), which stops discovery and leaves explicit paths
loading.

A registered tool is an object with `name`, `label`, `description`,
`parameters` and `execute`, passed to `pi.registerTool` by the module's default
export, which `pi` calls with its extension API. `promptSnippet` puts a one-line
entry in the system prompt's `Available tools`, and `promptGuidelines` appends
bullets to its `Guidelines`, each of which must name its own tool.

## Limits

- **The extension was started without a model.** It wrote what it was given and
  exited during `session_start`. That a reviewer reaches for the calls is
  recorded in `the-reviewer-reports-only-through-its-calls.md`.
