---
settles: "§ 4 — what of a tree under review reaches a Copilot reviewer, and the command line and environment that keep it out"
issue: 458
recorded: 2026-10-06
versions: { copilot: 1.0.91, models: "gpt-5-mini, gpt-6-astra", macos: 26.6.2 }
recheck-when: Copilot CLI upgrades past 1.0.91, or changes how folder trust is decided or what it gates
---

# A project Copilot trusts runs its hooks and MCP servers

## Intent

- Whether a project's Copilot instructions, skills, hooks, settings or MCP
  servers reach the reviewer.
- The flags that keep them out, as `--no-approve` does for `pi`.

## Decisions

- **Run Copilot with a `COPILOT_HOME` the adapter owns, holding no trusted
  folders.** Copilot runs a project's hooks and starts its MCP servers only in a
  folder it trusts. It trusts a folder that is listed in `trustedFolders`, or
  that sits below one that is, so a user who trusted any folder above the
  snapshots has trusted every one of them. When this was measured the snapshot
  sat inside the project, at `.squiz/<number>/rounds/<k>/tree`, and below this
  user's trusted checkout both planted hooks ran and the planted MCP server
  started. The snapshot is now in the temporary directory, and the rule holds
  for whatever folder above it a user trusts. With `COPILOT_HOME`
  pointing at an empty directory, neither happened, and the run still
  authenticated, because Copilot signed in with `gh`'s login, which it reads by
  running `gh auth token` and which is not kept in `COPILOT_HOME`.
- **Set `COPILOT_ALLOW_ALL` to the empty string in the reviewer's environment.**
  Set to exactly `true`, it trusts the working directory whatever `COPILOT_HOME`
  holds. Empty, it trusts nothing, and it replaces a `true` a pane's server
  environment carries, as
  `copilot-under-sh-takes-the-adapters-model-trust-and-group.md` records. That
  was measured with an empty `COPILOT_HOME`: the project's MCP server was
  listed again.
- **Pass `--no-custom-instructions`.** It is what keeps out `AGENTS.md`,
  `.github/copilot-instructions.md` and `.github/instructions/*.instructions.md`,
  which load in a folder Copilot does not trust. Without it they reached the
  model as a `custom_instructions` part of the system prompt. With it that part
  was gone.
- **Grant tools with `--available-tools`, and leave `skill` out.** Project skills
  load untrusted as well, from `.github/skills/` and `.claude/skills/`, and the
  model called one. With `skill` outside the grant the tool is disabled, and no
  skill was seen.
- **Pass `--disable-builtin-mcps`**, so the GitHub MCP server is not started for
  a reviewer that has no GitHub access of its own.

## Needs your input

- **Whether a user's own Copilot configuration should stop applying to a
  review.** An adapter-owned `COPILOT_HOME` drops it all: the user's model,
  `effortLevel`, hooks (this machine's user hook is a Herdr state reporter),
  MCP servers and skills. Recommended: take it, as `pi`'s adapter takes
  `--no-approve`. The harness sets the model and the reasoning effort on the
  command line every round anyway, and a user's MCP server is code that runs
  with the round's environment.

  2026-10-07: settled as recommended, except the model. The adapter reads the
  user's default model from the user's own `settings.json` and passes it as
  `COPILOT_MODEL` where the project configures none (§ 4 The Copilot adapter).

## Reference

What reached a run in a planted repository, by how it was started. "Started"
and "ran" are read from files the planted server and hooks wrote; "seen" is the
system prompt's segments and the tool list the run reported.

| | Untrusted, `-p` | Trusted (`COPILOT_ALLOW_ALL=true`) | Trusted by an ancestor, with the flags below | Empty `COPILOT_HOME`, with the flags below |
|---|---|---|---|---|
| `AGENTS.md`, `.github/copilot-instructions.md`, `.github/instructions/` | seen | seen | not seen | not seen |
| `.github/skills/`, `.claude/skills/` | seen, and called | `skill` granted | `skill` disabled | `skill` disabled |
| `.github/hooks/*.json` hook | did not run | ran | **ran** | did not run |
| hook in `.github/copilot/settings.json` | did not run | ran | **ran** | did not run |
| `.mcp.json` server | not started | started, called | **started**, tool hidden | not started |
| `.github/mcp.json` server | not started | not started | not started | not started |

The flags in the last two columns were `--no-custom-instructions`
`--available-tools=view,grep,glob[,<reporting tool>]` `--disable-builtin-mcps`.
`--available-tools` hides a project MCP server's tools from the model, and the
server is still started: its process ran, and was sent `initialize` and
`tools/list`.

`--disable-mcp-server <name>` kept a trusted project's `.mcp.json` server from
starting. It needs the server's name, which the tree under review chooses.

`disableAllHooks: true` in `<COPILOT_HOME>/settings.json` did not stop a trusted
project's hooks: both ran in a pane run that carried it.

`model` in `.github/copilot/settings.json` was not used. With no `--model`, a
trusted project's `gpt-5.4-mini` lost to the user's `gpt-6-astra`.

`copilot mcp list`, run in a directory, lists `Workspace servers` only where
that directory is trusted. It makes no model call, so it is a cheap check of
trust. `copilot instruction list` and `copilot skill list` list what a
directory offers whether it is trusted or not.

Under `COPILOT_HOME`, Copilot writes `config.json`, `session-state/` and
`session-store.db` into that directory.

The reporting tool's name under `--available-tools` is
`<server name>-<tool name>`, as in `probe-report_finding`. The built-in grep
tool was listed as `grep` under `gpt-5-mini` and as `rg` under `gpt-6-astra`
for the same `--available-tools=view,grep,glob`.

## Limits

- The ancestor-trust case was measured once, on this machine, under a
  `trustedFolders` entry for the main checkout.
- `.github/mcp.json` never loaded, trusted or not, though `copilot mcp --help`
  names it as a workspace source. Why was not established.
- Plugins, custom agents (`.github/agents/`) and LSP configuration in the tree
  were not planted.
- Instructions were judged absent from the system prompt's segment list, not
  from the model's answer. `gpt-6-astra` refused to list what its instructions
  said.
