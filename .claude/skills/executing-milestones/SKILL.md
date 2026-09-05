---
name: executing-milestones
description: How a planned milestone's issues become worktrees, subagent briefs, and verified pull requests. Load BEFORE dispatching implementation work to subagents.
user-invocable: true
---

# Executing milestones

You are running the work, not writing it. Subagents write the code. You decide
what gets built next, brief them so the parts that fail silently get attention,
and **check what comes back**.

This skill starts where `planning-milestones` stops. That skill ends at a
reviewable issue tree and files nothing else; this one executes the tree it
filed.

Two shapes of work arrive here, and everything from section 2 onward is the same
for both:

- **A milestone.** An epic and its sub-issues, already filed. If the milestone
  has no epic, run `planning-milestones` first and stop there for review.
- **Anything else.** A bug, a spec correction, a task carrying no milestone
  label. One issue, one brief, one pull request.

## 1. Take the work from the argument, never from inference

**The caller names the milestone or the issue.** Which one to execute next is a
fact about what the caller intends to build, and the repository does not hold
it. Do not infer it from which epic is open, from the order of
`docs/specs/milestones.md`, or from what was planned last.

A fresh session does not know what merged since the last one, so bring the tree
and the open pull requests current before answering on any of the three paths
below:

```bash
git fetch -q origin && git checkout -q main && git pull -q
gh pr list --state open --json number,title --jq '.[] | "#\(.number) \(.title)"'
```

**Given no argument**, report and stop. Reporting is not executing. Name the
open epics, so the caller has something to choose from, and the work outside
them, which no epic's frontier can see:

```bash
gh issue list --state open --limit 100 --json number,title,parent \
  --jq '.[] | select(.parent == null) | "epic     #\(.number)  \(.title)"'

gh api "repos/{owner}/{repo}/issues?state=open&per_page=100" --paginate --jq '
  .[] | select(.pull_request == null)
      | select([.labels[].name] | any(. == "bug" or . == "needs-human"))
      | "outside  #\(.number)  \(.title)"'
```

The `pull_request == null` filter is not optional. That endpoint returns pull
requests alongside issues, and a pull request carries no dependency summary, so
a query without it reads every open pull request as ready work.

**Given an issue number or a description**, read that issue and every
specification section it cites, then go to section 2.

**Given a milestone id**, find its epic — the issue with no parent carrying
that milestone's label, which is exact where matching a title is not:

```bash
milestone=M0
epic=$(gh issue list --label "milestone:$milestone" --state all --limit 100 \
  --json number,parent --jq '.[] | select(.parent == null) | .number')
```

Nothing back means the milestone has not been planned. Two numbers back means
two epics for one milestone, which splits the tree. Either way, say so and stop.

Then read the frontier, the sub-issues with no open blocker. **Readiness is true
at the moment it is computed and wrong after the next merge**, so compute it
here and never carry it forward:

```bash
gh issue list --label "milestone:$milestone" --state open --limit 100 \
  --json number,title,parent,blockedBy \
  --jq '[.[] | select(.parent != null)] | sort_by(.number) | .[]
        | "\(if ([.blockedBy.nodes[] | select(.state == "OPEN")] | length) == 0
             then "READY  " else "blocked" end)  #\(.number)  \(.title)"'
```

**Check that list against the epic before believing it.** It is served from a
search index that lags behind the issues themselves, and this repository has
already produced one that omitted sub-issues the epic knew about. The sub-issues
API is not served from that index:

```bash
gh api "repos/{owner}/{repo}/issues/$epic/sub_issues" --paginate \
  --jq '[.[] | select(.state == "open") | .number] | "open: \(.)"'
```

A number here that the frontier did not list is a sub-issue the listing cannot
yet see. Read those with `gh issue view <n> --json blockedBy` rather than
waiting for the index.

## 2. Give each piece of work its own worktree

One worktree, one branch, one pull request, one issue. This is the shape Squiz
itself requires: the harness resolves an episode by
`git rev-parse --show-toplevel`, so two subagents working in one tree read as
one shared tree, and the tracked-file comparison under Confinement is disabled
for that round. Section 3 of the specification says the
worktrees are created by whatever dispatches the subagents. That is this
session.

```bash
git worktree add -b <area>/<short-name> .claude/worktrees/i<issue> origin/main
```

- **The primary tree stays on `main` and never switches branches.** Every
  worktree and every dispatched agent reads it.
- **Branches are named `<area>/<short-name>`**, matching those already in the
  repository: `spec/identity`, `templates/pr-and-issue`.
- `.claude/worktrees/` is already in `.gitignore`.
- **Remove the worktree once its pull request merges**, with
  `git worktree remove .claude/worktrees/i<issue>`. A stale worktree holds a
  branch checked out, and the next agent that wants that branch fails for a
  reason that reads like something else.

**Take the baseline before dispatching, not before answering.** Run the checks
`main` has and keep the result. Its one job is attribution: if `main` is already
red and you fan out four agents, all four report a failing suite, none of them
caused it, and nothing in their reports says so. A baseline is what lets you
tell a subagent's breakage from an inherited one in section 4.

Squiz has no build step by design — Node strips the types and runs the `.ts`
files as they are — so nothing checks the types unless something is run that
checks them. That is `tsc --noEmit`, and the tests are whatever `package.json`
defines. Where the repository does not have them yet, the baseline is empty, and
that is a fact to state rather than a gap to fill with an invented check. M1,
the plugin skeleton, is the milestone that creates them and puts both in CI.

**Dispatch the whole frontier at once**, as one agent call per issue in a
single message, so they run concurrently. Issues with no open blocker are
independent by construction, and running them one at a time wastes what the
decomposition bought. A blocked issue is not dispatched, because its
blocker's result is an input to it and not merely an ordering.

Where two issues on the frontier touch the same file, say so in both briefs. The
second to merge rebases, and an agent told to expect that handles it without
asking.

## 3. Brief a subagent with the failures, not the task

A brief that says what to build gets code that compiles. A brief that names what
will go wrong silently gets code that works.

Every brief carries:

- The issue number, and the specification sections that govern it, cited by H2
  number, to be read in full
- `AGENTS.md`, which requires the `writing-pull-requests` skill before
  `gh pr create` and the `writing-issues` skill before `gh issue create`
- `docs/notes/` for what earlier work already settled. A fact established there
  is read, not re-derived
- Section 8 of the specification, which fixes the language rules and the `src/`
  layout. Erasable syntax only, and a subtask that invents a directory the
  layout does not have is in the wrong shape
- **The specific silent failures.** For this project they are mostly places
  where a broken thing and a correct thing produce the same output: the hook
  exits 0 on every failure path by design, so a hook that throws looks exactly
  like a branch with no pull request. Name what tells the two apart
- What to prove rather than assume, and to file a `needs-human` issue instead of
  shipping something it could not verify
- **The pull request body ends at its last real section.** No generated-with
  footer, no session link, no co-author trailer, in the body or in the commits
- The worktree it was given, which it works in and never leaves
- Report back: the pull request number, the checks it ran with their output,
  what it filed, and **what it could not determine**

**An agent that reports what it could not determine has done its job.** That
answer is yours to resolve, not theirs to guess:

- It could not reach something you can. Fetch it and hand it over.
- It could not verify a claim the code rests on. File `needs-human` and say what
  would settle it.
- It stopped rather than inventing. Say so when you relay the result, because it
  is the outcome you asked for.

**A result that contradicts the specification is reconciled in the
specification, not worked around.** M0, the prerequisites spike, sets that
precedent in its own acceptance criteria. Reconciling means loading
`writing-specs` and, because a specification change is a decision about the
product, bringing it to the caller.

## 4. Verify what comes back. Do not take the report

An agent's report is a claim. Check it in a worktree of its own, detached, so
nothing you do disturbs the branch:

```bash
git worktree add -q .claude/worktrees/verify-<n> origin/<branch> --detach
```

Run the repository's checks there and compare them against the baseline you took
before dispatching. A failure present in both is inherited, and chasing it in
this branch is wasted work.

Then **mutation-test the guard that matters**. Delete the check, run the suite,
confirm something fails, restore it.

This matters most where the failure paths are deliberately quiet. Delete the
pull request gate and run the suite: if it stays green, the tests are asserting
that nothing happened, which is also what the gate produces when it works. Green
tests are not evidence that a guard is held; a test can pass because it broke
something else on the way to the guard.

Remove the verification worktree when done.

Until Squiz reviews its own pull requests, this session is the only review the
code gets before a person sees it.

## 5. Report in plain words

Subagents write for other agents. You are writing for somebody deciding what to
merge, and making them decode a mechanism to reach that decision is the slowest
step in the loop.

- **Lead with the verdict**, one sentence, before any detail.
- **Name a problem by what it costs**, not by the mechanism behind it.
- **Earn each technical term.** Reach for one only after the plain sentence it
  rests on, and only where no ordinary word does the job.
- **Give a number something to sit against.** `$0.04` is trivia; `$0.04 of the
  $0.10 an episode may cost` is a decision.

The test: could somebody who has not read the diff act on your first paragraph?
If not, the first paragraph is the thing to rewrite. The pull request body
itself is governed by `writing-pull-requests`, not by this section.

## 6. Decide, or ask

**Decide anything recoverable from the specification, the code, or a
measurement.** Which frontier issues go out together, how the briefs are
written, which guard to mutation-test, whether a finding is fixed here or filed
as its own issue.

**Ask anything that trades cost against product.** A runtime dependency, since
the specification says there are none and adding one changes the document. A
default in `.squiz.json`. What a user-facing string says. Whether a milestone's
scope moves. Deciding these builds the wrong product confidently.

When asking, bring a recommendation and the reason, not a menu. When you have
already argued a position and it is overruled, implement the decision.

## 7. What needs a person

File it as `needs-human` rather than mentioning it in a reply that scrolls away.
The label does not exist until it is made, and creating it is safe to repeat:

```bash
gh label create needs-human --color fbca04 \
  --description "Blocked on something only a person can do" --force
```

Anything that needs a credential, changes a repository setting, installs or
publishes the plugin, spends money beyond the episode budget, or needs an
artefact downloaded by hand.

## 8. Standing rules

- **Merged is not loaded.** A Claude Code session reads the plugin once, when it
  starts. A merged change reaches a running session only when that session is
  restarted against it with `claude --plugin-dir ./`.
- **A number comes with the command that reproduces it.** Label a prediction as
  a prediction. When a measurement disagrees with one, say so plainly.
- **Read the specification before judging.** It governs reviews as well as
  authorship, and it is cited by H2 number.
- **Prefer cutting.** State the decision and its one-clause reason; the argument
  that produced it belongs in the commit or the issue.
- **Push back once, with reasons, then implement the decision.** Disagreement is
  a conversation, not a veto in either direction.

## 9. Stop and hand back

At the end of a stretch of work, report what merged, what is open, what each
open pull request is waiting on, and what needs the caller specifically.

Do not start the next milestone without being asked.

## Resources

- `docs/specs/milestones.md` — the milestones in build order
- `docs/specs/review-harness-spec.md` — what the work has to satisfy, cited by
  H2 number
- `docs/notes/` — facts already settled by earlier work
- `AGENTS.md` — the skills a subagent is required to load, and when
- The `planning-milestones` skill — how the tree this skill executes was built
- The `writing-issues` and `writing-pull-requests` skills — how anything filed
  from this work is written
