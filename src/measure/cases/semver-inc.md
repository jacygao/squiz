## Intent

- In `SemVer.inc`'s `pre` case, the loop that finds the last numeric prerelease identifier counted down and signalled success by setting its index to -2. It now uses `findLastIndex`.

## What changed

- `classes/semver.js`: the last numeric identifier is found with `findLastIndex` and incremented. Where there is none, the existing branch that appends the base runs as before.
