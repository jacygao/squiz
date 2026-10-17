## Intent

- `parseValues` builds three regular expressions on every call. Build them once, at module load. Behaviour is unchanged.

## What changed

- `lib/parse.js`: the query-prefix and encoded-bracket expressions are module-level constants, used where the literals were.
