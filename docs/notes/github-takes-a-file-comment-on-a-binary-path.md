---
settles: "§ 4 — whether a finding on a binary file can be anchored to it"
issue: 139
recorded: 2026-09-26
versions: { github-api: 2022-11-28 }
recheck-when: GitHub changes what `subject_type=file` accepts
---

# GitHub takes a file comment on a binary path

## Intent

- **Nothing said whether GitHub opens a thread on a file whose diff entry is
  `Binary files a/x and b/x differ`.** `parseDiff` keys such a file as changed
  and `routeOne` gives a finding about one a comment on the file, so the harness
  already sends them and nothing had asked GitHub.
- **Nothing said what happens to a finding on a binary path that carries a
  line**, which is a shape a reviewer is free to report.
- **Nothing said whether such a thread reads back and can be ruled on**, which
  is what a second round needs from every thread it posted.

## Decisions

- **Post a file-scoped finding on a binary path unchanged.** GitHub answered
  `201 Created` for a modified binary, an added binary and a text file alike,
  with `subject_type: "file"` on each. No special case is needed anywhere.

- **Leave the line refusal to `post-thread.ts` and route nothing general in
  advance.** A line anchor on a binary path is refused with `422` and
  `pull_request_review_thread.line could not be resolved`, which the existing
  `422` handling reports as an anchor GitHub would not take. The router never
  sends one: a binary file has no changed lines, so `touchesLine` is false,
  `touchesFile` is true, and `routeOne` already downgrades a line-scoped finding
  on one to a file comment carrying the anchor as text. The refusal is
  unreachable through the router, and costs nothing when something else reaches
  it.

- **Read `line` on a file thread as nothing.** A file-level comment comes back
  carrying `line: 1`, `original_line: 1`, `position: 1` and `side: "RIGHT"`,
  which is not where the comment is. `subjectType` is what says a thread is on
  the file, and it is `FILE`.

## Needs your input

Nothing.

## Reference

The call, which is the one § 6 and `post-thread.ts` make:

```
gh api repos/{owner}/{repo}/pulls/{n}/comments \
  -f body=… -f commit_id=<head sha> -f path=<binary path> -f subject_type=file
```

| Entry in the diff | Path | Status |
|---|---|---|
| `Binary files a/scratch/pixel.png and b/scratch/pixel.png differ` | modified binary | `201 Created` |
| `Binary files /dev/null and b/scratch/added.png differ` | added binary | `201 Created` |
| a normal hunk | text file, as the control | `201 Created` |

Each answer carries `"diff_hunk": ""`, `"subject_type": "file"` and a
`PRRC_`-prefixed `node_id`.

The same call with `-F line=1 -f side=RIGHT` instead of `subject_type=file`, on
the modified binary:

```
HTTP/2.0 422 Unprocessable Entity
{"message":"Validation Failed","errors":[{"resource":"PullRequestReviewComment",
"code":"custom","field":"pull_request_review_thread.line",
"message":"could not be resolved"}],"status":"422"}
```

All three threads read back through `reviewThreads` as `PRRT_` nodes with
`subjectType: FILE`, `isResolved: false` and `isOutdated: false`, and
`resolveReviewThread` resolved the one on the modified binary. So a finding on a
binary path is postable, readable and rulable, which is every step a round takes
with a thread.

## Limits

- **One repository, one pull request, and a token that owns it.** Whether a
  token with narrower access is answered the same way was not established.
- **Added and modified only.** A binary that was renamed, deleted, or changed
  only in mode was not tried, and each is a different diff entry.
- **The API, not a round.** No reviewer reported a finding on a binary file: the
  calls were made by hand against a scratch pull request built to carry the
  diff. What a reviewer does when handed a binary file is unmeasured.
- **A 1x1 PNG of 68 bytes.** Nothing here says what GitHub does with a binary
  too large to display.
