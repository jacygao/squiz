## Intent

- A server that reads a few known parameters still pays to parse every other one, and an attacker chooses how many there are. Add an `allowedKeys` option to `parse`: a list of top-level keys, and every parameter whose root key is not in it is dropped before it is parsed.

## What changed

- `allowedKeys` in `parse`'s defaults and options, `null` by default, which keeps every key.
- `parseValues` drops a parameter whose root key, the part before any `[`, is not listed.
- The README documents the option.
- A test that only the listed keys are kept.
