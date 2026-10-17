## Intent

- Add a `headingIds` option, off by default, that gives each heading an `id` made from its text, so that a link can point at a section.

## What changed

- `headingIds` in `MarkedOptions`, defaulting to `false`.
- `Renderer.heading` writes `id="…"` when the option is on. The id is the heading's text in lower case, with each run of whitespace as one hyphen.
- The option is documented in `docs/USING_ADVANCED.md`.
- Unit tests for the default and for the id.
