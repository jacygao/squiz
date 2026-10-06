---
settles: "§ 4 — how a Copilot adapter refuses the commands that move HEAD, and what the reviewer reads when it does"
issue: 458
recorded: 2026-10-06
versions: { copilot: 1.0.91, models: "claude-haiku-4.5, gpt-5-mini", macos: 26.6.2 }
recheck-when: Copilot CLI upgrades past 1.0.91, or changes its shell permission patterns
---

# `--deny-tool` refuses a git subcommand wherever it is the command

## Intent

- What `--deny-tool` patterns match for shell commands.
- Whether a refused call reaches the model as that call's error.

## Decisions

- **Refuse with `--deny-tool='shell(git commit)'`, one per subcommand, and the
  `:*` form where a flag matters.** A pattern naming a first-level subcommand
  refused it with git's options before it, inside a compound line, a subshell
  and a command substitution. It took precedence over `--allow-all-tools`. The
  spec's six become:

  ```
  --deny-tool='shell(git commit)' --deny-tool='shell(git reset --soft:*)'
  --deny-tool='shell(git checkout)' --deny-tool='shell(git update-ref)'
  --deny-tool='shell(git push)'
  ```

  `shell(git checkout -B)` matched nothing, so `git checkout` is refused whole.
  Whether to refuse `git switch -C` too is for the adapter: it moved `HEAD` and
  matched none of these. 2026-10-06: no adapter refuses a shell command any
  more. No depth grants Copilot a shell, so it is passed no `--deny-tool` for
  one.
- **Count a refusal from `tool.execution_complete`, where `success` is false and
  `error.code` is `"denied"`.** That is the call's own result, and the model read
  it as one and went on to its next call. The text names the rule:

  ```
  Permission to run this tool was denied due to the following rules: `shell(git commit)`
  ```

  The same event, with the same `error`, is written to the session's own
  `<COPILOT_HOME>/session-state/<session id>/events.jsonl`, which is where a
  run whose stdout is a pane's screen leaves it.
- **Rely on the snapshot comparison for what the patterns miss**, as § 4
  Confinement already does for `pi`. `env git commit`, `sh -c 'git commit'` and
  `git "com"mit` each committed.

## Needs your input

Nothing.

## Reference

Measured with `--deny-tool='shell(git commit)'`, `'shell(git reset --soft)'`,
`'shell(git checkout -B)'`, `'shell(git update-ref)'` and `'shell(git push)'`,
then again with `'shell(git reset --soft:*)'` and `'shell(git checkout)'`:

| Command | Result |
|---|---|
| `git commit --allow-empty -m c1` | denied |
| `git commit --amend -m c1` | denied |
| `git -C . commit …` | denied |
| `git -c user.name=z commit …` | denied |
| `GIT_AUTHOR_NAME=z git commit …` | denied |
| `echo start && git commit …` | denied |
| `(git commit …)` | denied |
| `echo $(git commit …)` | denied |
| `env git commit …` | **ran** |
| `sh -c 'git commit …'` | **ran** |
| `git "com"mit …` | **ran** |
| `git reset --soft HEAD`, against `shell(git reset --soft)` | **ran** |
| `git reset --soft HEAD`, against `shell(git reset --soft:*)` | denied |
| `git reset --mixed HEAD`, against `shell(git reset --soft:*)` | ran |
| `git checkout -B other`, against `shell(git checkout -B)` | **ran** |
| `git checkout -B o2`, against `shell(git checkout)` | denied |
| `git switch -C o3` | ran |
| `git update-ref refs/heads/x HEAD` | denied |
| `git push origin main` | denied |
| `grep 'git commit' a.txt` | ran |

Copilot runs each shell call as `/bin/bash --norc --noprofile -c '<command>'`.

## Limits

- `shell(git reset --soft:*)` was tried only on `git reset --soft HEAD`. Whether
  it refuses `git reset -q --soft HEAD`, where the flag is not next to the
  subcommand, was not tested.
- `xargs`, a heredoc and a script file were not tried.
- `gpt-5-mini`, given the first prompt, made one shell call and then reported
  four more it never made. The table comes from `claude-haiku-4.5`, which made
  every call, and from the stream's own events rather than from either model's
  account.
