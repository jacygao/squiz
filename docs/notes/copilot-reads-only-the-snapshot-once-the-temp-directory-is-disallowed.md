---
settles: "§ 5: what confines the Copilot reviewer's reading tools to the snapshot"
issue: [576, 620]
recorded: 2026-10-07
versions: { copilot: 1.0.92, models: gpt-6-astra, macos: 26.6.2 }
recheck-when: Copilot upgrades or changes its path permissions
---

# Copilot reads only the snapshot once the temp directory is disallowed

## Intent

- Whether Copilot's `view`, `grep` (shown to the model as `rg`) and `glob` reach
  a file outside the snapshot by an absolute path, a `..` path, or a link inside
  the snapshot that points out.
- What the Copilot reviewer reads outside the snapshot on purpose, which a
  confinement must leave alone.

## Decisions

- **Leave Copilot's own path check on, and pass `--disallow-temp-dir`.**
  Copilot refused every way out, links included, without being asked. The one
  directory outside the snapshot it still opened was the system's temporary
  directory, which holds every round's snapshot. The flag closes it, and the
  snapshot inside it stays readable, because it is Copilot's working directory.
- **Allow nothing outside the snapshot.** Copilot reads its agent file from
  `COPILOT_HOME` itself, not through a granted tool.

## Needs your input

Nothing.

## Reference

| Way out | Default | `--disallow-temp-dir` |
|---|---|---|
| Absolute path, `..` path, or a link to a file or directory outside | refused | refused |
| `rg` or `glob` rooted outside | refused | refused |
| A file in the reviewer's `TMPDIR` | **read** | refused |
| Another round's snapshot, under `TMPDIR/squiz-<uid>/` | **read** | refused |

Copilot's refusal text, the same for every tool and every way out:

```
Permission denied because no interactive user response was available. Retry in an interactive session so the user can approve it, or try an alternative that does not require this permission.
```

`rg` does not descend into a linked directory. `glob` with a pattern of
`../secret/*` and no root matches nothing, and is not refused.

## Limits

- **The table comes from the CLI with the same flags and no agent.** In a whole
  round, with the charter as its agent, the model refused to read the decoy on
  its own and read only the file inside the snapshot.
- **`~` was not probed,** to keep a real credential file out of the run.
  Copilot's check resolves absolute and relative paths alike.
- **The history tools were not probed here.** They are squiz's own MCP tools,
  which § 5 hardens separately.
- One machine, macOS.
