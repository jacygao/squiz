---
settles: "§ 2 — which versions of each dependency the design was checked against, how to re-check each, and that none of them is a minimum; § 2 — the source of the behaviours no other note records"
issue: 485
recorded: 2026-10-06
versions: { git: 2.50.1, gh: 2.97.0, pi: 0.84.2, copilot: 1.0.91, claude-code: "2.1.261, 2.1.270, 2.1.288, 2.1.289" }
recheck-when: any dependency below is upgraded past the version listed, or the setup check starts checking versions
---

# No dependency version is a minimum

## Intent

- Which version of each dependency the design was checked against, and how to
  re-check it.
- Whether any of those versions is a requirement, such as a minimum the setup
  check enforces.
- Where the evidence lives for the behaviours § 2 states that no other note
  records.

## Decisions

- **Treat no version below as a minimum.** § 2 requires each dependency to be
  installed, and `gh` to be authenticated, and states no version for any of
  them. The setup check reports what is missing or unauthenticated, not what is
  old. Node is the exception, and § 8 owns its requirement: Node 24 or later.

- **Re-check a behaviour against the command beside it before relying on it
  after an upgrade.** Each version is the one the behaviour was seen on, and
  nothing tests it again on its own.

## Needs your input

Nothing.

## Reference

The versions the design was checked against, and the command that re-checks
each:

| | Version | Re-check with |
|---|---|---|
| `git` | 2.50.1 | `git --version` |
| `gh` | 2.97.0, authenticated against github.com | `gh --version`, `gh auth status` |
| `pi` | 0.84.2 | `pi --version` |
| GitHub Copilot CLI | 1.0.91 | `copilot --version` |
| Claude Code | 2.1.261 | `claude --version` |

Where each behaviour § 2 states was established, for those no other note
records:

- **`gh pr comment` and `gh pr review` take a body only.** Read from
  `gh pr review --help` and `gh pr comment --help`, which offer no path or line.
- **The Bash tool's timeout, its 120-second default and 600-second ceiling, and
  the move to the background.** Documented in Claude Code's tools reference,
  under the Bash tool, rather than measured. The two values are read from
  `BASH_DEFAULT_TIMEOUT_MS` and `BASH_MAX_TIMEOUT_MS`.
- **What does not outlive Claude Code stopping a command or a hook:** a plain
  `&`, `setsid` alone, `nohup … & disown`, and `( nohup … & )`. Each stays in
  the command's process tree or its process group. Recorded against Claude Code
  2.1.288 on macOS *(unverified: carried over from the specification, with no
  run of its own in this repository)*.

## Limits

- Only the versions above were run. A later version was not tried, so one that
  changes a behaviour is not ruled out.
- Every Claude Code behaviour was seen on macOS alone.
