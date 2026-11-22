---
settles: "§ 9 — why `bin/squiz` is a shell shim, and why the Copilot extension is the one JavaScript file"
recorded: 2026-11-22
versions: { node: 24.15.0 }
recheck-when: Node decides type stripping by something other than the file's extension, or Copilot starts an extension under another name
---

# Node strips types only from a `.ts` file, and Copilot starts only an `extension.mjs`

## Intent

- Whether the `squiz` entry point can be an extensionless Node file.
- Whether the Copilot extension can be written in TypeScript like the rest.

## Decisions

- **Keep `bin/squiz` a `/bin/sh` shim that execs `node <root>/src/cli.ts`.**
  Node decides whether to strip types from the file's extension, and runs an
  extensionless entry point as JavaScript, so `src/cli.ts` has to be started by
  its own name.
- **Keep the extension as `extensions/squiz-wake/extension.mjs`.** Copilot
  starts only a file of that name. It imports nothing but Node's own modules and
  the `@github/copilot-sdk/extension` that Copilot supplies.

## Needs your input

Nothing.

## Limits

- **Both facts come from the specification at `1681b1f`, § 9**, and from the
  comment in `bin/squiz`. No note records a run that tried an extensionless
  entry point, or an extension under another name.
- **The Node version is the one squiz is checked on**, not one recorded with
  either fact.
