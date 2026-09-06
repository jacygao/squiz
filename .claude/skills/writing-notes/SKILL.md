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

**Reference supports a decision; it never justifies one.** A field name someone
needs in order to write the code belongs there. A measurement, a comparison
table, or a record of what was tried does not, however much work it took — that
is how the decision was reached, and it goes in the pull request. Reference that
argues rather than informs is what turns a note into something nobody reads.

`settles` points forward, at what the fact now governs, cited by H2 number.
`issue` points back, at what commissioned it. `recheck-when` names the upgrade
that would invalidate the finding, so `grep -L` finds what to re-run.

## Principles

- **Serve the person first, the next milestone second** — a note is read twice:
  by a person deciding what to do, who reads the top and stops, and by a later
  milestone that skips to the reference and mines it for an exact string
- **Record what was settled, not how you settled it** — method, evidence and
  justification belong in the pull request body and the commit, which is where
  a reader goes when they doubt the finding
- **The verdict is the title, and the file name** — "Cost arrives during a run",
  not "Cost investigation findings"
- **Reference informs, it does not argue** — keep what a reader must have to act,
  drop what shows how you got there; a note is not a defence of its own findings
- **Never compress what survives that cut** — an exact field name, endpoint or id
  is the deliverable, and a summary of one costs the next milestone a re-run
- **Separate what was settled from what is still open** — a person reviews the
  first and answers the second, and being unable to tell them apart costs them
  the time the note was meant to save
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
