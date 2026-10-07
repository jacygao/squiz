---
settles: "§ 4 — what confines the reviewer's reading tools to the snapshot, for each adapter"
issue: [576, 620]
recorded: 2026-10-07
versions: { pi: 0.85.1, copilot: 1.0.92, models: "deepseek-v4-pro, gpt-6-astra", macos: 26.6.2 }
recheck-when: pi upgrades or changes how a tool resolves its path; Copilot upgrades or changes its path permissions
---

# pi reads anywhere, and Copilot reads only the snapshot and its temp directory

## Intent

- Whether `pi`'s `read`, `grep`, `find` and `ls` reach a file outside the
  snapshot by an absolute path, a `..` path, or a link inside the snapshot that
  points out.
- Whether Copilot's `view`, `grep` (shown to the model as `rg`) and `glob` do.
- What either adapter reads outside the snapshot on purpose, which a
  confinement must leave alone.

## Decisions

- **Refuse a `pi` read outside the snapshot from the extension's `tool_call`
  handler.** `pi` confines nothing: each of the four tools read the decoy all
  three ways. The handler resolves the path the way `pi` does, takes its real
  path with every link resolved, and refuses it unless it sits inside the
  snapshot's real path. The refusal is recorded like any other.
- **Leave Copilot's own path check on, and pass `--disallow-temp-dir`.**
  Copilot refused every way out, links included, without being asked. The one
  directory outside the snapshot it still opened was the system's temporary
  directory, which holds every round's snapshot. The flag closes it, and the
  snapshot inside it stays readable, because it is Copilot's working directory.
- **Allow nothing outside the snapshot.** Neither adapter's tools read anything
  outside it on purpose. `pi` reads the charter and the prompt file itself, from
  the command line, and Copilot reads its agent file from `COPILOT_HOME`.
  Neither goes through a granted tool.

## Needs your input

Nothing.

## Reference

What each call returned, run from the snapshot with a decoy file in a sibling
directory and a second one outside `TMPDIR` altogether. The reviewer's `TMPDIR`
is the system's, so the snapshot itself sits inside it, as do the sibling
directory and every other round's snapshot.

| Way out | `pi` before | `pi` with the extension | Copilot, default | Copilot, `--disallow-temp-dir` |
|---|---|---|---|---|
| Absolute path | read | refused | refused | refused |
| `../secret/id_rsa` | read | refused | refused | refused |
| Link to the file | read | refused | refused | refused |
| Link to the directory, then the file | read | refused | refused | refused |
| `grep` / `find` / `ls`, or `rg` / `glob`, rooted outside | read | refused | refused | refused |
| A file in the reviewer's `TMPDIR` | as any absolute path | as any absolute path | **read** | refused |
| Another round's snapshot, under `TMPDIR/squiz-<uid>/` | as any absolute path | as any absolute path | **read** | refused |

Copilot's refusal text, the same for every tool and every way out:

```
Permission denied because no interactive user response was available. Retry in an interactive session so the user can approve it, or try an alternative that does not require this permission.
```

The extension's, where `<path>` is the path as the reviewer gave it:

```
squiz refused this call: `<path>` is outside the code under review. Read only what is in the working directory.
```

**`pi` resolves a path before opening it**, and the check has to resolve it the
same way:

- a leading `@` is dropped;
- `~` and `~/…` become the home directory;
- a `file://` URL becomes its path;
- Unicode spaces become plain spaces;
- the rest is resolved against the working directory.

**`read` then tries four other spellings where the path does not exist**: a
narrow no-break space before `AM.` or `PM.`, the NFD form, a curly apostrophe for
`'`, and NFD with the curly apostrophe. It opens the first that exists. A link
named `it’s` is reached by asking for `it's`, so the check resolves the spelling
`read` would open. Checking every spelling instead refuses every read in a
snapshot whose path has an apostrophe in it.

**A recursive search does not follow a link.** `rg` and `fd`, under `pi`'s
`grep` and `find`, and Copilot's `rg` searched the snapshot without descending
into `link-dir`. Only a link given as the root, or as the file, is followed,
and that is the case the check resolves.

Copilot's `glob` with a pattern of `../secret/*` and no root matched nothing,
and was not refused.

## Limits

- **The check and the read are two moments.** A link created between them is
  not seen. No tool the reviewer is granted writes, so nothing in a round can
  create one.
- **A hard link is not a link to resolve.** git cannot record one, so the code
  under review cannot carry one.
- **A spelling `pi` comes to expand that the check does not** is a way out the
  check does not see. The list above is `pi` 0.85.1's.
- **The reviewer in a whole Copilot round declined to try.** Asked to read the
  decoy through the adapter's own command line, with the charter as its agent,
  the model refused on its own and read only the file inside the snapshot. The
  table's Copilot columns come from the CLI with the same flags and no agent.
- **`~` was not probed against Copilot**, to keep a real credential file out of
  the run. Its check resolves absolute and relative paths alike.
- One machine, macOS.
