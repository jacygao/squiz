---
name: planning-milestones
description: How a release's GitHub milestone becomes issues each small enough for one pull request, with their blockers set. Load BEFORE planning a release or splitting its issues.
user-invocable: true
---

# Planning milestones

Turn one release's issues into work a person can disagree with before anybody
writes code.

A release is a GitHub milestone named by its version, such as `0.1.0`. The owner
decides which issues go in it. This skill makes each of them small enough for
one pull request, says which must wait for which, and stops.

## 1. Take the release from the argument

**The caller names the release. Never infer it.** The argument is a version such
as `0.1.0`.

With no argument, stop and ask which one, listing the open milestones so the
caller picks from what GitHub actually has:

```bash
gh api "repos/{owner}/{repo}/milestones?state=open" \
  --jq '.[] | "\(.title)\t\(.open_issues) open"'
```

Do nothing else until the answer comes back. Which release to plan next is a
fact about what the caller intends to ship, and the repository does not hold it.

**The version names an open milestone.** If it does not, stop and say which
ones exist. Creating a release is the owner's call.

Then list its issues:

```bash
gh issue list --milestone 0.1.0 --state open --limit 200 \
  --json number,title,labels,parent \
  --jq '.[] | "#\(.number)\t\([.labels[].name] | join(","))\t\(.title)"'
```

Read issues with `--json` throughout, never the rendered text output. That
output is laid out for a person reading a terminal, and its shape is not a
contract; `--json` names fields you can test.

## 2. Read before deciding anything

- Every issue in the release, with its comments
- **Every specification section they cite.** An issue's paragraphs are
  pointers; `docs/specs/review-harness-spec.md` is what the work has to satisfy.
  Its H2 sections are numbered, so cite them by number
- Section 8 of that specification, "The project". It fixes the language rules
  and the `src/` layout. A subtask that invents a directory the layout does not
  have is a subtask in the wrong shape
- `AGENTS.md`
- `docs/notes/`, for anything already learned about the same surface, so a fact
  is not re-derived

If an issue cannot be done from the specification, that is a gap in the
specification. Raise it as a question in step 5. Do not invent the answer and do
not design around it: a result that contradicts the specification is reconciled
in the specification.

## 3. Split what is too large

Most issues are already one pull request. Split only an issue that is not.

One subtask is **one isolated, complete purpose**:

- **Independently green.** It type-checks, its tests pass, and merging it alone
  cannot break `main`. Squiz has no build step, so compiling is not the bar and
  `npm run typecheck` is. A part that only type-checks once its sibling lands
  is not a part
- **`main` stays releasable** after it merges
- **Describable in one sentence with no "and".** If the sentence needs an "and",
  it is two subtasks. This is the test that catches most of them

Split at a seam, not at a line count: a directory under `src/` with its own
reason to change, a pure transform under an I/O wrapper, a decision one part
makes and the next consumes. Put the dangerous code in its own subtask, away
from the large mechanical thing sitting next to it. A change reviewed on its own
gets read line by line, and the same change inside a large mechanical diff does
not.

A subtask that adds tested code nothing calls yet is fine. An issue is the unit
that ends in something you can run or see. A subtask is the unit somebody
reviews in one pull request. They are different sizes on purpose.

Then work out the dependency graph across the whole release, split issues and
whole ones alike. **Which are genuinely sequential, and which only look
sequential because of the order you thought of them?** The graph is routinely
looser than it first appears, and independent work can be reviewed at the same
time and merged in any order. Where two touch the same line of a shared file,
say so in both issues, because the second to merge needs a rebase.

## 4. File the subtasks and the blockers

**Load the `writing-issues` skill** before the first `gh issue create`. It owns
the body. What follows is only what is specific to splitting an issue.

The issue being split becomes the parent. Add a `## Decomposition` section to
its body saying why these seams and not others, and leave its own acceptance
criteria as they are. **Do not list the children in it.** They are attached as
sub-issues and GitHub renders them. A hand-written copy does not tick and goes
stale.

One sub-issue per subtask:

- Title: the one-sentence purpose, imperative mood
- Acceptance criteria as a checklist, ending with `npm run typecheck` and
  `npm test`
- Reference: the specification sections that govern it, by number
- Labels: `task` or `bug`, and the parent's priority
- Milestone: the parent's

```bash
gh issue create --title "<one line, imperative>" --label task --label P1 \
  --milestone 0.1.0 --parent 42 --body "<body>"

gh issue edit 45 --add-blocked-by 43 --add-blocked-by 44
```

Blockers come last because a dependency is set by issue number, and a number
does not exist until the issue is filed. Set **every** sequential dependency
in the release, between whole issues as well as subtasks.

Verify before moving on. A sub-issue that failed to attach looks exactly like one
that was never filed, and a blocker that failed to post looks exactly like an
issue that never had one:

```bash
gh issue view 42 --json subIssuesSummary --jq '.subIssuesSummary.total'

gh issue list --milestone 0.1.0 --state open --limit 200 \
  --json number,title,blockedBy \
  --jq '.[] | "#\(.number) \(.title) — blocked by \(.blockedBy.totalCount)"'
```

The first must equal the number of subtasks you filed. The second must show, on
every row, the blocker count you set.

## 5. Present and stop

Print in the reply:

- Each issue in the release: number, title, priority, its sub-issues if it was
  split, and its blockers
- **The parallel frontier**: the issues with no open blocker and no open
  sub-issue, which can start now. Derive it from the repository rather than from
  memory
- Anything you could not resolve from the specification, as a question

```bash
gh issue list --milestone 0.1.0 --state open --limit 200 \
  --json number,title,blockedBy,subIssuesSummary \
  --jq '.[] | select(.subIssuesSummary.total == .subIssuesSummary.completed)
        | select([.blockedBy.nodes[] | select(.state == "OPEN")] | length == 0)
        | "#\(.number) \(.title)"'
```

Print the frontier. Do not store it in an issue. Readiness is true at the moment
it is computed and wrong after the next merge, so it belongs in a reply and
never in a body somebody will read later and believe.

Then **stop for human review**.

Do not begin implementation. Do not claim or assign any issue. Do not open a
branch or a pull request. The plan is the deliverable, and it is worth more when
a person has disagreed with it before anybody writes code.

## Resources

- `AGENTS.md`, under Releases — what a release, `Backlog` and each priority mean
- `docs/specs/review-harness-spec.md` — what the work has to satisfy, cited by
  H2 number
- `.github/ISSUE_TEMPLATE/task.md` — the sections an issue body is built from
- The `writing-issues` skill — how those sections are written
