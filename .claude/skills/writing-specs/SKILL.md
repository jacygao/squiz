---
name: writing-specs
description: Guiding principles for writing and editing the specifications under docs/specs/ in this repository. Load BEFORE writing or editing any spec, and again before rewriting a section.
user-invocable: true
---

# Writing specs

1. **The spec is a standalone document.** Never reference the conversation, prior
   versions, or what was "discussed" or "decided".

2. **State what the system does.** Do not state what it doesn't do unless the
   exclusion is itself a requirement.

3. **No rationale** unless it belongs in a dedicated "Decisions" or "Alternatives
   considered" section.

4. **When editing, rewrite the whole section.** Do not append.

5. **Write for the reader.** Who is reading this, and what do they need?

6. **Start with the most useful information.** Don't bury the lede.

7. **Show, don't tell.** Code examples, commands, screenshots.

8. **Keep it current.** Outdated docs are worse than no docs.

9. **Link, don't duplicate.** Reference other docs instead of copying.

## Document structure

### Heading levels

Fix the meaning of each heading level and hold to it:

- **H1** — document title. Exactly one per document.
- **H2** — a major topic. The primary unit of the document.
- **H3** — a sub-section within a topic, named for its content.
- **H4** — a subdivision of a sub-section, where one genuinely has parts.
- **H5 and deeper** — do not use. If you need a fifth level, the H2 is too broad
  and should be split.

Do not add, remove, rename, or reorder H2 sections unless asked. If a change
seems to need a new H2, say so in the reply and ask before adding it.
