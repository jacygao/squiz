---
name: writing-notes
description: How a durable finding is written in docs/notes/ in this repository. Load BEFORE writing or editing any note.
user-invocable: true
---

# Writing notes

Write a note a person can act on in one screen and a later milestone can build
from without re-running the work.

## The template

Name the file for the verdict, not the subject: `cost-arrives-during-a-run.md`,
not `pi-cost-reporting.md`. Listing the directory is then the whole index, and
there is no central file to update when a note lands. Notes are written by
several subagents at once, and a shared index would conflict every time.

```markdown
---
settles: "§ 8 — whether pi reports cost during a run"
issue: 12
recorded: 2026-09-06
versions: { pi: 0.84.2 }
recheck-when: pi upgrades
---

# <the verdict, as the title>

<Two or three sentences: what holds, what does not, and what it costs.>

## Decisions

<What the work settled. A person reviews these; they do not choose them.>

## Needs your input

<What is still open and cannot be settled without a person, each with a
recommendation. Say "Nothing" rather than omitting the section.>

## Reference

<Only what someone needs in order to act on the decisions above: field names,
endpoints, required parameters, the trap that would otherwise be rediscovered.>

## Limits

<What was not established, so a clean result is not read as a wider one.>
```

Omit a section with nothing in it, except **Needs your input**, which says
"Nothing" rather than disappearing. Its absence would be ambiguous between
nothing being needed and the author forgetting to ask.

`settles` points forward, at what the fact now governs, cited by H2 number.
`issue` points back, at what commissioned it. `recheck-when` names the upgrade
that would invalidate the finding, so `grep -L` finds what to re-run.

## Principles

- **Record what was settled, not how** — method, evidence, tables and what was
  tried go in the pull request
- **Never summarise an exact field name, endpoint or id** — the string is the
  deliverable
- **Mark a reference value you did not see in output** as `(unverified)`, so a
  plausible guess is never read as an observation
- **Never write "see #12 for the details"** — the note stands on its own, and a
  link out of the repository is the first thing to rot
- **State a limit plainly** — it is a fact, not an apology
- **Record a contradiction with `docs/specs/` and name the section** — do not
  edit the spec; reconciling it is a separate decision

## Resources

- `docs/specs/review-harness-spec.md` — cited by H2 number, never by title
- The `writing-pull-requests` skill — where the method and the evidence go
  instead
