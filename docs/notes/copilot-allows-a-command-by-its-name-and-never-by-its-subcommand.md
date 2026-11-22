---
settles: "§ 10 — the rule a Copilot session is started with, so its coding agent runs squiz without asking; § 7 — why `squiz init` leaves Copilot alone"
issue: [702, 707]
recorded: 2026-10-17
versions: { copilot: 1.0.98 }
recheck-when: Copilot CLI changes how `--allow-tool` matches a `shell(...)` rule, or starts reading tool approvals from a settings file
---

# Copilot allows a command by its name, and never by its subcommand

## Intent

- Where Copilot reads tool approvals from, so `squiz init` could add the rule there.
- Whether the README's three rules, `shell(squiz review:*)`, `shell(squiz threads)` and `shell(squiz reply:*)`, let a Copilot session run those commands without asking, and refuse `squiz status`.

## Decisions

- **Start a Copilot session with `--allow-tool='shell(squiz)'`.** A `shell(...)` rule matched only on `squiz`. Every rule naming a subcommand was refused, so a rule can allow all of `squiz` or none of it.
- **Have `squiz init` leave Copilot as it is.** Copilot takes tool approvals only from the `--allow-tool` flags a session starts with, so there is no settings file for `squiz init` to add the rule to, as it does for Claude Code.

## Needs your input

Nothing.

## Reference

Each run was `copilot -p "<run this one command>" --allow-tool=<rule> --no-ask-user --model gpt-5-mini`, from this repository's main checkout. A refused command printed `✗ Denied, no one to approve`.

| Rule | Command | Result |
|---|---|---|
| the README's three together | `squiz review 999999` | refused |
| the README's three together | `squiz threads` | refused |
| the README's three together | `squiz reply PRRT_none hello` | refused |
| the README's three together | `squiz status` | refused |
| `shell(squiz review)` | `squiz review 999999` | refused |
| `shell(squiz threads:*)` | `squiz threads` | refused |
| `shell(squiz)` | `squiz threads` | ran |
| `shell(squiz:*)` | `squiz threads` | ran |
| `shell(squiz:*)` | `squiz status` | ran |

`copilot help permissions` says a rule is matched on the command name in most cases, and on the first-level subcommand for `git` and `gh`. `squiz` is matched like any other command.

## Limits

- Only `-p` with `--no-ask-user` was run. An interactive session asks rather than refusing, but the rule matches the same way.
- One Copilot version, 1.0.98, on macOS.
- That approvals come only from `--allow-tool` at session start is the specification's statement, from 2026-10-17 and still on `origin/spec-requirements-list` at `1681b1f`. No search of Copilot's settings files for an approval key is recorded.
