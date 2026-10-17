## Intent

- `compareIdentifiers` ends in a five-way nested ternary that is hard to check against the SemVer precedence rules. Rewrite it as early returns in the order the rules give. Behaviour is unchanged.

## What changed

- `internal/identifiers.js`: the mixed numeric and alphanumeric cases return first, then numeric identifiers are compared as numbers and the rest as strings.
