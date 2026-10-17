## Intent

- `splitCells` walked backwards over every backslash before each pipe in a table row to decide whether the pipe was escaped. Only the character directly before a pipe can escape it, so the walk is replaced by one look.

## What changed

- `splitCells` in `src/helpers.ts` treats a pipe as escaped when the character before it is a backslash.
