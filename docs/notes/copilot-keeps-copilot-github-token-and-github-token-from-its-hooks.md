---
settles: "§ 5 — how a Copilot reviewer started from a Copilot run's hook signs in; § 10 — copilotTokenFile"
issue: 895
recorded: 2026-11-15
versions: { copilot: 1.0.112, node: 24.15.0, macos: 26.6.2 }
recheck-when: Copilot CLI changes the environment it gives its hooks
---

# Copilot keeps `COPILOT_GITHUB_TOKEN` and `GITHUB_TOKEN` from its hooks

**2026-11-22:** squiz no longer starts a fixer. The reviewer's sign-in below
still holds, and what it says of the fixer records the fixer as it stood
when this was measured.

## Intent

- Whether a token in `copilot -p`'s environment reaches the processes its hooks start.
- How a reviewer and a fixer that squiz starts from such a hook can sign in.

## Decisions

- **Sign squiz's Copilot processes in from a file `.squiz.json` names, in
  `copilotTokenFile`.** Copilot leaves `COPILOT_GITHUB_TOKEN` out of its hooks'
  environment, so the round host never has it, and any other variable name could
  be left out by a later Copilot the same way.
- **Read the token in the reviewer's own shell line, and into the fixer's
  environment through the start's pipe.** Neither puts it on a command line, so
  a pane's line and `ps` show only the file's path.

## Needs your input

Nothing.

## Reference

A plugin whose `SessionStart` hook ran `env | cut -d= -f1`, under
`copilot -p "Reply with OK." --no-ask-user --experimental --plugin-dir <plugin>`
in `env -i`, with only `HOME`, `PATH` and `COPILOT_HOME` besides these:

| Set in `copilot -p`'s environment | In the hook's |
|---|---|
| `COPILOT_GITHUB_TOKEN` | No |
| `GITHUB_TOKEN` | No |
| `GH_TOKEN` | Yes, with its value |
| `SQUIZ_COPILOT_TOKEN`, `MY_SECRET`, `PLAIN_VAR` | Yes |

The hook's environment also carries `COPILOT_HOOK_DIR`, `COPILOT_PLUGIN_ROOT`,
`CLAUDE_PLUGIN_ROOT`, `COPILOT_PROJECT_DIR` and `GIT_CONFIG_COUNT` with one
`safe.directory` entry, which Copilot adds.

## Limits

- Only `SessionStart`'s environment was dumped. The `Stop` hook's lacks the
  token too: on 0.3.1, a token-only `copilot -p` run under the local venue
  failed its first round with `the reviewer is not signed in to Copilot`, and
  with `copilotTokenFile` the reviewer and the fixer both signed in.
- Linux was not run here. SWE-drill saw the same failure on Copilot 1.0.107 on
  Linux, but its hook environment was not dumped.
