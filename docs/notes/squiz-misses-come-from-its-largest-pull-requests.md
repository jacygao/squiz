---
settles: "§ 5: which defects squiz's review let through on its own repository, and which of them become eval cases"
issue: 950
recorded: 2026-11-23
versions: { squiz: "main at 9c4e26f", merged-prs: 446, squiz-reviewed-prs: 259, bug-issues-closed: 72 }
recheck-when: the reviewer's charter or model changes, a review starts splitting a large diff, or another 50 bug issues have closed
---

# Squiz's misses come from its largest pull requests

## Intent

- How many defects reached `main` through a pull request squiz reviewed, with no thread on them?
- Why did the reviewer miss them, and what should change in response?
- Which of them make eval cases?
- Does tracing fixes back by blame find misses well enough to repeat on another repository?

## Decisions

- **Treat 11 defects as squiz's misses.** Squiz reviewed the pull request each one came from, the defect was visible in that diff, and no thread raised it, not even in part. They came from 33 bug fixes traced back to a pull request squiz reviewed, out of 60 fixes in all.
- **Answer the misses by splitting large work, not by changing how squiz reviews a large diff.** Ten of the 11 came from pull requests that added 445 to 1,660 lines, against a median of 151 for the pull requests squiz reviewed. Four came from one of them, merged as `6a82920`, whose review ended after three rounds with three findings. The agent that triages an issue, and the subagent that works it, each judge whether one reviewer could hold the change in mind and check it, and split it when not. The judgement is guided by an example, never by a line count. The issue behind `6a82920` passed triage as one sub-issue because each of its parts merged cleanly, and nothing asked whether the whole could be reviewed.
- **Group the misses by what a reviewer needed to know:**
  - **How the platform behaves (4).** Claude Code's shell keeps its working directory between calls. A git alias runs any command. Copilot accounts differ in the models they offer. Copilot keeps its keychain sign-in in its own config.
  - **A file outside the diff (3).** The reviewer's flags sat in `argv.ts`, the handoff's follow-up text in the venue, and the `unthreaded` field on the state record.
  - **Ordering or an unusual input (2).** A signal could arrive between the socket bind and the handler install. `git add --all` stages a nested worktree as a gitlink.
  - **A gap in the design (2).** The fixer could not run the project's tests, and a hint blamed the wrong cause.
- **Build eval cases from these six first.** Each is a defect a reader can see in a few files, and each can be checked in a fresh checkout of the merge it came from:

  | Origin merge | Files | Expected finding |
  |---|---|---|
  | `6a82920` | `src/host/fixer.ts` | A `Bash(git:*)` grant runs any command through `git -c alias.x='!cmd' x` |
  | `6a82920` | `src/host/fixer.ts`, `src/reviewers/copilot/argv.ts` | The Copilot fixer lacks the reviewer's `--disable-builtin-mcps`, `--no-auto-update` and `--disable-client-telemetry` |
  | `6a82920` | `src/host/fixer.ts`, the handoff | The fixer's prompt forbids `squiz review` while its handoff ends by asking for it |
  | `3a100f9` | `handoffFor`, the state record | `handoffFor` never reads `record.unthreaded`, so a finding with no thread never reaches the fixer |
  | `bfe969f` | `extension.mjs` | The socket is created before the `SIGTERM` handler, so a signal in between leaves it behind |
  | `491407c` | `src/venues/local/head.ts` | `git add --all` over the working tree stages a subagent's worktree under `.claude/worktrees/` as a gitlink |

  Run each case at its full original size and trimmed to the files in the table, several times at each size with the same reviewer, model and charter. One defect either way is inside run-to-run variation, so a single run proves nothing. Squiz catching the trimmed case clearly more often than the full one says splitting would have caught it. Missing both about equally says splitting does not reach it.
- **Repeat the method on `swe-drill`, but start from more than bug issues.** Starting from bug issues found fixes reliably. Blame found an origin visible in the diff for only 12 of the 33 fixes. The rest were design gaps no single pull request introduced, or origins blame did not reach.

## Needs your input

Nothing.

## Reference

- A squiz finding is an inline review comment whose body starts `**Squiz reviewer`. Its round summary is a pull request comment that starts `**Squiz review —`. Both are posted from the owner's account, so the author does not tell them apart from the owner's own comments.
- `gh api graphql --paginate` advances only through a variable named `$endCursor`. Under any other name it fetches the first page forever.
- `git blame --first-parent <fix>^1` attributes every line to a merge on `main`, and every merge maps to one pull request through `mergeCommit.oid`.
- Two of the 11 are weaker eval material, because each was what the specification of the time prescribed: the `cd` in the local venue's commands from `fa88578`, and the hard-coded `gpt-5-mini` in the sign-in probe from `0feb003`.
- The exit status introduced in `32b41f7` and changed in `274e5bd` is not counted. It was visible and unflagged, but it was exactly what the specification required.
- On `491407c`, squiz's one thread is on the same `git add --all` line, about a different defect. A reviewer reaching the right line is not enough.

## Limits

- Only defects someone filed as a `bug` and fixed in a pull request are counted. A defect never filed, or fixed in a commit that closes no issue, is invisible to this method, so 11 is a floor.
- One agent judged each fix, and nobody checked its call a second time. The pattern by size rests on 11 cases.
- Blame never offered the true origin for four fixes. Three came from pull requests squiz did not review, and one traced to `ecd6e54`, which the mapping from a commit to its pull request did not resolve.
- No reviewer was re-run. Whether squiz misses these defects today, under its current charter, is unmeasured.
