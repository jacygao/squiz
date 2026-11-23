---
settles: "§ 5: what reaches the reviewer from a pull request someone else wrote; § 7: whether `squiz review` asks who wrote a pull request"
issue: [579]
recorded: 2026-10-06
versions: { claude-code-action: 86d88e61, claude-code-security-review: 0c6a49f1, pr-agent: 8175540f, run-gemini-cli: main }
recheck-when: squiz reads `AGENTS.md` from anywhere but the snapshot of the head, or a reviewer level that runs code is proposed
---

# Squiz reviews a stranger's pull request under the stranger's `AGENTS.md`

## Intent

- How code reviewers handle a pull request from someone the repository does
  not trust, and where squiz stands against them.

## Decisions

- **Run squiz only on pull requests from authors the user trusts.** Nothing in
  § 5 or § 7 asks who wrote a pull request: squiz reviews whatever is checked out
  where it runs. Its reviewer runs none of the change's code, holds no GitHub
  token and reads only the snapshot, so a stranger's pull request reaches no
  secret. It does reach the reviewer's rules, because the `AGENTS.md` the charter
  treats as authoritative is read from the head commit, which the stranger
  wrote. Every tool that documents a stranger's pull request either waits for a
  trusted person to ask or takes every secret away, and squiz does neither.

## Needs your input

- **Whether squiz should limit a pull request it did not open.** Squiz's own
  coding agent is the only author it is designed around. Recommended: read
  `AGENTS.md` and what it names from the base, as claude-code-action does with
  its own configuration, and refuse a head in another repository if a level
  that runs code returns. This is a change to § 5 and § 7, and is not filed.

## Reference

What other tools do, where they say:

| Tool | What it does |
|---|---|
| Claude Code Review | Reviews a fork only on an `@claude review` comment from someone with write access to the base. A re-run or a push does not start one. |
| claude-code-action | Triggers only for users with write access. On a pull request it restores `.claude/`, `.mcp.json`, `CLAUDE.md`, `.husky/` and other configuration from the base branch before running. Its advice: "Do not check out an untrusted ref into the workspace root". |
| `/security-review` action | "not hardened against prompt injection attacks and should only be used to review trusted PRs" |
| Gemini CLI workflow | Skips forks ("For PRs: only if not from a fork"). Comment triggers need an owner, member or collaborator. |
| Qodo PR-Agent | Recommends `pull_request_target`, which carries the base's secrets, and is safe only because it never checks out the pull request's code. |
| CodeRabbit | Its sandbox "only has the short-lived token for that particular repository". In January 2025 a pull request adding a `.rubocop.yml` ran code outside that sandbox and read the keys to a GitHub App with write access to about a million repositories. |
| Copilot code review | Reads custom instructions, `AGENTS.md` among them, "from the head branch of the pull request instead of the base branch". Fork handling is not public. |
| Codex cloud | Removes secrets before its agent runs (unverified: from a search summary). |
| Codex local review, Greptile, Ellipsis, Sourcery, Kodus, Bito | Not public |

## Limits

- **Every row comes from the tool's own documentation,** not from a pull request
  sent to it.
- **No stranger's pull request was run through squiz.** The one hostile
  `AGENTS.md` measured was added by the change and put a defect out of scope,
  and the reviewer reported the defect anyway
  (`only-the-sibling-and-stale-document-rules-change-what-the-reviewer-reports.md`).
  One written to read as the project's own rules was not tried.
