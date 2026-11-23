---
settles: "§ 7 and § 10: whether `squiz` resolves by name in a Claude Code session's Bash tool, under `--plugin-dir` and under a marketplace install"
issue: [39, 54]
recorded: 2026-10-01
versions: { claude-code: "2.1.263 and 2.1.285", node: 24.15.0 }
recheck-when: Claude Code changes how a plugin's bin/ reaches PATH
---

# Claude Code puts the plugin's `bin/` on the Bash tool's `PATH`

## Intent

- Whether the coding agent's `squiz threads` and `squiz reply` find the binary
  by name in Claude Code's Bash tool.
- Whether a marketplace install does what `--plugin-dir` does.

## Decisions

- **Let a Claude Code coding agent run `squiz` by name, under `--plugin-dir` and
  under an install alike.** In both, `command -v squiz` in the Bash tool
  resolved to the plugin's own `bin/squiz`. Under the install it sat 16th on
  `PATH`, after the user's own entries. What this establishes is the lookup of
  `squiz` itself, not which commands it dispatches. The hook does not get this
  `PATH`, which `the-hook-shell-does-not-get-the-plugin-bin-on-path.md` records.

## Needs your input

Nothing.

## Reference

An install from the repository needs no interactive session. The marketplace
takes a path, so the repository is its own marketplace:

```
claude plugin marketplace add <repository> --scope local
claude plugin install squiz@<marketplace> --scope local
```

Both want a `.claude-plugin/marketplace.json` naming the plugin with
`"source": "./"`. `claude plugin list` reads the install back, and
`claude plugin uninstall` and `claude plugin marketplace remove` undo it.

## Limits

- **The install was from a directory, not a git host.** A remote marketplace
  copies the plugin elsewhere, and the entry would be that copy's `bin/`. What
  was established is that an install puts the plugin's `bin/` on the Bash tool's
  `PATH`, not the literal path.
- **Only `local` scope was tried.**
- **Copilot was not measured here.** It leaves `bin/` off `PATH`, which
  `copilot-leaves-a-loaded-plugins-bin-off-path.md` records.
- **One machine, print mode, `claude-sonnet-5`.**
