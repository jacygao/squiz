## Intent

- `SemVer.comparePre` compared prerelease identifiers in a `do … while (++i)` loop that relied on returning from inside it. It now loops over the identifiers both versions have, and settles a tie by which version has more.

## What changed

- `classes/semver.js`: `comparePre` compares the shared identifiers in a `for` loop, then compares the two lengths with `compareIdentifiers`. Behaviour is unchanged.
