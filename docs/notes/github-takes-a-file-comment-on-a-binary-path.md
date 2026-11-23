---
settles: "§ 5: whether a finding on a binary file can be anchored to it"
issue: 139
recorded: 2026-09-26
versions: { github-api: 2022-11-28 }
recheck-when: GitHub changes what `subject_type=file` accepts
---

# GitHub takes a file comment on a binary path

## Intent

- Whether GitHub opens a thread on a file whose diff entry is
  `Binary files a/x and b/x differ`, which the router already sends a file
  comment for.
- What happens to a finding on a binary path that carries a line.
- Whether such a thread reads back and can be ruled on, as a second round needs.

## Decisions

- **Post a file-scoped finding on a binary path unchanged.** GitHub answered
  `201 Created` for a modified binary, an added binary and a text file alike,
  with `subject_type: "file"` on each, so no special case is needed.
- **Leave a line anchor on a binary path to the existing `422` handling.** GitHub
  refuses one, and `post-thread.ts` reports that as an anchor GitHub would not
  take. The router never sends one: a binary file has no changed lines, so
  `touchesLine` is false, `touchesFile` is true, and `routeOne` downgrades a
  line-scoped finding on it to a file comment carrying the anchor as text.
- **Read `line` on a file thread as nothing.** A file-level comment comes back
  carrying `line: 1`, `original_line: 1`, `position: 1` and `side: "RIGHT"`,
  which is not where the comment is. `subjectType: FILE` is what says a thread
  is on the file.

## Needs your input

Nothing.

## Reference

The call `post-thread.ts` makes:

```
gh api repos/{owner}/{repo}/pulls/{n}/comments \
  -f body=… -f commit_id=<head sha> -f path=<binary path> -f subject_type=file
```

Each answer carries `"diff_hunk": ""`, `"subject_type": "file"` and a
`PRRC_`-prefixed `node_id`. Each thread reads back through `reviewThreads` as a
`PRRT_` node with `subjectType: FILE`, `isResolved: false` and
`isOutdated: false`, and `resolveReviewThread` resolves it.

The same call with `-F line=1 -f side=RIGHT` instead of `subject_type=file`, on
the modified binary:

```
HTTP/2.0 422 Unprocessable Entity
{"message":"Validation Failed","errors":[{"resource":"PullRequestReviewComment",
"code":"custom","field":"pull_request_review_thread.line",
"message":"could not be resolved"}],"status":"422"}
```

## Limits

- **One repository, one pull request, and a token that owns it.** Whether a
  token with narrower access is answered the same way was not established.
- **Added and modified only.** A binary that was renamed, deleted, or changed
  only in mode was not tried, and each is a different diff entry.
- **The API, not a round.** The calls were made by hand. What a reviewer does
  when handed a binary file is unmeasured.
- **A 1x1 PNG of 68 bytes.** Nothing here says what GitHub does with a binary
  too large to display.
