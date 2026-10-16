# 9. Adoption

## Installing

Squiz is a plugin for Claude Code and for Copilot, and this repository is its
marketplace for both. `.claude-plugin/marketplace.json` names the marketplace
`squiz` and lists one plugin, squiz, whose source is the repository's own root.

Into Claude Code:

```
/plugin marketplace add jacygao/squiz
/plugin install squiz@squiz
```

Into Copilot:

```
copilot plugin marketplace add jacygao/squiz
copilot plugin install squiz@squiz
```

Each runtime keeps a copy of its own, and runs the hooks from it:

- **Claude Code** copies the repository into
  `plugins/cache/squiz/squiz/<version>/` under its configuration directory,
  where the version is the one `plugin.json` carries. The marketplace entry
  carries the same version, and `src/plugin.test.ts` fails where the two
  differ.
- **Copilot** copies it into `<COPILOT_HOME>/installed-plugins/squiz/squiz/`,
  and runs the extension from there too. `copilot plugin update squiz` replaces
  the copy in place, so the path does not change.

A person who installs squiz into both updates both, so that the two copies are
one version. `squiz doctor` warns where they are not ([§ 6 The setup check](commands.md#the-setup-check)).

`claude plugin update squiz@squiz` copies the new version into a directory of
its own beside the old one, and Claude Code sessions started afterwards run the
new one. The old version's directory stays, marked orphaned with
`.orphaned_at`. The first Claude Code start once the mark is 14 days old
deletes it.

**After updating squiz in Claude Code, run `squiz init` again,** by typing
`! squiz init` in a Claude Code session started after the update. Until then,
the link `squiz init` made still names the old version, so a Copilot session or
a terminal runs the old squiz while Claude Code's hooks run the new one. Once
the old directory is deleted, the link names nothing, and `squiz` there is
`command not found`. `squiz init` moves the link to the new version ([§ 6
`squiz init`](commands.md#squiz-init)), and `! squiz doctor` warns about the link until it does. The
old squiz run through the link reports it as linked to itself, so only the
squiz Claude Code runs gives the warning.

`/plugin uninstall squiz` removes it from Claude Code. The copied directory
stays, marked orphaned in the same way, until Claude Code deletes it.
`copilot plugin uninstall squiz` removes it from Copilot.

A Copilot session can also load a checkout with `copilot --plugin-dir
<checkout>`, which loads the same hooks and extension from the checkout
itself.

## Getting started

Two things in the host project, the second one optional. Nothing goes in the
project's `.gitignore`: squiz keeps `.squiz/`, where it writes each episode's
state, out of git itself ([§ 3 The state file](loop.md#the-state-file)).

1. Allow `squiz` in the project's Claude Code permissions, so the coding agent
   is not prompted every time it starts a round or works a thread.
2. **Optional.** `.squiz.json`, to change any of the settings below. Every one
   has a working default, so a project that writes none still runs.

Then check the setup with `squiz doctor` ([§ 6 The setup check](commands.md#the-setup-check)), from the
repository. In a Claude Code session, type it after `!`:

```
! squiz doctor
```

Elsewhere, run `squiz doctor` in a shell once `squiz init` has linked it.

**A Claude Code or Copilot coding agent needs no instruction to start a review.**
The plugin's hooks start one each time the agent finishes its work, and the
session that owns the work is woken with the result, which names
`squiz review` ([§ 3 The report](loop.md#the-report)). Nothing goes in the project's `AGENTS.md` for
this. A `## Review` section that an earlier `squiz init` added there is left as
it is, and the project may delete it.

**Every Copilot session of a user who installed squiz loads it,** with its
hooks, and with its extension where experimental features are on, as below.
Copilot does not put the plugin's `bin/` on its
shell's `PATH`, so `squiz init` links `squiz` into a directory already on it,
once on each machine.

**Squiz's Copilot support is experimental, because it relies on Copilot's
experimental features.** Squiz wakes an idle Copilot session through an
extension the plugin ships, and Copilot loads extensions only with experimental
features on. Setting up Copilot includes turning them on once, for the user, by
either of:

```
copilot --experimental
```

```
/experimental on
```

Each writes `"experimental": true` to `<COPILOT_HOME>/settings.json`, and every
later session of that user starts with experimental features on, with or without
the flag. `copilot --no-experimental` writes `false`, which turns them off for
every later session. The same key in a repository's
`.github/copilot/settings.json` turns nothing on. Experimental features turn on
more than extensions, for every session of that user; `/experimental show`
lists them. A Copilot session without them is unsupported. Its reviews still
run, and it learns the result only from a `squiz review` it runs itself.

The socket's path, `<COPILOT_HOME>/session-state/<session id>/squiz.sock`, must
fit in the 104 bytes macOS allows a socket path, and the 108 Linux allows. The
default `~/.copilot` fits under a home directory of up to 33 characters on macOS
and 37 on Linux. Under a longer `COPILOT_HOME` the extension cannot listen, and
it says so in the session as a warning.

**Any other coding agent reaches `squiz` through a link `squiz init` makes,**
because no runtime but Claude Code puts the plugin's `bin/` on its shell's
`PATH`. Run `squiz init` once on each machine. Where Claude Code has squiz
enabled, type `! squiz init` in a Claude Code session, so that every agent runs
the squiz Claude Code uses. Where only Copilot has it, run it by path from
Copilot's copy:

```
<COPILOT_HOME>/installed-plugins/squiz/squiz/bin/squiz init
```

It links `~/.local/bin/squiz`, or `~/bin/squiz`, to that plugin's `bin/squiz`,
and makes no link where a `squiz` that is not this one is already on `PATH`
([§ 6 `squiz init`](commands.md#squiz-init)). A Copilot session then runs `squiz` by name.

`AGENTS.md` carries the conventions a reviewer cannot derive from reading
code, and it can point at whatever else the project treats as authoritative. The
reviewer reads it for those. Without them the review still finds correctness
bugs, security problems and tests that assert nothing, and reports no convention
violations.

A project that runs coding agents in parallel gives each one its own worktree on
its own branch. Squiz does not create them, and does not remove them.

## Configuration

`.squiz.json`, at the root of the repository.

| Setting | Default | |
|---|---|---|
| `reviewer` | `pi` | The reviewer CLI, `pi` or `copilot` |
| `rounds` | 3 | The round cap, settable 1 to 8 |
| `timeout` | 900 | Seconds one round's reviewer may run, settable 60 to 3,600 |
| `tokens` | 10,000,000 | Tokens one round may spend, settable 100,000 to 10,000,000 |
| `thinking` | `medium` | How hard the reviewer thinks, one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `model` | none | The model the reviewer runs on, in its CLI's spelling: `provider/id` for `pi`, such as `openai/gpt-5-mini`, and the model's name for Copilot, such as `gpt-5-mini`. None runs the reviewer on the user's own default ([§ 4 Adapters](adapters.md)) |

`timeout` is the time bound on the review part of a round, which runs in the
round host. No caller's timeout limits it, so it is a guard against a reviewer
that runs away rather than a fit to a window.

`model` is up to 200 letters, digits and `.` `_` `:` `/` `@` `+` `-`, starting
with a letter, a digit or `@`. An empty string is refused rather than read as
none. A model the configured reviewer does not offer fails the round at setup,
and never runs it on another model.

`reviewer` chooses the adapter, and nothing else changes with it. `copilot`
needs the GitHub Copilot CLI installed and signed in.

A setting outside its range, or of a type the table does not give it, is
rejected with an error naming the setting, the value given and what was
expected. A key the table does not name is rejected the same way, with an error
saying it is not a setting and listing the settings there are. A `.squiz.json`
that cannot be read or parsed is a failure the harness controls, so the command
exits 1 and its stderr names it.
