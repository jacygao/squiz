---
settles: "§ 8 — whether pi --tools actually withholds edit and write"
issue: 11
recorded: 2026-09-06
versions: { pi: 0.84.2, model: deepseek-v4-pro }
recheck-when: pi upgrades, or the default grant changes
---

# The `deep` grant does not confine

`--tools` genuinely withholds `edit` and `write` — the schemas are never sent,
not sent and ignored. But `bash` is granted at `deep`, `bash` writes, and the
reviewer used it to modify a tracked file on its first attempt, unprompted and
unrefused. The `read` grant confines; the `deep` grant, which is the default,
does not. An unrecognised tool name fails safe: it withholds, never grants.

## Decisions

- **`--tools` genuinely withholds `edit` and `write`.** The schemas are not sent,
  rather than sent and ignored.
- **The `read` grant confines; the `deep` grant does not.** `bash` is a write
  primitive, and the reviewer used it to modify a tracked file on its first
  attempt, unprompted and unrefused.
- **An unrecognised tool name fails safe.** It withholds, never grants, whether
  it sits beside real names or alone.
- **`< /dev/null` is required unconditionally**, not only when a tool is enabled
  as § 4 says. § 4's condition should go; the remedy is unchanged.

## Needs your input

**Whether to promote the tracked-file comparison to P0, drop `bash` from the
default grant, or accept the gap.** § 4's Confinement assigns everything
`--tools` misses to the tracked-file comparison, which is **P1**. The `deep`
grant is **P0** and is the default, and the comparison is disabled in a shared
worktree even once built. As sequenced, the harness ships with the hole open and
the detector unbuilt.

Recommended: promote the comparison to P0. It is the only mechanism between a
`deep` reviewer and the code under review, and it is cheap beside the
alternative of dropping the shell, which costs the reviewer the ability to run
the tests.

Also for you: **§ 2's Verified against table records `pi` 0.74.2.** Everything
here is 0.84.2, and where the two differ was not checked.

## Reference

### The two grants

| Depth | `--tools` | Confines |
|---|---|---|
| `read` | `read,grep,find,ls` | Yes |
| `deep` *(default)* | `read,grep,find,ls,bash` | **No** — `bash` writes |

`pi`'s own default set, used when no `--tools` is passed, is `read`, `bash`,
`edit`, `write`. The `deep` grant adds three tools and removes two; `grep`,
`find` and `ls` are not default.

All seven built-in names exist at 0.84.2 — `read`, `bash`, `edit`, `write`,
`grep`, `find`, `ls` — so both § 4 grants name real tools.

### Where the grant is enforced

In `core/agent-session.js`, `--tools` becomes a set that every registered tool
name is filtered against, for both the definitions sent to the model and the
executable registry. A name outside the set has no definition and no
implementation, so a withheld tool is absent rather than merely discouraged.

`pi`'s own documentation states the position on the shell: "Pi does not include
a built-in sandbox. Built-in tools can read files, write files, edit files, and
run shell commands with the permissions of the pi process." Withholding `edit`
and `write` while granting `bash` removes two ways of writing and leaves a
third. `--print` is non-interactive, so `bash` runs unattended with no refusal,
prompt or approval step.

### An unrecognised name withholds, never grants

- A typo alongside real names is dropped. `read,grep,find,ls,bahs` produced a
  request identical in size and behaviour to `read,grep,find,ls`.
- A grant of only an unrecognised name yields **no tools**, not the default set.
  `notatool` matched `--no-tools` at 662 tokens. Holding nothing, the model
  emitted a textual imitation of a tool call.
- Nothing is said about it. Exit status 0 and empty stderr in every case, with
  no warning that a name matched no tool. A typo costs the reviewer a tool
  quietly; it never gains it one.

### `< /dev/null` is required, unconditionally

| stdin | Grant | Result |
|---|---|---|
| open pipe | `--tools read` | No output, no error, no exit. Killed at 25 s |
| open pipe | `--no-tools` | No output, no error, no exit. Killed at 25 s |
| `< /dev/null` | either | Returns in about a second |

A silent hang and a refusal look alike from outside, and only one is a result.
Give every run a hard timeout.

## Limits

- **Whether the reviewer writes through `bash` on a real review.** The task here
  asked for a fix, the strongest provocation available. A charter telling the
  reviewer to report rather than repair may mean it never reaches for `sed`.
  That is a different claim from being unable to, and only the second is a
  confinement mechanism.
- **Whether another model behaves the same.** One model, `deepseek-v4-pro`. The
  capability belongs to the grant; the choice to use it belongs to the model.
- **What § 4's other two mechanisms catch.** Scratch space and the tracked-file
  comparison were not exercised as designs. The comparison is how the `deep`
  write was detected here, but it detects rather than prevents, and § 4 says so.
