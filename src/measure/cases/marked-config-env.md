## Intent

- A CI job that runs `marked` in several steps has to repeat `--config` on each. Let the `MARKED_CONFIG` environment variable name the config file when `--config` is not given, before the defaults in the home directory are tried.

## What changed

- `bin/main.js`: without `--config`, a file named by `MARKED_CONFIG` is loaded as `--config` would load it, and a name that does not exist fails as a missing `--config` file does.
- The man page documents the variable.
- Tests for a config named by the variable and for a missing one.
