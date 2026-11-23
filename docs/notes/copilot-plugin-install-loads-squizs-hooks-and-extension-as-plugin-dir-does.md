---
settles: "§ 3 The hooks and The report: whether an installed plugin gives Copilot the hooks and the wake extension; § 10 Installing: how a Copilot user installs squiz and runs squiz init without Claude Code"
issue: 602
recorded: 2026-10-07
versions: { copilot: 1.0.92, models: "gpt-5-mini (session), claude-sonnet-5 and gpt-6-astra (reviewer)", node: 24.15.0, macos: 26.6.2 }
recheck-when: Copilot CLI upgrades past 1.0.92, drops direct installs, changes where it keeps installed plugins, or changes how it reads `.claude-plugin/marketplace.json`
---

# `copilot plugin install` loads squiz's hooks and extension as `--plugin-dir` does

## Intent

- Whether an installed plugin fires `hooks/hooks.json`'s `Stop` and
  `SubagentStop`, with the payload `squiz hook` reads.
- Whether it loads the wake extension with experimental features on.
- Whether a session on it is woken when a round ends.
- Where `${CLAUDE_PLUGIN_ROOT}` points under an install, and whether
  `squiz init`'s link and the hook's command still resolve.
- How to tell a hook that did not fire, and an extension that did not load,
  from a session with nothing to do.

## Decisions

- **Publish squiz for Copilot through the same marketplace as Claude Code.**
  Copilot reads `.claude-plugin/marketplace.json` from a GitHub repository.
  `copilot plugin marketplace add jacygao/squiz`, then
  `copilot plugin install squiz@squiz`, puts the plugin at
  `<COPILOT_HOME>/installed-plugins/squiz/squiz`. Copilot calls installs from a
  repository, a URL or a local path deprecated, and says only
  `plugin@marketplace` installs will stay supported.
- **Expect the hooks under every install shape, with nothing to configure.**
  `agentStop` and `subagentStop` fired under all four shapes, each running
  `${CLAUDE_PLUGIN_ROOT}/bin/squiz hook` with Claude Code's payload, as under
  `--plugin-dir`. Folder trust does not apply: a plugin's hooks ran in a
  directory Copilot did not trust.
- **Expect the extension under every install shape, gated on experimental
  features alone.** Every session started with `--experimental` loaded it and
  listened on `squiz.sock`, and was woken through it within 40 milliseconds of
  the round host's post. A session started without the flag loaded none.
- **Have a Copilot user with no Claude Code run `squiz init` by path from
  Copilot's copy.** `${CLAUDE_PLUGIN_ROOT}` is that copy, so the hook already
  runs it. `squiz init` linked `~/.local/bin/squiz` to it, and the session's
  `squiz review` ran the same squiz the hook did.
- **Expect Copilot's copy to drift from the link after an update to one runtime
  only.** Copilot runs its own copy, and the link names whichever install ran
  `squiz init`. `squiz doctor` warns of each copy under
  `<COPILOT_HOME>/installed-plugins/` at another version (§ 7 The setup check).

## Needs your input

Nothing.

## Reference

### The install shapes

| Shape | Command | Where the plugin is | `Plugins loaded:` in the debug log |
|---|---|---|---|
| Local path | `copilot plugin install <path>` | Copied to `installed-plugins/_direct/<directory name>` | `["<path>"]` |
| GitHub repository | `copilot plugin install jacygao/squiz` | Copied to `installed-plugins/_direct/jacygao--squiz` | `["jacygao/squiz"]` |
| Local marketplace | `copilot plugin marketplace add <path>`, then `copilot plugin install squiz@<marketplace>` | Not copied: loaded live from the directory | `["squiz@<marketplace>"]` |
| GitHub marketplace | `copilot plugin marketplace add <owner/repo>`, then `copilot plugin install squiz@<marketplace>` | Copied to `installed-plugins/<marketplace>/squiz` | `["squiz@<marketplace>"]` |

Each path is under `<COPILOT_HOME>`. A direct install prints `Warning: Direct
plugin installs (repos, URLs, local paths) are deprecated. Only
plugin@marketplace installs will be supported in a future release.`
`copilot plugin uninstall squiz` removes the copy.

A copy keeps `bin/squiz` executable, leaves out `.git`, and has no version in
its path. `copilot plugin update squiz` copies the source again into the same
directory, even when it prints `already at latest`, so a link to the copy
survives an update.

`copilot plugin marketplace add` takes `owner/repo`, an `https://` or `ssh://`
git URL, or a local directory, and reads the default branch. A `file://` URL is
read as a relative path and fails. A marketplace on another branch is
registered in `<COPILOT_HOME>/settings.json`:

```json
{ "extraKnownMarketplaces": { "<name>": { "source": { "source": "github", "repo": "<owner/repo>", "ref": "<branch>" } } } }
```

### What the hook gets under an install

- `argv`: `<COPILOT_HOME>/installed-plugins/_direct/<name>/bin/squiz hook`
- working directory: the copy, not the session's directory
- `CLAUDE_PLUGIN_ROOT`, `COPILOT_PLUGIN_ROOT` and `PLUGIN_ROOT`: the copy
- `CLAUDE_PLUGIN_DATA` and `COPILOT_PLUGIN_DATA`:
  `<COPILOT_HOME>/plugin-data/_direct/<hash>`
- `COPILOT_HOME`, `COPILOT_CLI=1`, `COPILOT_PROJECT_DIR` and
  `CLAUDE_PROJECT_DIR`, the last two the session's directory
- stdin, for a sync `explore` subagent: `Stop` with the subagent's id, then
  `SubagentStop` with the parent's id and `agent_id`, then `Stop` with the
  parent's id, all in Claude Code's field names

### Telling a silent failure from nothing to do

**A hook that fired** leaves `hook.start` and `hook.end` events with
`"hookType":"agentStop"` or `"subagentStop"` in
`<COPILOT_HOME>/session-state/<session id>/events.jsonl`. With
`--log-dir <dir> --log-level debug`, what `squiz hook` printed to stderr is in
the debug log:

```
[DEBUG] [rust:hooks] [hook stderr] squiz: nothing was queued: the pull request for "main" could not be looked up: gh exited 1: no git remotes found
```

A hook that queued prints nothing, and leaves `.squiz/<number>/state.json`
with the record's `owner`. No `hook.start` at all, where no other hook is
registered, means the plugin's hooks were not loaded.

**An extension that loaded** leaves, in the debug log:

```
[INFO] Installed 1 native extension(s) for session <session id>
[INFO] prompt mode: loaded 1 extension(s) (mode=load_and_augment)
```

It leaves a socket file, `srwxr-xr-x … squiz.sock`, in the session's state
directory while the session runs. The hook records it as the owner's
`messagingSocket` in `state.json`, and `host.log` ends a round with
`woke its owner through <socket>`. A session started without experimental
features logs neither line, has no socket file, and its owner carries
`sessionId` alone.

A Copilot started from inside Claude Code passes its `CLAUDE*` variables to its
hooks, so a clean check runs without them.

## Limits

- **One machine, one try of each shape, all on 1.0.92.** The live wake ran on
  the local-path and GitHub-marketplace shapes. The other two were seen to fire
  the hooks and load the extension in `-p` runs, and were not woken.
- **The GitHub marketplace session ran on one added through `settings.json`
  with a `ref`.** An install from `jacygao/squiz`'s own manifest with
  `copilot plugin marketplace add` was checked for where the copy lands, and no
  session was run on it.
- **Not tried:** Linux; a Copilot user signed in other than through the macOS
  keychain; a plugin installed while a session is running.
