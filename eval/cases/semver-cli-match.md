## Intent

- Let the `semver` command filter versions by their text as well as by range, so that a script can keep, say, only the `-beta` versions of a list without a second tool.

## What changed

- `bin/semver.js` takes `-m` / `--match <pattern>`, a regular expression. It may be given more than once, and a version must match every pattern. A pattern that is not a valid regular expression fails with a message on stderr and exit 1, as other invalid input does.
- The help text, the README's copy of it and the help snapshots name the option.
- Tests for one pattern, two patterns, no match and an invalid pattern.
