---
name: planning-milestones
description: How a milestone in docs/specs/milestones.md becomes an epic issue and one sub-issue per subtask. Load BEFORE planning a milestone or filing its issues.
user-invocable: true
---

# Planning milestones

Turn one milestone into an issue tree a person can disagree with before anybody
writes code.

This skill **plans only**. It ends at a reviewable tree and stops.

## 1. Choose the milestone

An argument may name one, such as `M2`. Use it if given.

With no argument, the current milestone is **the first section in
`docs/specs/milestones.md` whose epic issue is not closed**. An epic is an issue
with no parent whose title starts with the milestone id:

```bash
gh issue list --state all --limit 200 --json number,title,state,parent \
  --jq '.[] | select(.parent == null) | "\(.state)\t#\(.number)\t\(.title)"'
```

Read issues with `--json` throughout, never the rendered text output. That
output is laid out for a person reading a terminal, and its shape is not a
contract; `--json` names fields you can test.

A milestone with no epic issue at all counts as not closed, so an unstarted
milestone is selectable. Read the file top to bottom and take the first match.
The file is in build order, and its own opening says the milestones are in the
order they are done.

**Say which milestone you selected and why before doing anything else.** If the
selection is ambiguous, or the first open epic is not the milestone the file
implies, stop and ask rather than guessing.

## 2. Read before decomposing

- The milestone's own section in `docs/specs/milestones.md`, including its
  acceptance criteria
- **Every specification section it references.** The milestone's paragraphs are
  pointers; `docs/specs/review-harness-spec.md` is what the work has to satisfy.
  Its H2 sections are numbered, so cite them by number
- Section 8 of that specification, "The project". It fixes the language rules,
  the `src/` layout, and which parts are P0, P1 and P2. A subtask that invents a
  directory the layout does not have is a subtask in the wrong shape
- `AGENTS.md`
- `docs/notes/`, once it exists, for anything already learned about the same
  surface, so a fact is not re-derived

If a subtask cannot be derived from the specification, that is a gap in the
specification. Raise it as a question in step 5. Do not invent the answer and do
not design around it: M0 sets the precedent that a result contradicting the
specification is reconciled in the specification.

## 3. Decompose

One subtask is **one isolated, complete purpose**:

- **Independently green.** It type-checks, its tests pass, and merging it alone
  cannot break `main`. Squiz has no build step, so compiling is not the bar and
  `tsc --noEmit` is. A part that only type-checks once its sibling lands is not
  a part
- **`main` stays releasable** after it merges
- **Describable in one sentence with no "and".** If the sentence needs an "and",
  it is two subtasks. This is the test that catches most of them

Split at a seam, not at a line count: a directory under `src/` with its own
reason to change, a pure transform under an I/O wrapper, a decision one part
makes and the next consumes. Put the dangerous code in its own subtask, away
from the large mechanical thing sitting next to it. A change reviewed on its own
gets read line by line, and the same change inside a large mechanical diff does
not.

A subtask that adds tested code nothing calls yet is fine. A milestone is the
unit that ends in something you can run or see. A subtask is the unit somebody
reviews in one pull request. They are different sizes on purpose.

Then work out the dependency graph. **Which subtasks are genuinely sequential,
and which only look sequential because of the order you thought of them?** The
graph is routinely looser than it first appears, and independent parts can be
reviewed at the same time and merged in any order. Where two touch the same line
of a shared file, say so in both issues, because the second to merge needs a
rebase.

## 4. File the issues

**Load the `writing-issues` skill** before the first `gh issue create`. It owns
the body: which template sections to keep, and how each is written. What follows
is only what is specific to a milestone tree.

The label the tree is pulled by does not exist until it is made. Create it
first, which is safe to repeat:

```bash
gh label create "milestone:M2" --color ededed \
  --description "M2 — The finding contract and the comment format" --force
```

One **epic** issue for the milestone:

- Title: the milestone's heading verbatim, `M2 — The finding contract and the
  comment format`. Step 1 finds it by the id prefix
- Purpose: one sentence saying what the milestone delivers
- A `## Decomposition` section: why these seams and not others. The task
  template has no such section, and the epic gets one anyway, because the epic
  is not a unit of work and its reason for existing is the argument it carries
- The milestone's acceptance criteria, verbatim, as the checklist
- Reference: the specification sections the milestone spans, by number
- Labels: `task` and `milestone:<id>`
- **No list of children.** They are attached as sub-issues below and GitHub
  renders them. A hand-written copy does not tick and goes stale

One **sub-issue** per subtask:

- Title: the one-sentence purpose, imperative mood
- Acceptance criteria as a checklist, ending with the type check and the tests,
  named by the command that runs them: `tsc --noEmit`, and whatever
  `package.json` defines. M1 is the milestone that puts both in CI, so a
  sub-issue filed before it lands names the command its own work creates. M0 is
  a spike with no production code and has neither; its criteria are the written
  findings in `docs/notes/`
- Reference: the specification sections that govern it, by number
- Labels: `task` or `bug`, and `milestone:<id>`
- **Every** sequential dependency, set as a blocker once the issues exist

Create the epic, then each sub-issue with `--parent`, then the blockers:

```bash
gh issue create --title "<one line, imperative>" \
  --label task --label "milestone:M2" --parent 42 --body "<body>"

gh issue edit 45 --add-blocked-by 43 --add-blocked-by 44
```

Blockers come last because a dependency is set by issue number, and a number
does not exist until the issue is filed. `--parent` is passed at creation
instead, because the epic is already filed by then.

Verify the tree before moving on. A sub-issue that failed to attach looks
exactly like one that was never filed, and a blocker that failed to post looks
exactly like a subtask that never had one:

```bash
gh issue view 42 --json subIssuesSummary --jq '.subIssuesSummary.total'

gh issue list --label "milestone:M2" --state all --limit 100 \
  --json number,title,parent,blockedBy \
  --jq '.[] | select(.parent != null)
        | "#\(.number) \(.title) — blocked by \(.blockedBy.totalCount)"'
```

The first must equal the number of subtasks you filed. The second must show, on
every row, the blocker count you set.

## 5. Present and stop

Print the tree in the reply:

- Epic number and title
- Each sub-issue: number, title, and its blockers
- **The parallel frontier**: the sub-issues with no open blocker, which can start
  now. Derive it from the repository rather than from memory
- Anything you could not resolve from the specification, as a question

```bash
gh issue list --label "milestone:M2" --state open --limit 100 \
  --json number,title,parent,blockedBy \
  --jq '.[] | select(.parent != null)
        | select([.blockedBy.nodes[] | select(.state == "OPEN")] | length == 0)
        | "#\(.number) \(.title)"'
```

Print the frontier. Do not store it in the epic. Readiness is true at the moment
it is computed and wrong after the next merge, so it belongs in a reply and
never in a body somebody will read later and believe.

Then **stop for human review**.

Do not begin implementation. Do not claim or assign any issue. Do not open a
branch or a pull request. The decomposition is the deliverable, and it is worth
more when a person has disagreed with it before anybody writes code.

## Resources

- `docs/specs/milestones.md` — the milestones in build order, each with the
  acceptance criteria its epic copies
- `docs/specs/review-harness-spec.md` — what the work has to satisfy, cited by
  H2 number
- `.github/ISSUE_TEMPLATE/task.md` — the sections an issue body is built from
- The `writing-issues` skill — how those sections are written
