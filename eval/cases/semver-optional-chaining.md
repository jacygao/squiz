## Intent

- Tidy three guard expressions with optional chaining and logical assignment. Behaviour is unchanged.

## What changed

- `functions/prerelease.js`: `parsed && parsed.prerelease.length` becomes `parsed?.prerelease.length`.
- `functions/coerce.js`: `options = options || {}` becomes `options ??= {}`.
- `ranges/subset.js`: both `c.semver.prerelease && c.semver.prerelease.length` checks become `c.semver.prerelease?.length`.
