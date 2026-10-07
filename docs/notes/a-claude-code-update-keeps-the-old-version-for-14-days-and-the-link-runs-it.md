---
settles: "§ 9 — what `claude plugin update` does to the old version's directory, how long that directory lasts, and when to run `squiz init` again; § 6 — what `squiz doctor` and `squiz init` print for a link left on the old version"
issue: 677
recorded: 2026-10-07
versions: { claude-code: 2.1.292, plugin-version: "0.1.0 to 0.1.1", platform: macOS }
recheck-when: Claude Code changes `claude plugin update`, the `.orphaned_at` marker, or its orphaned-version sweep; or `squiz doctor` or `squiz init` changes its link line
---

# A Claude Code update keeps the old version for 14 days, and the link runs it until `squiz init` moves it

`claude plugin update` installs the new version in a directory of its own and
leaves the old one, marked with `.orphaned_at`. The link `squiz init` made still
names the old directory and runs the old squiz. The first Claude Code start once
the marker is 14 days old deletes the old directory, and the link then dangles.
`squiz init` run from the new version moves it.

## Intent

- Whether `claude plugin update` leaves the old version's directory in place,
  and for how long.
- What happens to a link `squiz init` made into the old directory.

## Decisions

- **Tell a person to type `! squiz init` after every update.** Until they do, a
  terminal or a Copilot session runs the old squiz, and from day 14 runs
  nothing. The new squiz moves the link and says so.
- **Rely on the new squiz, not the old, to warn.** The new squiz's
  `squiz doctor` warns about the link. The old one, run through the link, says
  the link is fine, because the link points at itself.

## Needs your input

Nothing.

## Reference

### What the update left

After `claude plugin update squiz@squiz` from 0.1.0 to 0.1.1, which printed
`✔ Plugin "squiz" updated from 0.1.0 to 0.1.1 for scope user. Restart to apply changes.`:

- `<config>/plugins/cache/squiz/squiz/` held both `0.1.0/` and `0.1.1/`.
- `0.1.0/.orphaned_at` held the update's time in epoch milliseconds,
  `1791376149818`.
- `installed_plugins.json` named only `0.1.1`, as `installPath`.
- `~/.local/bin/squiz` still linked to `0.1.0/bin/squiz`, and ran.

### When the old directory goes

- A `claude -p` start with the marker minutes old kept `0.1.0/`.
- With the marker's mtime set 36 days back (`touch -t 202609010000`), and its
  contents unchanged, the next `claude -p` start deleted `0.1.0/`. Both starts
  were signed out and exited 1 with `Not logged in`, so the sweep runs whether
  or not the config is signed in.
- The age is read from the marker's mtime. The 14 days is the constant
  `1209600000` in the 2.1.292 binary. The same code skips a version a live
  session is using (unverified: read from the binary, not seen).
- The link then dangled, and `squiz` run through it gave `env: squiz: No such
  file or directory`, exit 127.

### What squiz printed

From the new squiz, as `! squiz doctor` runs it, with the link on 0.1.0:

```
squiz link: warning: <home>/.local/bin/squiz links to <config>/plugins/cache/squiz/squiz/0.1.0/bin/squiz, another version of this install. Run squiz init to move it to this one
```

From the old squiz, run through the link:

```
squiz link: <home>/.local/bin/squiz already links to this squiz
```

The new squiz's `squiz init`, after the old directory was gone:

```
squiz: linked <home>/.local/bin/squiz to <config>/plugins/cache/squiz/squiz/0.1.1/bin/squiz, in place of <config>/plugins/cache/squiz/squiz/0.1.0/bin/squiz, an earlier version of this install
```

### Reproducing it

Everything ran under `env -i` with a scratch `HOME` and `CLAUDE_CONFIG_DIR`,
never `~/.claude`. The marketplace was a plain directory holding a copy of the
repository, so its version could be bumped by editing it:

```sh
claude plugin marketplace add <dir>
claude plugin install squiz@squiz
<config>/plugins/cache/squiz/squiz/0.1.0/bin/squiz init
# set "version" to 0.1.1 in <dir>/.claude-plugin/marketplace.json and plugin.json
claude plugin marketplace update squiz
claude plugin update squiz@squiz
touch -t 202609010000 <config>/plugins/cache/squiz/squiz/0.1.0/.orphaned_at
claude -p hi
```

## Limits

- **Whether a session started before the update still has the old `bin/` on
  `PATH` for `!` was not tried.** The update prints `Restart to apply changes`,
  so the spec and README say to type `! squiz init` in a session started after
  it.
- **The 14 days was forced with `touch`, not waited out.**
- **The marketplace was a local directory**, not a git host, and the update was
  at user scope. One run, on macOS.
