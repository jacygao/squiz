## Intent

- `rtrim` in `src/helpers.ts` counted the length of the suffix to drop, with two branches for the plain and inverted conditions. It now walks an index back from the end, with one condition.

## What changed

- `rtrim` keeps the index of the last character to keep and slices to it. The two branches are one comparison against `!!invert`.
- It still avoids the regex that the comment above it warns is open to ReDoS.
