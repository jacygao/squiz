---
settles: "§ 10: the rule a Copilot session is started with, so its coding agent runs squiz without asking; § 7: whether `squiz init` can allow squiz for Copilot"
issue: [702, 707]
recorded: 2026-10-17
versions: { copilot: 1.0.98 }
recheck-when: Copilot CLI changes how `--allow-tool` matches a `shell(...)` rule, or starts reading tool approvals from a settings file
---

# Copilot allows a command by its name, and never by its subcommand

## Intent

- Where Copilot reads tool approvals from, so `squiz init` could add the rule
  there.
- Whether rules naming squiz's subcommands, `shell(squiz review:*)`,
  `shell(squiz threads)` and `shell(squiz reply:*)`, let a Copilot session run
  those commands without asking, and refuse `squiz status`.

## Decisions

- **Start a Copilot session with `--allow-tool='shell(squiz)'`.** A `shell(...)`
  rule matched only on `squiz`. Every rule naming a subcommand was refused, so a
  rule can allow all of `squiz` or none of it.
- **Have `squiz init` leave Copilot as it is.** Copilot takes tool approvals
  only from the `--allow-tool` flags a session starts with, so there is no
  settings file for `squiz init` to add the rule to, as it does for Claude Code.

## Needs your input

Nothing.

## Reference

A refused command printed `✗ Denied, no one to approve`.

| Rule | Command | Result |
|---|---|---|
| the three subcommand rules together | `squiz review 999999`, `squiz threads`, `squiz reply PRRT_none hello`, `squiz status` | each refused |
| `shell(squiz review)` | `squiz review 999999` | refused |
| `shell(squiz threads:*)` | `squiz threads` | refused |
| `shell(squiz)` | `squiz threads` | ran |
| `shell(squiz:*)` | `squiz threads` | ran |
| `shell(squiz:*)` | `squiz status` | ran |

`copilot help permissions` says a rule is matched on the command name in most
cases, and on the first-level subcommand for `git` and `gh` only.

## Limits

- **Only `-p` with `--no-ask-user` was run.** An interactive session asks rather
  than refusing, and matches the rule the same way (unverified).
- **One Copilot version, 1.0.98, on macOS.**
- **That approvals come only from `--allow-tool`** was not checked by searching
  Copilot's settings files for an approval key.
