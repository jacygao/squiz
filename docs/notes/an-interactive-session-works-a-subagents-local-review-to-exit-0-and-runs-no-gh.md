---
settles: "§ 4 — whether the local venue, in an interactive Claude Code session on a repository with no remote, records the base at start, reviews a worktree subagent in its own `.squiz/local/`, wakes the parent, and reaches exit 0 without `gh`; and how the outcome is read afterwards"
issue: 798
recorded: 2026-11-07
versions: { claude-code: 2.1.319, coding-agent: claude-opus-5-5, reviewer: "pi 0.85.1 on openai/gpt-5.4-mini", herdr: 0.9.3, node: 24.15.0, git: 2.54.0, squiz: fa88578 }
recheck-when: Claude Code changes where it puts a worktree-isolated subagent's worktree, or whether its Bash tool keeps a `cd`; or the local venue's head build, `followUp`, `rerun` or owner note changes
---

# An interactive session works a subagent's local review to exit 0, and runs no `gh`

An interactive Claude Code session ran in a Herdr tab, in a scratch repository
with no remote, under `SQUIZ_VENUE=local`. It dispatched two `general-purpose`
subagents with `isolation: "worktree"`, one after the other. Each brief planted
an off-by-one: `pageCount` with `Math.floor`, then `pageOf` slicing to
`start + size - 1`. In each subagent's worktree the reviewer opened one thread
on the defect. The fix was replied to with `squiz reply` and ruled `fixed` in
round 2, and `squiz review` there exited 0. The second subagent's round 1 was
started by its `SubagentStop` hook, and its result woke the parent through the
parent's socket. Squiz ran no `gh` in any process.

The parent's own tree did not review cleanly. Its change held both subagents'
worktrees as gitlinks, and the episode closed at the round cap on a false
finding about them.

## Intent

- Whether `.squiz/local/base.json` is written when a session starts, and kept
  as it is afterwards.
- Whether a subagent dispatched into a worktree of its own gets its own
  `.squiz/local/` and is reviewed there.
- Whether findings and replies land in `threads.json`, and the result wakes the
  parent.
- Whether a rerun reaches exit 0.
- Whether anything runs `gh`.
- Whether the outcome can be read afterwards: each finding, its replies, and
  whether it was resolved.

## Decisions

- **Rely on `base.json` as § 4 The base describes it.** `SessionStart` wrote
  the root's at 23:46:14, and `SubagentStart` wrote each subagent's in its own
  worktree before the subagent did any work. None changed afterwards, though
  the root saw several more stops and the second subagent was resumed with
  `SendMessage`, which fired `SubagentStart` again in its worktree.
- **Count a worktree subagent as reviewed in its own worktree.** Each
  subagent's rounds, `state.json`, `threads.json` and `summary.md` are under
  `.claude/worktrees/agent-<id>/.squiz/local/`. Each record a hook queued
  there names that subagent as owner, and the records `squiz review` queued
  name no owner. The root's `.squiz/local/` holds only the root's own states.
- **Count the wake as working in the local venue.** Every round a hook started
  ended with `noted its owner` and `woke its owner through
  /tmp/cc-socks/<pid>.sock` in `host.log`. The note reached the parent's pane
  as `Another Claude session sent a message: Squiz reviewed PR #local at
  f13ec17, the work of subagent a1f61a036aa9661df: 1 thread is open: …`. A
  round started by `squiz review` itself recorded no owner and woke no one, as
  in the GitHub venue.
- **Read a worktree's outcome from `threads.json` and `summary.md`.** Each
  thread holds the reviewer's finding as `C1`, the coding agent's reply as
  `C2`, the reviewer's `fixed` ruling as `C3`, and `isResolved: true`. Each
  summary reads `2 rounds, 1 finding` and `Fixed 1 · Withdrawn 0 · Open 0 ·
  Disputed 0`.
- **Prove "no `gh`" by attributing each call to its parent process, not by an
  empty log.** A `gh` that logged and exited 1 was first on `PATH` for the
  session, its hooks, the round host and the reviewer. It logged one call,
  `gh auth token`, whose parent was the `claude` process itself, at startup.
  Squiz made none.
- **Ignore `.claude/worktrees/` in a repository reviewed locally, until #825 is
  fixed.** Without that, the parent's change lists each subagent worktree as
  `A  .claude/worktrees/agent-<id>  +1`. Round 1 of the root failed with `the
  reviewer reported nothing and did not finish its review`. Rounds 2 and 3
  kept one thread open, `Committing local worktree gitlinks makes the PR
  non-self-contained`, against the coding agent's reply that nothing was
  committed.
- **Expect a woken parent to stay in the subagent's worktree after working it,
  until #826 is fixed.** The note's commands begin `cd '<worktree>' &&`, and
  Claude Code's shell keeps that directory. The parent's next `Stop` fired in
  the first subagent's worktree, found its state already reviewed, and queued
  nothing for the root.

## Needs your input

- **Whether the head build drops every gitlink the base lacks, or only
  directories that are worktrees of the same repository** (#825). Both differ
  from § 4 The change, which says the tree is what `git add --all` would take.
  Recommendation: drop every gitlink the base lacks. A repository that adds a
  real submodule commits `.gitmodules` with it, and the reviewer can read
  neither kind.

## Reference

### What shows each result

| Result | Where it shows |
|---|---|
| The base, written at start and kept | `.squiz/local/base.json` in the root, `{"commit": "49bdd72…", "branches": ["refs/heads/main"]}`, modified 23:46:14 and unchanged at the end. Each subagent's has `refs/heads/main` and `refs/heads/worktree-agent-<id>`, the second of which § 4 leaves out as the work's own branch. |
| The start hooks fired | `Hooks: SessionStart:startup` and `Hooks: SubagentStart:general-purpose` lines for `squiz-plugin/bin/squiz hook` in Claude Code's `--debug-file` |
| A subagent reviewed in its worktree | `host.log` there: `round 1: reviewing f13ec17`, `f13ec17 reviewed, 1 threads open`, then `round 2: reviewing 4381b80 with reply C2` and `episode closed (nothing-open)` |
| The wake | `host.log`'s `woke its owner` line, the note under `.squiz/local/notes/<session id>/delivered/`, and the parent's pane |
| Exit 0 on the rerun | `squiz review; echo EXIT=$?` in each subagent worktree printed `closed after 2 rounds, with nothing open` and `EXIT=0` |
| No `gh` from squiz | the logging `gh`'s log, one line, parent `claude` |
| No ref written | `git for-each-ref` lists `main` and the two worktree branches only |

### What the local venue still calls a pull request

#820 tracks `PR #local`. Beside it, the run printed:

- `A new commit, or running \`squiz review local\` once, retries it.` in the
  owner's note for a failed state. For a subagent's state, a parent that runs
  it from its own directory reviews its own tree. The parent `cd`'d into the
  worktree itself.
- `Nothing is open. The review is closed, and its summary is on the pull
  request.` from `squiz review`, where the summary is `summary.md`.
- `the failure is posted on PR #local` in a failed record's `lines`, where the
  failure is `failure-<k>.md`.

`squiz review local` is accepted, as § 4's `asked` rule allows, and reviews the
worktree it runs in.

### The head sha confuses a coding agent

The note names the head squiz built, such as `6ab3d30`. Its objects are in
`.squiz/local/objects/`, so `git log --all` does not find it, and the parent
said the subagent had committed `d8b94e2` instead. This is § 4 The change as
written.

### How the run was set up

- The session was started from a script in a new Herdr tab, with every
  `CLAUDE*` variable unset, `SQUIZ_VENUE=local`, `DISABLE_AUTOUPDATER=1`, the
  logging `gh` first on `PATH`, and `claude --plugin-dir
  /Users/jacy/Documents/Dev/squiz-plugin --permission-mode auto --debug-file
  <file>` under `caffeinate -i`. Input was typed with `herdr pane send-text`
  and read with `herdr pane read`.
- The repository's `.claude/settings.local.json` held
  `{ "enabledPlugins": { "squiz@squiz": false } }`, and the debug log shows the
  installed 0.2.0 hooks `will NOT register`.
- The parent was told to pass each brief word for word and to edit nothing in
  its own checkout. The briefs never named squiz.
- The pi default, `deepseek/deepseek-v4-pro`, failed every round with `402
  Insufficient Balance`. `{ "model": "openai/gpt-5.4-mini" }` in the root's
  `.squiz.json` replaced it, and the first subagent's review was retried by the
  parent's own `squiz review`.

## Limits

- **The first subagent's wake carried only a failure.** Its hook-started round
  failed on the balance, and the retry was the parent's own command, so no
  owner was recorded. The second subagent's round is the one that shows a wake
  carrying a finding.
- **The second fix was made by the subagent, not the parent.** The parent sent
  the thread back to it with `SendMessage`, and the subagent replied and ran
  `squiz review`.
- **Neither fix was committed.** The local venue reviews the working tree, so
  each round 2 reviewed an uncommitted edit on the subagent's branch.
- **Exit 0 was read from the session's pane**, from `echo EXIT=$?` and from
  the Bash results that Claude Code did not mark as errors, not from a process
  of this run's own.
- **What the `SubagentStop` hook did for Claude Code's `prompt_suggestion`
  forked agent was not looked at.** It fired after each of the parent's turns,
  and no record names it as an owner.
- **One run, one coding model and one reviewer model.**
