---
settles: "§ 10: when a Claude Code user runs `squiz init` again; § 7: what `squiz doctor` and `squiz init` print for a link left on the old version"
issue: 677
recorded: 2026-10-07
versions: { claude-code: 2.1.292, plugin-version: "0.1.0 to 0.1.1", platform: macOS }
recheck-when: Claude Code changes `claude plugin update`, the `.orphaned_at` marker, or its orphaned-version sweep; or `squiz doctor` or `squiz init` changes its link line
---

# A Claude Code update leaves the link on the old version until `squiz init` moves it

## Intent

- Whether `claude plugin update` leaves the old version's directory in place,
  and for how long.
- What happens to a link `squiz init` made into the old directory.

## Decisions

- **Tell a person to type `! squiz init` after every update.** Until they do, a
  terminal or a Copilot session runs the old squiz through the link, and once
  Claude Code deletes the old directory, 14 days on, runs nothing. The new squiz
  moves the link and says so.
- **Rely on the new squiz, not the old, to warn.** The new squiz's
  `squiz doctor` warns about the link. The old one, run through the link, says
  the link is fine, because the link points at itself.

## Needs your input

Nothing.

## Reference

### What the update leaves

`claude plugin update squiz@squiz` from 0.1.0 to 0.1.1 printed
`✔ Plugin "squiz" updated from 0.1.0 to 0.1.1 for scope user. Restart to apply changes.`
and left:

- `<config>/plugins/cache/squiz/squiz/` holding both `0.1.0/` and `0.1.1/`;
- `0.1.0/.orphaned_at` holding the update's time in epoch milliseconds;
- `installed_plugins.json` naming only `0.1.1`, as `installPath`;
- `~/.local/bin/squiz` still linked to `0.1.0/bin/squiz`, and running it.

### When the old directory goes

- The first Claude Code start once `.orphaned_at`'s mtime is 14 days old
  deletes the old directory, signed in or not. The 14 days is the constant
  `1209600000` in the 2.1.292 binary.
- The same code skips a version a live session is using (unverified: read from
  the binary, not seen).
- The link then dangles, and `squiz` run through it gives
  `env: squiz: No such file or directory`, exit 127.

### What squiz prints

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

## Limits

- **Whether a session started before the update still has the old `bin/` on
  `PATH` for `!` was not tried.** The update says to restart, so § 10 has
  `! squiz init` typed in a session started after it.
- **The 14 days was forced by setting the marker's mtime back, not waited
  out.**
- **The marketplace was a local directory**, not a git host, and the update was
  at user scope. One run, on macOS.
