## Intent

- `Renderer.list` built its output by concatenation and an index loop. It now destructures the token and uses a template.

## What changed

- The items are rendered with `map` and joined.
- The `start` attribute is written only for an ordered list that does not start at the default.
