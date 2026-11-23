---
settles: "§ 5 Tools: how a Copilot reviewer started from a Copilot run's hook signs in; § 10: copilotTokenFile"
issue: 895
recorded: 2026-11-15
versions: { copilot: 1.0.112, node: 24.15.0, macos: 26.6.2 }
recheck-when: Copilot CLI changes the environment it gives its hooks
---

# Copilot keeps `COPILOT_GITHUB_TOKEN` and `GITHUB_TOKEN` from its hooks

## Intent

- Whether a token in `copilot -p`'s environment reaches the processes its hooks start.
- How a reviewer that squiz starts from such a hook can sign in.

## Decisions

- **Sign the reviewer in from a file, the `copilotTokenFile` that `.squiz.json`
  names or else `~/.config/squiz/copilot-token`, never from a variable.**
  Copilot leaves `COPILOT_GITHUB_TOKEN` out of its hooks' environment, so the
  round host a hook starts never has it, and a later Copilot could leave out any
  other variable name the same way.
- **Read the token in the reviewer's own shell line.** It then reaches only that
  Copilot's environment, and a pane's line and `ps` show the file's path rather
  than the token.

## Needs your input

Nothing.

## Reference

What a plugin's `SessionStart` hook saw of variables set in `copilot -p`'s
environment:

| Set in `copilot -p`'s environment | In the hook's |
|---|---|
| `COPILOT_GITHUB_TOKEN` | No |
| `GITHUB_TOKEN` | No |
| `GH_TOKEN` | Yes, with its value |
| `SQUIZ_COPILOT_TOKEN`, `MY_SECRET`, `PLAIN_VAR` | Yes |

Copilot adds `COPILOT_HOOK_DIR`, `COPILOT_PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT`,
`COPILOT_PROJECT_DIR`, and `GIT_CONFIG_COUNT` with one `safe.directory` entry.

The reviewer's line reads the file as:

```sh
COPILOT_GITHUB_TOKEN=$(tr -d ' \t\r\n' < '<token file>') && export COPILOT_GITHUB_TOKEN && …
```

## Limits

- **Only `SessionStart`'s environment was listed.** That `Stop`'s lacks the
  token too rests on a token-only `copilot -p` run under the local venue whose
  first round failed with `the reviewer is not signed in to Copilot`, and signed
  in once `copilotTokenFile` was set.
- **Linux was not run.** The same sign-in failure was seen on Copilot 1.0.107 on
  Linux, with no listing of its hook's environment.
