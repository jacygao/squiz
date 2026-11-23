---
settles: "§ 5: the GitHub variables the round sets for the reviewer, what they leave reachable, and how a pane's variables reach the reviewer"
issue: 548
recorded: 2026-10-06
versions: { gh: 2.97.0, copilot: 1.0.92, herdr: "private server, as installed", tmux: 3.7b, macos: 26.6.2 }
recheck-when: gh changes how it finds a token, Copilot CLI changes where it keeps its login, or a pane backend changes how it starts its command
---

# An empty `gh` config leaves `gh` no login, but `gh auth token` reads the keychain

## Intent

- Whether empty token variables and an empty `GH_CONFIG_DIR` leave a `gh` the
  reviewer starts with no login.
- Whether Copilot still signs in to its model under them.
- Whether a variable passed with Herdr's `env` or tmux's `-e` reaches the
  command as given.

## Decisions

- **Set `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` and
  `GITHUB_ENTERPRISE_TOKEN` to the empty string, and point `GH_CONFIG_DIR` at an
  emptied directory of the round's own.** `gh` reads an empty token variable as
  none, and with no `hosts.yml` it finds no login: `gh auth status` exits 1, and
  `gh api user` and `gh pr list` exit 4.
- **Leave the system's credential store alone, and say it stays readable.** On
  macOS `gh auth token` still printed the user's login from the keychain under
  the same environment, exit 0. `gh` has no variable that turns its keyring off,
  and it calls `/usr/bin/security` by absolute path. Copilot signed in under the
  same environment by running `gh auth token`, so closing the store would close
  it to Copilot too.
- **Start the reviewer with no shell between the backend and its command.** A
  shell that reads the person's startup files runs them after `env` or `-e` has
  set a variable, and a value set there replaced the one given, in both
  backends. With no such shell, the value given is the value the command gets.

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
| `copilot -p …` under a fresh `COPILOT_HOME` | 0 | answered |

A `GH_CONFIG_DIR` holding a `hosts.yml` with an `oauth_token` makes
`gh auth token` print that token, and a non-empty `GH_TOKEN` wins over both.

The startup file that overrode a variable was a `.zshenv` running `export`. A
Herdr pane's default shell is interactive and reads it. tmux's `new-window` runs
a one-word command through the default shell's `-c`, and zsh reads `.zshenv`
for that too.

## Limits

- **`gh auth token`'s keychain read was seen on macOS only.** On Linux `gh`
  reads the Secret Service over D-Bus, which was not run.
- **Copilot was signed in through `gh`'s keychain entry only.** A user signed in
  through `COPILOT_GITHUB_TOKEN` alone, or through Copilot's own `/login`, was
  not run. One signed in through `GH_TOKEN` alone would have no model credential
  under these variables.
- **That a command started with no shell keeps its variables** was not run here
  (unverified in this note).
