## Intent

- `parse` bounds the number of parameters and the length of arrays, but not the length of a key. Add a `maxKeyLength` option, 1000 characters by default, so that a parameter with an enormous key is dropped, or throws with `throwOnLimitExceeded`.

## What changed

- `maxKeyLength` in `parse`'s defaults and options.
- `parseValues` skips a parameter whose key is longer than `maxKeyLength`, or throws a `RangeError` when `throwOnLimitExceeded` is set.
- The README documents the option beside `parameterLimit`.
- Tests for dropping and for throwing.
