---
name: writing-pull-requests
description: How a pull request body is written in this repository. Load BEFORE running gh pr create.
user-invocable: true
---

# Writing pull requests

Write a pull request body a reviewer can act on.

## The template

`gh pr create --body` bypasses the repository template: GitHub applies
`.github/PULL_REQUEST_TEMPLATE.md` to the web UI only. Read that file and use
the sections that have something worth saying.

It is the only copy of the structure. Change the section list there, not here.

## Principles

- **Write for the reader** — who is reading this, and what do they need?
- **Every section is optional** — keep one because it says something a reader
  needs, not because the template lists it
- **Every line earns its place** — one honest sentence beats three obvious ones,
  and nothing should restate what the diff already shows
- **Bullets, not paragraphs** — a reader should not have to parse a paragraph to
  find the three facts inside it
- **`Closes #N` sits in Intent** — the link belongs with the reason, not in a
  footer
- **Grade each risk high or low** — something unverified, undecided or deferred
  is a note, not a risk
- **Verification names the command** — a transcribed measurement goes stale
  silently

## Resources

````bash
gh pr create --title "<one line, imperative>" --body "$(cat <<'EOF'
<the sections worth keeping, from .github/PULL_REQUEST_TEMPLATE.md, comments removed>
EOF
)"
````
