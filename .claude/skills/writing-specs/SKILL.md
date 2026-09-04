---
name: writing-specs
description: Guiding principles for writing and editing the specifications under docs/specs/ in this repository. Load BEFORE writing or editing any spec, and again before rewriting a section.
user-invocable: true
---

# Writing specs

Write a specification someone can build from.

## Structure

Fix the meaning of each heading level and hold to it:

- **H1** — document title. Exactly one per document.
- **H2** — a major topic. The primary unit of the document.
- **H3** — a sub-section within a topic, named for its content.
- **H4** — a subdivision of a sub-section, where one genuinely has parts.
- **H5 and deeper** — do not use. If you need a fifth level, the H2 is too broad
  and should be split.

Do not add, remove, rename, or reorder H2 sections unless asked. If a change
seems to need a new H2, say so in the reply and ask before adding it.

## Principles

- **The spec is a standalone document** — never reference the conversation,
  prior versions, or what was "discussed" or "decided"
- **State what the system does** — do not state what it doesn't do unless the
  exclusion is itself a requirement
- **No rationale** — unless it belongs in a dedicated "Decisions" or
  "Alternatives considered" section
- **When editing, rewrite the whole section** — do not append
- **Write for the reader** — who is reading this, and what do they need?
- **Start with the most useful information** — don't bury the lede
- **Show, don't tell** — code examples, commands, diagrams
- **Keep it current** — outdated docs are worse than no docs
- **Link, don't duplicate** — reference other sections instead of copying

## Resources

`docs/specs/review-harness-spec.md` is the worked example.
