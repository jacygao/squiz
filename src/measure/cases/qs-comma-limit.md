## Intent

- With `comma: true` and `throwOnLimitExceeded: true`, `parseArrayValue` counted commas in a loop to enforce `arrayLimit`, then split the value anyway. It now splits once and checks the number of elements.

## What changed

- `parseArrayValue` in `lib/parse.js` splits the value, and throws the same `RangeError` as before when there are too many elements.
