## Intent

- `minVersion` handled a `>` comparator with two branches, bumping the patch for a release and appending `0` for a prerelease. `SemVer.inc('patch')` already gives the next version up from either, so the branches are replaced by it.

## What changed

- `ranges/min-version.js`: a `>` comparator's version is bumped with `inc('patch')`.
