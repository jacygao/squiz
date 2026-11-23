---
settles: "§ 9: how the `pi` extension shares code with the harness without a runtime dependency"
issue: [11, 165]
recorded: 2026-09-25
versions: { pi: "0.84.2, 0.85.1", node: 24.15.0 }
recheck-when: pi upgrades, or pi stops validating a plain JSON Schema or compiling what an extension imports
---

# A `pi` extension adds no runtime dependency

## Intent

- Whether the extension may share code with the harness, which has no runtime
  dependencies, when `pi`'s examples import `typebox`.

## Decisions

- **Write the extension against structural types and a plain JSON Schema
  object.** `pi` validates a schema that is not a TypeBox value through its own
  JSON Schema path, so `typebox` need not be imported, and `pi`'s own package is
  never a dependency.
- **Import the harness's own `.ts` modules from the extension.** `pi` compiles
  the extension and everything it imports.

## Needs your input

Nothing.

## Limits

- **Seen on one machine, macOS, `pi` 0.85.1.** How `pi` loads and compiles an
  extension is not part of its documented interface.
