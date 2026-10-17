## Intent

- `parse` bounds the number of parameters, the depth of keys and the length of arrays, but not the length of a value. Add a `maxValueLength` option, 10000 characters by default, so that a parameter with an enormous value is dropped, or throws with `throwOnLimitExceeded`.

## What changed

- `maxValueLength` in `parse`'s defaults and options.
- `parseValues` skips a parameter whose decoded value is longer than `maxValueLength`, or throws a `RangeError` when `throwOnLimitExceeded` is set.
- The README documents the option beside `parameterLimit`.
- Tests for dropping and for throwing.
