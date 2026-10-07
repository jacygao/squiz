## Intent

- A line counted as blank only when it held nothing but spaces and tabs. A line holding a form feed, a vertical tab or a no-break space is just as blank to a reader, so `blankLine` now matches any whitespace.

## What changed

- `other.blankLine` in `src/rules.ts` is `/^\s*$/`.
