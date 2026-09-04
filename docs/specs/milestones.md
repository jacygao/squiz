# Milestones

**Version:** 0.1 (draft)
**Status:** For review
**Owner:** TBD

---

Ten milestones for building Squiz, in the order they are done. Each ends in
something that can be run or seen, never in a module written.

## M0 — Prerequisites spike

The confirmations named in the specification, run with `claude --plugin-dir ./`
against throwaway scaffolding. No production code survives this milestone. The
findings do.

### Acceptance criteria

A written finding in `docs/notes/` for each of:

- [ ] `SubagentStop` fires, exit 2 feeds its reason back into the subagent's
      open turn, and the subagent resumes.
- [ ] **The hook payload's fields, named exactly.** An episode is keyed on the
      subagent's id from that payload. Confirm the field exists and is the same
      every time that subagent stops. If it does not exist, record the fallback
      key — worktree toplevel, branch, or pull request number are each viable,
      since there is one of each per episode — and amend the specification
      before M1.
- [ ] Whether `stop_hook_active` is set on re-entry. The loop re-blocks
      deliberately and must not be confused with the runtime's own loop guard.
- [ ] The hook's working directory resolves the right worktree, and two
      concurrent subagents are separated by `git rev-parse --show-toplevel`.
- [ ] `gh api` creates a review comment thread anchored to a file and line,
      replies inside it, and resolves and re-opens it, with the exact request
      shapes recorded.
- [ ] `pi --tools` withholds `edit` and `write`.
- [ ] Whether `pi` reports cost during a run or only at the end.

A result that contradicts the specification is reconciled in the specification,
not worked around.

## M1 — Plugin skeleton, configuration, and the gate

The repository becomes a loadable plugin with a `squiz` binary and a
`SubagentStop` hook that does the one thing needing no dependencies: gate on the
pull request and exit 0.

Covers the plugin manifest, the hook registration, `bin/` and `src/`,
`tsconfig.json`, `tsc --noEmit` and tests in CI, `.squiz/` in `.gitignore`,
`.squiz.json` loading with its five defaults and range validation, the top-level
trap that turns any throw into exit 0, and the single-line stderr reporter every
later milestone writes through.

### Acceptance criteria

- [ ] `claude --plugin-dir ./` loads the plugin and `squiz` resolves on the Bash
      tool's `PATH`.
- [ ] The hook exits 0 and posts nothing when the branch has no pull request,
      and finds the pull request when it has one.
- [ ] `.squiz.json` with no keys yields rounds 3, depth `deep`, timeout 420,
      budget 0.10 and no test command. An out-of-range `rounds` is rejected with
      a readable error.
- [ ] CI runs `tsc --noEmit` and the tests green, with no runtime dependencies.

`bin/squiz` cannot be an extensionless Node file: Node decides to strip types
from the `.ts` extension. It is a shell shim that execs `node src/cli.ts "$@"`.

## M2 — The finding contract and the comment format

Pure code, no input or output. The finding shape, the three verdicts and the
four terminal statuses, severity ordering, the comment renderer, and the routing
predicate that decides inline against general — which is a unified-diff parser
answering whether a given `file:line` is in the pull request's diff.

### Acceptance criteria

- [ ] A finding renders to the template in the specification, with and without
      the optional trailing reference, and reads correctly with it deleted.
- [ ] A line inside the diff routes inline; a line in an untouched file routes
      general.
- [ ] A thread the reviewer returned no verdict for resolves to `open`.
- [ ] The diff parser is tested against added, removed, context and multi-hunk
      cases.

## M3 — The GitHub client and the coding agent's commands

Everything that shells out to `gh`, and the three commands that make it
demonstrable before the loop exists: `squiz threads`, `squiz reply` and
`squiz resolve`.

Covers finding the pull request by head branch; fetching its number, base and
head refs, description and diff; listing review threads with their comments and
resolved state; creating an anchored review comment with `path`, `line`, `side`
and `commit_id`; replying in a thread; resolving and re-opening; and posting an
issue-level comment.

### Acceptance criteria

- [ ] Against a scratch pull request, `squiz threads` lists the open threads,
      `squiz reply` adds a reply that appears in the thread, and `squiz resolve`
      marks it resolved, visible in the next `squiz threads`.
- [ ] Every capability in the specification's GitHub access list has a tested
      call behind it, re-opening included.
- [ ] A failure returns a typed error rather than throwing, and a partial
      success is never reported as success.
- [ ] The thread identifier `squiz reply` and `squiz resolve` take is decided
      and recorded. It round-trips from `squiz threads` output and survives
      being copied by an agent.

This milestone needs a scratch repository and pull request to test against.

## M4 — The reviewer

`charter.md`, the `pi` adapter's `argv`, `parse` and `grants`, and the spawn
harness: working directory, `TMPDIR` at `.squiz/<episode>/scratch/`,
`< /dev/null`, the time bound, one parse retry, cost extraction, and the prompt
carrying the pull request, the existing threads and the configured test command.

### Acceptance criteria

- [ ] Run against a fixture repository with a seeded defect, the reviewer
      returns findings in M2's shape.
- [ ] A JSONL fixture at the scale the specification records parses with flat
      memory. Individual lines are large, so cheap type discrimination comes
      before `JSON.parse`.
- [ ] Depth `read` produces a command line without `bash`; `deep` includes it.
      The adapter never chooses depth for itself.
- [ ] A kill at the time bound records a failed round with no findings, distinct
      from an honest finding of nothing.
- [ ] Unparseable output is retried once, then treated as an unavailable API.
- [ ] `git status` of the fixture tree is clean after a run.

## M5 — The round

The loop composes M3 and M4. Episode state under `.squiz/<episode>/`, and the
round itself: gate, review, post new findings as threads, apply each verdict to
the thread it names, then exit 2 with a blocking reason or exit 0 at the cap.

### Acceptance criteria

- [ ] Round 1 on a real pull request posts inline threads and exits 2, with a
      blocking reason naming the open threads and the commands that work them.
- [ ] After the coding agent resolves one thread and replies on another, round 2
      hands both to the reviewer and applies its verdicts: `fixed` and
      `withdrawn` close, `open` re-opens.
- [ ] A cap of 1 reviews once and never blocks. A cap of R blocks at most R−1
      times.
- [ ] Every row of the specification's failure table exits 0 when exercised.
- [ ] The episode closes by exiting 0 and recording final state.

The blocking reason on exit 2 and the one-line failure pointer on exit 0 are
separate channels and stay separate.

## M6 — The summary comment

Classification of every thread into its terminal status at close, the re-opened
counter, and the three-block comment, posted once and never edited.

### Acceptance criteria

- [ ] A closing episode posts one comment carrying the counts, the per-round
      costs with the episode total, the needs-a-person list with `file:line` and
      headline, and Notes.
- [ ] Notes is omitted when there is nothing to report.
- [ ] A round whose cost was not reported prints as unknown rather than zero.
- [ ] General findings appear in Notes with their `file:line`, and count toward
      findings raised while carrying no status.
- [ ] A second episode on the same pull request posts a second comment, and the
      first is untouched.

## M7 — Confinement detection and shared trees

The tracked-file comparison, taken before the reviewer starts and again when it
exits, and shared-tree detection comparing `git rev-parse --show-toplevel`
against the live episodes.

### Acceptance criteria

- [ ] A file mutated during a run is named in the summary.
- [ ] Two live episodes on one toplevel disable the comparison for that round.
      The round still runs, and the summary names the other episodes in flight.

## M8 — Episode boundaries

The cost bound checked when a round records its cost, worktree removal at
episode close, and an audit that every failure path reaches the stderr channel
with a useful line.

### Acceptance criteria

- [ ] An episode crossing the cost bound closes with the findings it has, and
      the summary says the bound was reached.
- [ ] A clean, pushed worktree is removed at close. A dirty or unpushed one
      stays and is named on stderr.
- [ ] No failure path is silent.

M7 and M8 do not depend on each other.

## M9 — Install and dogfood

The marketplace manifest, a README carrying the getting-started steps,
`/squiz doctor`, and `docs/notes/` consolidated.

### Acceptance criteria

- [ ] `/plugin marketplace add` followed by `/plugin install` works into a fresh
      host project.
- [ ] `/squiz doctor` reports `git`, `gh` and its authentication, `pi`, Claude
      Code, and the Node version, naming whatever is missing.
- [ ] A subagent there produces a reviewed pull request end to end.
- [ ] Squiz reviews its own pull requests in this repository.
