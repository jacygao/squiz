---
settles: "§ 9: why the Copilot extension is squiz's one JavaScript file"
recorded: 2026-11-22
recheck-when: Copilot starts an extension under another name
---

# Copilot starts only an `extension.mjs`

## Intent

- Whether the Copilot extension can be written in TypeScript like the rest of
  squiz.

## Decisions

- **Keep the extension as `extensions/squiz-wake/extension.mjs`.** Copilot
  starts only a file of that name. It imports nothing but Node's own modules
  and the `@github/copilot-sdk/extension` that Copilot supplies, so it needs no
  build step either.

## Needs your input

Nothing.

## Limits

- **The fact comes from § 9.** No run that tried an extension under another
  name is recorded, and the Copilot version it holds for is not known.
