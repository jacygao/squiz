---
settles: "§ 4 — the GitHub variables the round sets for the reviewer, what they leave reachable, and how a pane's variables survive the shell's startup files"
issue: 548
recorded: 2026-10-06
versions: { gh: 2.97.0, copilot: 1.0.92, herdr: "private server, as installed", tmux: 3.7b, macos: 26.6.2 }
recheck-when: gh changes how it finds a token, Copilot CLI upgrades past 1.0.92 or changes where it keeps its login, or a pane backend changes how it starts its shell
---

# An empty `gh` config leaves `gh` no login, but `gh auth token` reads the keychain

## Intent

- Whether empty token variables and an empty `GH_CONFIG_DIR` leave a `gh` the
  reviewer starts with no login.
- Whether Copilot still signs in to its model under them.
- Whether a variable passed with Herdr's `--env` or tmux's `-e` reaches the
  command as given.

## Decisions

- **Set `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` and
  `GITHUB_ENTERPRISE_TOKEN` to the empty string, and point `GH_CONFIG_DIR` at an
  emptied directory of the round's own.** `gh` reads an empty token variable as
  none, and with no `hosts.yml` it finds no login: `gh auth status` exits 1, and
  `gh api user` and `gh pr list` exit 4.
- **Leave the system's credential store alone, and say it stays readable.** On
  macOS `gh auth token` still printed the user's 40-character login from the
  keychain under the same environment, exit 0. `gh` has no variable that turns
  its keyring off, and it calls `/usr/bin/security` by absolute path. Copilot
  signed in under the same environment, so its login is not in a variable or
  in `gh`'s configuration, and closing the store would close it to Copilot too.
- **Set every variable on the command line as well, with `/usr/bin/env`.** A
  pane's shell runs the person's startup files after `--env` or `-e` has set a
  variable, and a value set there replaced the one given in both backends.

## Needs your input

Nothing.

## Reference

What each command did under `GH_TOKEN= GITHUB_TOKEN= GH_ENTERPRISE_TOKEN=
GITHUB_ENTERPRISE_TOKEN= GH_CONFIG_DIR=<empty directory>`, with the user logged
in to `gh` through the keychain:

| Command | Exit | Output |
|---|---|---|
| `gh auth status` | 1 | `You are not logged into any GitHub hosts. To log in, run: gh auth login` |
| `gh api user --jq .login` | 4 | `To get started with GitHub CLI, please run:  gh auth login` |
| `gh auth token` | 0 | the user's token |
| `copilot -p … ` under a fresh `COPILOT_HOME` | 0 | answered, one request, 0.07 AI credits |

`GH_CONFIG_DIR` pointing at a directory holding a `hosts.yml` with an
`oauth_token` makes `gh auth token` print that token, and a non-empty `GH_TOKEN`
wins over both.

The startup files that overrode a given variable: a `.zshenv` running
`export SESSION_MARK=…`. In a Herdr pane the shell is interactive and reads it.
In tmux, `new-window` runs its command through the default shell's `-c`, and zsh
reads `.zshenv` for that too.

## Limits

- `gh auth token`'s keychain read was seen on macOS only. On Linux `gh` reads
  the Secret Service over D-Bus, which was not run.
- Copilot was signed in through the keychain. A user signed in through
  `COPILOT_GITHUB_TOKEN` alone was not run, and one signed in through `GH_TOKEN`
  alone would have no model credential under these variables.
- Copilot signed in with `gh`'s keychain entry, which it reads by running
  `gh auth token`; this machine has no Copilot login of its own. A user signed
  in through Copilot's own `/login` was not run.
