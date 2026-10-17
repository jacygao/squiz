## Intent

- `maxSatisfying` and `minSatisfying` each keep a running best and build a `SemVer` for every new best. Filter the matching versions and sort them instead, which reads as what the functions do. Behaviour is unchanged.

## What changed

- `ranges/max-satisfying.js` and `ranges/min-satisfying.js`: filter by the range, sort, and take the last or the first. An invalid range still returns `null`.
- A test that `maxSatisfying` picks the highest of several unsorted versions.
