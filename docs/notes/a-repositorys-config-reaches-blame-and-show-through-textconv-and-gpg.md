---
settles: "§ 4 — which of the repository's settings reach the history tools, and what closes each"
issue: 546
recorded: 2026-10-06
versions: { git: "2.54.0 (Apple Git-157)", node: 24.15.0, macos: 26.6.2 }
recheck-when: git upgrades, or a history tool gains a subcommand or a flag
---

# A repository's config reaches blame and show through textconv and gpg

## Intent

- Which settings in a hostile repository's local config or `.gitattributes`
  make `git log -S`, `git blame` and `git show` run a program or read a file
  outside the repository, when run with output to a pipe.
- What closes each one.

## Decisions

- **Pass `--no-textconv` to all three.** A diff driver's `textconv` ran under
  every one of them, `git blame <rev>` included: blame applies textconv by
  default.
- **Pass `--no-show-signature` to `log` and `show`, and `-c log.showSignature=false`.**
  With `log.showSignature=true`, a commit carrying a `gpgsig` header runs
  `gpg.program`.
- **Pass `--no-ignore-revs-file` to `blame`.** `blame.ignoreRevsFile` names any
  file, and git quotes its first line in the error: `fatal: invalid object name:
  SECRET-CONTENT`.
- **Blame `HEAD -- <file>`, never the working tree.** Blaming the working tree
  ran `core.fsmonitor`, a `clean` filter and a `process` filter. Blaming a
  revision ran none of them.
- **Set `GIT_NO_LAZY_FETCH=1`.** In a partial clone, `git show` of a commit
  whose blob is missing ran `core.sshCommand` to fetch it.
- **Drop every inherited `GIT_` variable.** `GIT_DIR` in the environment pointed
  `git show` at another repository.
- **Keep `--no-pager`, `--no-ext-diff` and `-c core.fsmonitor=false` anyway.**
  None of `core.pager`, `diff.external` or a driver's `diff.<name>.command` ran
  with output to a pipe, but each is a program the config names, and the flags
  cost nothing.

## Needs your input

Nothing.

## Reference

Each setting configured alone, with `* diff=evil filter=evil` in
`.gitattributes`, and git's output to a pipe. "Ran" means the named program ran
or the named file's content was printed.

| Setting | `log -S` | `blame HEAD -- f` | `blame f` | `show` |
|---|---|---|---|---|
| `diff.evil.textconv` | ran | ran | ran | ran |
| `log.showSignature` + `gpg.program` | ran | — | — | ran |
| `blame.ignoreRevsFile` | — | ran | ran | — |
| `core.fsmonitor` | — | — | ran | — |
| `filter.evil.clean` | — | — | ran | — |
| `filter.evil.process` | — | — | ran | — |
| `core.pager` | — | — | — | — |
| `diff.external` | — | — | — | — |
| `diff.evil.command` | — | — | — | — |
| `filter.evil.smudge` | — | — | — | — |

`alias.show` did not replace the builtin. `gpg.program` is run without a shell,
so a value carrying arguments fails to start rather than running.

`--end-of-options` is accepted by `rev-parse`, `log` and `show` at this version.
A term stuck to its flag, `-S-p`, is searched for as text.

## Limits

- Only these settings were tried. Another driver git adds later, or one not
  listed here, is not covered by the table.
- `core.sshCommand` was the only transport tried for the lazy fetch.
- macOS only.
