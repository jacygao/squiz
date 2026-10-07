---
settles: "§ 8 — whether an installed plugin gives Copilot the hooks and the extension; § 9 — how a Copilot user installs squiz, and how `squiz init` is run without Claude Code"
issue: 602
recorded: 2026-10-07
versions: { copilot: 1.0.92, models: "gpt-5-mini (session), claude-sonnet-5 and gpt-6-astra (reviewer)", node: 24.15.0, macos: 26.6.2 }
recheck-when: Copilot CLI upgrades past 1.0.92, drops direct installs, changes where it keeps installed plugins, or changes how it reads `.claude-plugin/marketplace.json`
---

# `copilot plugin install` loads squiz's hooks and extension as `--plugin-dir` does

Every way Copilot 1.0.92 installs a plugin gave a session squiz's `Stop` and
`SubagentStop` hooks and its wake extension, with no `--plugin-dir`. The hooks
fired as `agentStop` and `subagentStop` with Claude Code's payload, and the
extension listened on `squiz.sock`. Two live sessions in a scratch repository
each opened a pull request, went idle, and were woken through the socket by
the round host's note within 40 milliseconds of the post. The one on a plugin
installed from a local path worked its two threads to a closed episode with
nothing open. Only the plugin's location changes. Copilot runs the hooks from
its own copy under `<COPILOT_HOME>/installed-plugins/`, and `squiz init` run by
path from that copy links `squiz` to it.

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
  Copilot read `.claude-plugin/marketplace.json` from a GitHub repository and
  installed `squiz@<marketplace>` from it. Once this repository's own manifest
  was on `main`, `copilot plugin marketplace add jacygao/squiz` and
  `copilot plugin install squiz@squiz` put it at
  `<COPILOT_HOME>/installed-plugins/squiz/squiz`. Copilot calls installs from a repository, a
  URL or a local path deprecated, and says only `plugin@marketplace` installs
  will stay supported.
- **Expect the hooks under every install shape, with nothing to configure.**
  `agentStop` and `subagentStop` fired under all four shapes tried, each
  running `${CLAUDE_PLUGIN_ROOT}/bin/squiz hook`. The payload was Claude Code's,
  as under `--plugin-dir`. Folder trust does not apply: a plugin's hooks ran
  in an untrusted directory.
- **Expect the extension under every install shape, gated on experimental
  features alone.** Every session started with `--experimental` logged one
  extension installed, and both live sessions listened on `squiz.sock`. The
  session started without it logged none.
- **Have a Copilot user with no Claude Code run `squiz init` by path from
  Copilot's copy.** `${CLAUDE_PLUGIN_ROOT}` is that copy, so the hook already
  runs it. `squiz init` linked `~/.local/bin/squiz` to it, and the session's
  `squiz review` ran the same squiz the hook did. A second install's
  `squiz init` made no link and named the first, as § 6 `squiz init` says.

## Needs your input

- **Whether `/squiz doctor` should catch two installs at different versions.**
  Copilot keeps its own copy of the plugin, and its hook runs that copy. `squiz`
  on `PATH` links to whichever install ran `squiz init`, which § 9 says is
  Claude Code's where both have squiz. After an update to one and not the
  other, a Copilot session's hook and its `squiz review` run different versions
  on one state file. § 9 now tells such a person to update both.
  Recommendation: have `/squiz doctor` report a Copilot copy whose
  `plugin.json` version differs from the one the link names, as an M9 issue.

## Reference

### The install shapes

| Shape | Command | Where the plugin is | `Plugins loaded:` in the debug log |
|---|---|---|---|
| Local path | `copilot plugin install <path>` | Copied to `installed-plugins/_direct/<directory name>` | `["<path>"]` |
| GitHub repository | `copilot plugin install jacygao/squiz` | Copied to `installed-plugins/_direct/jacygao--squiz` | `["jacygao/squiz"]` |
| Local marketplace | `copilot plugin marketplace add <path>`, then `copilot plugin install squiz@<marketplace>` | Not copied: loaded live from the directory | `["squiz@<marketplace>"]` |
| GitHub marketplace | `extraKnownMarketplaces` in `settings.json`, then `copilot plugin install squiz@<marketplace>` | Copied to `installed-plugins/<marketplace>/squiz` | `["squiz@<marketplace>"]` |

Each path is under `<COPILOT_HOME>`. The two direct installs printed
`Warning: Direct plugin installs (repos, URLs, local paths) are deprecated.
Only plugin@marketplace installs will be supported in a future release.` The
private `jacygao/squiz` installed with the machine's existing GitHub sign-in.
`copilot plugin uninstall squiz` removed the copy.

Every copy kept `bin/squiz` executable and left out `.git`. A copy's path has
no version in it. `copilot plugin update squiz` copied the source again into
the same directory, even when it printed `already at latest`, so a link to the
copy survives an update.

The GitHub marketplace was registered by writing its source into
`<COPILOT_HOME>/settings.json`, since `marketplace add` takes the default
branch and the manifest was on a scratch branch:

```json
{ "extraKnownMarketplaces": { "squiz-local": { "source": { "source": "github", "repo": "jacygao/squiz", "ref": "probe/602-marketplace" } } } }
```

The marketplace manifest, at `.claude-plugin/marketplace.json`:

```json
{ "name": "squiz-local", "owner": { "name": "jacygao" },
  "plugins": [ { "name": "squiz", "source": "./", "description": "A local review loop that lives on the pull request." } ] }
```

`copilot plugin marketplace add` takes `owner/repo`, an `https://` or `ssh://`
git URL, or a local directory. A `file://` URL was read as a relative path and
failed.

### What the hook gets under an install

A stand-in plugin, squiz's `hooks/hooks.json` with a `bin/squiz` that recorded
its call, installed from a local path:

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
`"hookType":"agentStop"` or `"subagentStop"` in the session's
`<COPILOT_HOME>/session-state/<session id>/events.jsonl`. With
`--log-dir <dir> --log-level debug`, whatever `squiz hook` printed to stderr is
in the debug log:

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
directory while the session runs. The hook then records it as the owner's
`messagingSocket` in `state.json`, and the round host's `host.log` ends a round
with `woke its owner through <socket>`. A session started without
experimental features logs neither line, has no socket file, and its record's
owner carries `sessionId` alone.

### The live runs

On `jacygao/greet-cli`, each on a branch and pull request of its own.

| Install | PR | Idle | After the note |
|---|---|---|---|
| Local path | #33 | 41 s | Ran `squiz review 33`, fixed both threads, replied on one, pushed, and round 2 closed the episode `nothing-open` |
| GitHub marketplace | #32 | 15 min 54 s | Ran `squiz review 32`. Its round 2 ended with one thread open, and the session asked the user what to do rather than working it |

The local-path run, from its `events.jsonl` and `host.log`:

```
08:03:58.238Z events    hook.start agentStop
08:03:59.513Z events    hook.end agentStop
08:04:40.513Z host.log  942ed8b: woke its owner through /tmp/s602/ch/session-state/00aee401-…/squiz.sock
08:04:40.538Z events    user.message "Squiz reviewed PR #33 at 942ed8b: 2 threads are open. Run `squiz review 33` to read them." source=system
08:04:47.738Z events    bash "squiz review 33"
```

The marketplace run's round 1 failed at the reviewer's 900-second bound, so
its note was the failure's: `Squiz could not review PR #32 at f250701: the
reviewer was killed at its 900-second bound, …`. It arrived 37 milliseconds
after `host.log`'s `woke its owner through`.

### Setup

- **A scratch `COPILOT_HOME` per shape**, `/tmp/s602/<name>`, short enough for
  the socket's 104-byte limit. Copilot signed in under each with no step of its
  own. The owner's `~/.copilot` was not touched.
- **No `CLAUDE*` variable**, and a `PATH` with no `squiz` but the scratch link.
- **`squiz init`** run by path from the run's copy, with `HOME` a scratch
  directory whose `.local/bin` was on `PATH`:
  `squiz: linked /tmp/s602/home/.local/bin/squiz to /private/tmp/s602/uch/installed-plugins/squiz-local/squiz/bin/squiz`.
  The link was removed and made again from the other copy between the runs.
- **A fresh clone per run**, trusted in `config.json`'s `trustedFolders`, with
  `.squiz.json` in `.git/info/exclude`: `{"reviewer": "copilot"}` for the
  marketplace run, whose reviewer took Copilot's default `claude-sonnet-5`,
  and `{"reviewer": "copilot", "model": "gpt-6-astra"}` for the local-path run.
- **The session** in a pseudo-terminal nothing was typed into, started with
  `copilot --model gpt-5-mini --allow-all --log-dir <dir> --log-level debug -i
  "<prompt>"`. The prompt was the paging task the earlier Copilot runs used,
  ending `Do not run squiz review yourself: squiz reviews the pull request on
  its own and sends you a message when its review is done.` Experimental
  features were already on from an earlier `--experimental` run on that home.

### Reproducing it

With `COPILOT_HOME` a fresh short directory:

```
copilot plugin install <squiz checkout>
copilot plugin list
copilot --experimental --model gpt-5-mini --log-dir <dir> --log-level debug \
  --allow-all-tools --no-ask-user \
  -p "Use the task tool once, with agent_type explore and mode sync, to have a subagent reply PONG."
grep 'hookType' "$COPILOT_HOME"/session-state/*/events.jsonl
grep 'extension(s)\|hook stderr' <dir>/*.log
```

Run outside a repository with a remote, the last line shows both extension
lines and two `nothing was queued` lines.

## Limits

- **One machine, one try of each shape, all on 1.0.92.** The live wake ran on
  the local-path and GitHub-marketplace shapes. The GitHub-repository and
  local-marketplace shapes were seen to fire the hooks and load the extension
  in `-p` runs, and were not woken.
- **The hooks and the wake were seen on a GitHub marketplace added through
  `settings.json` with a `ref`.** The install from `jacygao/squiz`'s own
  manifest with `copilot plugin marketplace add` was checked for where the copy
  lands, and no session was run on it.
- **Not tried:** Linux; a Copilot user signed in other than through the macOS
  keychain; a plugin installed while a session is running.
