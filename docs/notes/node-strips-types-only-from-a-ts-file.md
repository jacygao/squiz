---
settles: "§ 9: why `bin/squiz` is a shell shim rather than an extensionless Node file"
recorded: 2026-11-22
versions: { node: 24.15.0 }
recheck-when: Node decides type stripping by something other than the file's extension
---

# Node strips types only from a `.ts` file

## Intent

- Whether the `squiz` entry point can be an extensionless Node file.

## Decisions

- **Keep `bin/squiz` a `/bin/sh` shim that execs `node <root>/src/cli.ts`.**
  Node decides whether to strip types from the file's extension, and runs an
  extensionless entry point as JavaScript, so `src/cli.ts` has to be started by
  its own name.

## Needs your input

Nothing.

## Limits

- **The fact comes from § 9 and the comment in `bin/squiz`.** No run that tried
  an extensionless entry point is recorded.
- **The Node version is the one squiz is checked on**, not one recorded with
  the fact.
