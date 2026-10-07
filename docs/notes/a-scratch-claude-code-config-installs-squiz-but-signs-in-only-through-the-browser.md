---
settles: "§ 9 — whether the README's Claude Code install, run from a shell, works into a config of its own, and what `squiz doctor` prints for the install it makes; M9 — what a live run of Claude Code needs before it can start"
issue: 658
recorded: 2026-10-07
versions: { claude-code: 2.1.292, squiz: b93d487, plugin-version: 0.1.0, copilot: 1.0.92, node: 24.15.0, gh: 2.97.0, tmux: 3.7b, herdr: 0.9.3 }
recheck-when: Claude Code changes `claude auth login`, how `CLAUDE_CONFIG_DIR` keeps a sign-in, or where `claude plugin install` puts a plugin; or `squiz doctor` changes a line
---

# A scratch Claude Code config installs squiz from the marketplace, but signs in only through the browser

The README's two shell commands installed squiz into a config made with
`CLAUDE_CONFIG_DIR`, and the installed squiz's `squiz doctor` passed every line.
No Claude Code session ran in that config, because it starts signed out and
only a person at a browser can sign it in. The reviewed pull requests #658 asks
for were therefore not made.

## Intent

- Whether a config of its own can stand in for `~/.claude` in a live run.
- Whether `claude plugin marketplace add jacygao/squiz` and
  `claude plugin install squiz@squiz` work into that config, and what they
  install.
- What `squiz doctor` prints from that install in a project whose `.squiz.json`
  names Copilot.

## Decisions

- **Have the owner sign a scratch config in before a live run of Claude Code.**
  A fresh `CLAUDE_CONFIG_DIR` is signed out, and `claude auth login` and
  `claude setup-token` both wait for a code from a browser sign-in. An agent
  given no API key cannot start a session there, and the only other config is
  the owner's own. #681 holds what the owner must run.
- **Install with the README's two shell commands; they need no session and no
  sign-in.** Both exited 0 in the signed-out config, and the plugin they
  installed is the commit `main` was on.
- **Read the `Reviewer` line as `squiz doctor`'s check of the reviewer.** It
  named Copilot, its version and its model. The README said doctor did not yet
  check the reviewer, and now shows the line.

## Needs your input

- **#681: sign the scratch config in.** Recommended: run the two commands it
  gives, then pick #658 up again from the install, which takes a minute.

## Reference

### Signing in

With `CLAUDE_CONFIG_DIR` set to an empty directory, and every `CLAUDE*`
variable of the calling session unset:

- `claude auth status` printed `"loggedIn": false` and `"authMethod": "none"`.
- `claude auth login`, with `BROWSER=/usr/bin/true`, printed `Opening browser to
  sign in…`, a `https://claude.com/cai/oauth/authorize?...` URL whose redirect
  is `https://platform.claude.com/oauth/code/callback`, and
  `Paste code here if prompted >`, then waited.
- No `ANTHROPIC_API_KEY` was set.

### The install

- `claude plugin marketplace add jacygao/squiz` printed `Cloning via SSH:
  git@github.com:jacygao/squiz.git` and `✔ Successfully added marketplace: squiz
  (declared in user settings)`.
- `claude plugin install squiz@squiz` printed `✔ Successfully installed plugin:
  squiz@squiz (scope: user)`.
- `<config>/plugins/installed_plugins.json` records `"version": "0.1.0"`,
  `"gitCommitSha": "b93d487b0977f7bce6896d488946abe913ab412a"` and
  `"installPath": "<config>/plugins/cache/squiz/squiz/0.1.0"`. The squiz a
  session runs is `<installPath>/bin/squiz`.

### What `squiz doctor` printed

In a clone of the scratch repository `jacygao/greet-cli`, with
`{ "reviewer": "copilot" }` in `.squiz.json`, and `PATH` holding
`<installPath>/bin` and no other squiz, as a session's shell would:

```
git 2.54.0
gh 2.97.0, signed in as jacygao
Claude Code 2.1.292
Node 24.15.0
tmux 3.7b
Herdr 0.9.3
squiz link: none on PATH. Not required in Claude Code, whose own shell runs squiz; for another coding agent, run squiz init
Reviewer copilot 1.0.92, model gpt-6-astra, Copilot's default. Its sign-in is not checked
```

It exited 0.

### The trap in running it from an agent

A shell started by a session that loads squiz with `--plugin-dir` carries that
plugin's `bin/` on `PATH`. Doctor run from there printed `squiz link: warning:
/Users/jacy/Documents/Dev/squiz-plugin/bin is another squiz's bin/ on PATH`.
Take that directory off `PATH` before running the installed squiz, or the check
is of the wrong one.

## Limits

- **Doctor was run by path, not typed after `!`.** The README says to type
  `! squiz doctor` in a session, and no session could start. `PATH` was set by
  hand to what a session's shell holds, which was not observed.
- **Nothing a session does was seen.** No hook fired, no review ran, no pull
  request was opened, and neither the subagent case nor the main session's wake
  was reached. `! squiz init` and the `.claude/settings.json` step were not
  tried.
- **The scratch repository was not new.** `jacygao/greet-cli` already lists
  `.squiz/` in its `.gitignore`, so the README's first project step was not
  exercised either.
- **The marketplace was cloned over SSH**, with the owner's key. A user with no
  SSH key on GitHub was not tried.
