## Intent

- `satisfies` rebuilt its `Range` on every call, even when the caller passed one it had already built. Tools that test thousands of versions against one range spend most of their time there. Use a `Range` that is passed in as it is.

## What changed

- `functions/satisfies.js`: a `Range` argument is used directly; anything else is parsed as before, and a range that does not parse still returns `false`.
