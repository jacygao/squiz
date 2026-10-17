## Intent

- A build that always wants loose parsing has to pass `-l` on every `semver` call. Let the `SEMVER_OPTIONS` environment variable carry default options as a JSON object. A flag on the command line still sets its option.

## What changed

- `bin/semver.js` reads `SEMVER_OPTIONS` for `loose`, `includePrerelease` and `rtl`. A value that is not JSON, or not an object, fails with a message on stderr and exit 1.
- The help text, the README's copy of it and the help snapshots document the variable.
- Tests for loose by default, an empty object, invalid JSON and a value that is not an object.
