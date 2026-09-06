---
name: writing-notes
description: How a durable finding is written in docs/notes/ in this repository. Load BEFORE writing or editing any note.
user-invocable: true
---

# Writing notes

Write a note a person can act on in one screen and a later milestone can build
from without re-running the work.

## Two audiences, in this order

A note is read twice. **A person, once**, deciding what to do about it, who
reads the top and stops. **A later milestone, months on**, needing an exact
string, shape or field, which skips to the reference and mines it.

Serve the person first and the machine below the fold. Neither is served by an
account of how the work was done.

## The file name is the index

Name the file for the verdict, not the subject: `cost-arrives-during-a-run.md`,
not `pi-cost-reporting.md`. `ls docs/notes/` is then the whole index, it needs
no upkeep, and it cannot drift out of step with the directory.

Nothing central is updated when a note is added. Notes are written by several
subagents at once, and a shared index file would conflict every time.

## The template

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

## Needs a decision

<Only what a person must choose or act on. Say "Nothing" if nothing does.>

## Reference

<The exact field names, request shapes, command lines and identifiers a later
milestone reads instead of rediscovering.>

## Limits

<What was not established, so a clean result is not read as a wider one.>
```

Omit a section with nothing in it, except **Needs a decision**, which says
"Nothing" rather than disappearing.

`settles` points forward, at what the fact now governs, cited by H2 number.
`issue` points back, at what commissioned it. `recheck-when` names the upgrade
that would invalidate the finding, so `grep -L` finds what to re-run.

## Principles

- **Record what was settled, not how you settled it** — method, evidence and
  justification belong in the pull request body and the commit, which is where
  a reader goes when they doubt the finding
- **The verdict is the title, and the file name** — "Cost arrives during a run",
  not "Cost investigation findings"
- **Never compress the reference** — an exact field name, endpoint or id is the
  deliverable, and a summary of one costs the next milestone a re-run
- **What needs a person goes in the first screen** — a decision found on line
  200 is a decision missed
- **The note stands on its own** — `issue:` is for auditing a finding, never for
  understanding it. Never write "see #12 for the details"; a link out of the
  repository is the first thing to rot
- **A limit is a fact, not an apology** — name what was not established plainly
  and move on
- **Do not reconcile the spec here** — a note records the contradiction and
  names the section; changing `docs/specs/` is a separate decision
- **A finding is true of a version** — record what it was checked against, so a
  note that has gone stale can be found rather than trusted

## Resources

- `docs/specs/review-harness-spec.md` — cited by H2 number, never by title
- The `writing-pull-requests` skill — where the method and the evidence go
  instead
