## Intent

- Add a `trimValues` option to `parse`, off by default, that trims the whitespace around each decoded value, so that form input such as `name=%20Ada%20` need not be trimmed by every caller.
- Add an `AGENTS.md` describing how to work in this repository.

## What changed

- `trimValues` in `parse`'s defaults and options; `parseValues` trims a string value when it is set.
- The README documents the option.
- A test for trimming on and off.
- `AGENTS.md`, new.
