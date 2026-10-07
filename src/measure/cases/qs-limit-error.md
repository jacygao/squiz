## Intent

- The `RangeError` for an exceeded array limit was built from the same string expression in ten places across `lib/parse.js` and `lib/utils.js`. It is now built in one.

## What changed

- `utils.arrayLimitError(limit)` returns the error, and every site throws what it returns. The message is unchanged.
