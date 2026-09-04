---
name: writing-issues
description: How an issue is written in this repository. Load BEFORE running gh issue create.
user-invocable: true
---

# Writing issues

Write an issue that says what done looks like.

## The templates

`gh issue create --body` bypasses the repository templates: GitHub applies
`.github/ISSUE_TEMPLATE/` to the web UI only. Read `task.md` or `bug.md` there
and use the sections that have something worth saying. Skip the YAML
frontmatter, which is for GitHub rather than for the body.

Two kinds, each with the matching label:

- **`task`** — a unit of work, with the criteria that say when it is done
- **`bug`** — what happens, what should happen, and a command that reproduces it

## Principles

- **Write for the reader** — who is reading this, and what do they need?
- **Every section is optional** — keep one because it says something a reader
  needs, not because the template lists it
- **Purpose is one sentence** — if it needs two, it is probably two issues
- **`Blocked by #N` is plain text, one per line** — a ticked box means the work
  is done; a blocker is a fact about ordering

## Resources

````bash
gh issue create --title "<one line, imperative>" --label task --body "$(cat <<'EOF'
<the sections worth keeping, from .github/ISSUE_TEMPLATE/task.md, comments removed>
EOF
)"
````

````bash
gh issue create --title "<one line, the symptom>" --label bug --body "$(cat <<'EOF'
<the sections worth keeping, from .github/ISSUE_TEMPLATE/bug.md, comments removed>
EOF
)"
````
