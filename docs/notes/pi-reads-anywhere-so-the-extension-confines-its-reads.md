---
settles: "§ 5: what confines the `pi` reviewer's reading tools to the snapshot"
issue: [576, 620]
recorded: 2026-10-07
versions: { pi: 0.85.1, models: deepseek-v4-pro, macos: 26.6.2 }
recheck-when: pi upgrades or changes how a tool resolves its path
---

# `pi` reads anywhere, so the extension confines its reads

## Intent

- Whether `pi`'s `read`, `grep`, `find` and `ls` reach a file outside the
  snapshot by an absolute path, a `..` path, or a link inside the snapshot that
  points out.
- What the `pi` reviewer reads outside the snapshot on purpose, which a
  confinement must leave alone.

## Decisions

- **Refuse a read outside the snapshot from the extension's `tool_call`
  handler.** `pi` confines nothing: each of the four tools read a decoy outside
  the snapshot all three ways. The handler resolves the path the way `pi` does,
  takes its real path with every link resolved, and refuses it unless it sits
  inside the snapshot's real path. The refusal is recorded like any other.
- **Allow nothing outside the snapshot.** `pi` reads the charter and the prompt
  file itself, from the command line, not through a granted tool.

## Needs your input

Nothing.

## Reference

The refusal, where `<path>` is the path as the reviewer gave it:

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
`grep` and `find`, search the snapshot without descending into a linked
directory. Only a link given as the root, or as the file, is followed, and that
is the case the check resolves.

## Limits

- **The check and the read are two moments.** A link created between them is
  not seen. No tool the reviewer is granted writes, so nothing in a round can
  create one.
- **A hard link is not a link to resolve.** git cannot record one, so the code
  under review cannot carry one.
- **A spelling `pi` comes to expand that the check does not** is a way out the
  check does not see. The list above is `pi` 0.85.1's.
- One machine, macOS.
