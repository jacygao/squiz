## Intent

- In the `comma` array format, `stringify` built the joined value with a ternary on the array's length, as if an empty array were special. A join is already the empty string for an empty array, so the ternary goes.

## What changed

- The comma branch of `stringify` in `lib/stringify.js` joins the elements and sends an empty join as `null`, as it already did for an array of empty elements.
