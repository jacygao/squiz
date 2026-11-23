---
settles: "§ 5: the command line and environment that keep a tree under review from configuring a Copilot reviewer"
issue: 458
recorded: 2026-10-06
versions: { copilot: 1.0.91, models: "gpt-5-mini, gpt-6-astra", macos: 26.6.2 }
recheck-when: Copilot CLI upgrades past 1.0.91, or changes how folder trust is decided or what it gates
---

# A project Copilot trusts runs its hooks and MCP servers

## Intent

- Whether a project's Copilot instructions, skills, hooks, settings or MCP
  servers reach the reviewer.
- The flags and environment that keep them out, as `--no-approve` does for
  `pi`.
- Whether the user's own Copilot configuration applies to a review.

## Decisions

- **Run Copilot with a `COPILOT_HOME` the round owns, holding no trusted
  folders.** Copilot runs a project's hooks and starts its MCP servers only in a
  folder it trusts. It trusts a folder listed in `trustedFolders` or below one
  that is, so a user who trusted any folder above the snapshots has trusted
  every one of them. Below a trusted folder, planted hooks ran and a planted MCP
  server started. Under an empty `COPILOT_HOME`, neither happened.
- **Set `COPILOT_ALLOW_ALL` to the empty string in the reviewer's environment.**
  Set to exactly `true`, it trusts the working directory whatever `COPILOT_HOME`
  holds, and the project's MCP server was listed again. Empty, it trusts
  nothing, and it replaces a `true` that a pane's server environment carries.
- **Pass `--no-custom-instructions`.** `AGENTS.md`,
  `.github/copilot-instructions.md` and `.github/instructions/*.instructions.md`
  load in a folder Copilot does not trust, and reached the model as a
  `custom_instructions` part of the system prompt. With the flag that part was
  gone.
- **Grant tools with `--available-tools`, and leave `skill` out.** Project
  skills load untrusted too, from `.github/skills/` and `.claude/skills/`, and
  the model called one. With `skill` outside the grant the tool is disabled.
- **Pass `--disable-builtin-mcps`**, so the GitHub MCP server is not started for
  a reviewer that has no GitHub access of its own.
- **Drop the user's own Copilot configuration from a review, except the default
  model.** A round-owned `COPILOT_HOME` drops the user's hooks, MCP servers,
  skills and `effortLevel`. The round sets the model and reasoning effort on the
  command line, taking the user's default model from their own `settings.json`
  where the project configures none (§ 5 The Copilot adapter).

## Needs your input

Nothing.

## Reference

What reached a run in a planted repository. "Ancestor-trusted" and "empty
`COPILOT_HOME`" both ran with `--no-custom-instructions`,
`--available-tools=view,grep,glob[,<reporting tool>]` and
`--disable-builtin-mcps`.

| Planted | Untrusted, `-p`, no flags | `COPILOT_ALLOW_ALL=true` | Ancestor-trusted | Empty `COPILOT_HOME` |
|---|---|---|---|---|
| `AGENTS.md`, `.github/copilot-instructions.md`, `.github/instructions/` | seen | seen | not seen | not seen |
| `.github/skills/`, `.claude/skills/` | seen, and called | `skill` granted | `skill` disabled | `skill` disabled |
| `.github/hooks/*.json` hook | did not run | ran | **ran** | did not run |
| hook in `.github/copilot/settings.json` | did not run | ran | **ran** | did not run |
| `.mcp.json` server | not started | started, called | **started**, tool hidden | not started |
| `.github/mcp.json` server | not started | not started | not started | not started |

- **`--available-tools` hides a project MCP server's tools and still starts the
  server.** Its process ran, and was sent `initialize` and `tools/list`.
- **`--disable-mcp-server <name>` needs the server's name**, which the tree under
  review chooses, so it cannot close the gap.
- **`disableAllHooks: true` in `<COPILOT_HOME>/settings.json` did not stop a
  trusted project's hooks.**
- **`model` in `.github/copilot/settings.json` is not used.** With no `--model`,
  the user's model won over a trusted project's.
- **`copilot mcp list` is a cheap check of trust.** It lists `Workspace servers`
  only where the directory is trusted, and makes no model call.
  `copilot instruction list` and `copilot skill list` list what a directory
  offers whether it is trusted or not.
- **Under `COPILOT_HOME`, Copilot writes** `config.json`, `session-state/` and
  `session-store.db`.
- **A reporting tool's name under `--available-tools` is
  `<server name>-<tool name>`**, as in `squiz-report_finding`. The built-in grep
  tool was listed as `grep` under `gpt-5-mini` and as `rg` under `gpt-6-astra`
  for the same `--available-tools=view,grep,glob`.

## Limits

- **The ancestor-trust case was measured once**, under a `trustedFolders` entry
  for the main checkout, with the snapshot inside the project. The snapshot is
  now in the system's temporary directory, and that trust above it works the same
  way there is *(unverified)*.
- **Why `.github/mcp.json` never loaded** was not established, though
  `copilot mcp --help` names it as a workspace source.
- **Plugins, custom agents (`.github/agents/`) and LSP configuration in the tree
  were not planted.**
- **Instructions were judged absent from the system prompt's segment list**, not
  from the model's answer.
