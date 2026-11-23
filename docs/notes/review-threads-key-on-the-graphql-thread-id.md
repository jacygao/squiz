---
settles: "§ 2: the gh api shapes for a review comment thread's lifecycle; § 4: which id a GitHub thread is addressed by, and which refusals mean an anchor did not fit"
issue: 10
recorded: 2026-09-06
versions: { gh: 2.97.0 }
recheck-when: GitHub changes the review-thread API
---

# Review threads key on the GraphQL thread id

## Intent

- Which identifier serves every operation on a thread: create, reply, resolve,
  re-open and read back.
- Which API to create a thread through.
- Whether resolving and re-opening can be done over REST.
- Which anchors GitHub accepts, and how it refuses the rest.

## Decisions

- **`<id>` in `squiz threads` and `squiz reply` is the GraphQL `PRRT_` thread
  node id.** It is the only identifier every operation takes. The REST comment
  id can be replied to but not resolved, and the comment's own `PRRC_` node id
  is rejected by the resolve mutations.
- **Create threads over REST, then read the thread id back over GraphQL.** The
  GraphQL `addPullRequestReviewThread` leaves the comment in a pending review
  that nobody but its author can see, while returning a thread every later call
  succeeds against. A round would post its whole review to nobody and look
  healthy.
- **Resolve and re-open over GraphQL.** No REST field carries resolution state.
- **Anchor a finding to the line whose change caused it.** GitHub accepts an
  anchor anywhere inside a hunk, context lines included, and refuses anything
  outside it, so a changed line always anchors. A finding whose effect lands
  elsewhere names that location in its body.

## Needs your input

Nothing.

## Reference

Every call below ran under the `gh` scopes `gist`, `read:org`, `repo` and
`workflow`. None needed more.

### The identifiers

| | Looks like | Comes from | Taken by |
|---|---|---|---|
| The thread's node id | `PRRT_kwDOUEd2qM6fnpx6` | GraphQL `reviewThreads.nodes[].id` only | `resolveReviewThread`, `unresolveReviewThread`, `addPullRequestReviewThreadReply` |
| A comment's REST id | `3942350907` | The REST create response's `id`, and `GET /pulls/{n}/comments` | Replies only |
| A comment's node id | `PRRC_kwDOUEd2qM7q-4A7` | The REST create response's `node_id` | Nothing on the thread |

No field maps a comment to its thread: GraphQL's `PullRequestReviewComment` has
no `pullRequestReviewThread`. A thread's id is found by listing `reviewThreads`
and matching the first comment's `databaseId` to the REST `id`.

### Creating a thread

```
POST /repos/{owner}/{repo}/pulls/{pull_number}/comments
```

```jsonc
{
  "body": "...",
  "commit_id": "655997442d7a69aec2903665478883e71dac5da0",  // the PR head sha
  "path": "scratch-probe.txt",
  "line": 4,
  "side": "RIGHT"                                            // optional
}
```

- `commit_id` is required and must be the pull request's current head sha,
  `gh api repos/{owner}/{repo}/pulls/{n} --jq .head.sha`.
- `side` defaults to `RIGHT`. `line` counts lines in the file at `side`, not
  positions in the hunk: `RIGHT` numbers the head file, `LEFT` the base file. On
  a modified file `line: 3, side: LEFT` and `line: 3, side: RIGHT` are two
  separate threads, so `side` is part of a thread's identity.
- `start_line`, with an optional `start_side`, makes the anchor a range ending
  at `line`.
- `subject_type: "file"` in place of `line` anchors to the file as a whole, and
  reads back as `line: 1`, `subject_type: "file"`. Sending both is refused, 422,
  `"subject_type" is not a permitted key`. Sending neither is refused,
  `"line" wasn't supplied`. Neither body carries an `errors` array.
- The call publishes at once, creating a `COMMENTED` review of its own. Its
  response carries `id`, `node_id`, `in_reply_to_id`, `path`, `line`, `side`,
  `subject_type` and `html_url`, and no thread id.

`addPullRequestReviewThread` returns the thread id directly, but its comment is
`state: "PENDING"`, `publishedAt: null` and absent from
`GET /pulls/{n}/comments` until a second call, `submitPullRequestReview` with
`event: COMMENT`, publishes it.

### Replying

```graphql
mutation($threadId:ID!, $body:String!) {
  addPullRequestReviewThreadReply(input:{
    pullRequestReviewThreadId: $threadId, body: $body
  }) { comment { databaseId replyTo { databaseId } } }
}
```

It publishes at once and does not change the thread count.

### Resolving and re-opening

```graphql
mutation($threadId:ID!) {
  resolveReviewThread(input:{ threadId: $threadId }) { thread { id isResolved } }
}
```

```graphql
mutation($threadId:ID!) {
  unresolveReviewThread(input:{ threadId: $threadId }) { thread { id isResolved } }
}
```

Both are idempotent: resolving a resolved thread returns `isResolved: true`, and
re-opening an open one returns `isResolved: false`, so a verdict applied to a
thread already in that state is safe. `viewerCanResolve` reads `false` on a
resolved thread while the mutation still succeeds. Do not gate on it.

### Reading the threads back

```graphql
query($owner:String!, $repo:String!, $number:Int!, $cursor:String) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$number) {
      reviewThreads(first:100, after:$cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line originalLine startLine subjectType
          comments(first:100) {
            nodes { databaseId author { login } body createdAt }
          }
        }
      }
    }
  }
}
```

- Replies are the second and later entries in `comments.nodes`.
- Both connections paginate, so both need `pageInfo` honoured.
- `line` goes null once the anchored line is edited, with `isOutdated: true`
  and `originalLine` still set. A thread whose lines only shifted keeps its
  `line`. `squiz threads` prints `file:line`, so it falls back to
  `originalLine`.
- `startLine` equals `line` on a single-line thread, where REST's `start_line`
  is null. Treat `startLine == line` as single-line.
- `GET /repos/{owner}/{repo}/pulls/{n}/comments` returns every comment flat,
  with no resolved state and no thread id, so it cannot serve on its own.

### The summary comment

```
POST /repos/{owner}/{repo}/issues/{pull_number}/comments
{ "body": "..." }
```

The pull request number goes in the `issues/` path. The comment has no `path` or
`line`, its node id starts `IC_`, and it is not in `reviewThreads`.

### Calls that succeed while doing the wrong thing

- **A create with no reply parameter is a new thread**, 201, on the right file
  and line, where a reply was meant. A comment that opened a thread carries no
  `in_reply_to_id` key at all, and a reply carries the id it answered, so the
  key's presence is the tell. A reader that requires the key rejects every real
  create. A misspelled reply parameter is refused, 422,
  `"in_reply_to_id" is not a permitted key`.
- **A wrong id to a resolve mutation returns HTTP 200**, with a GraphQL
  `NOT_FOUND` in `errors`:
  `Could not resolve to PullRequestReviewThread node with the global id of 'PRRC_…'`.
  `gh api graphql` exits non-zero. A client calling GitHub directly must check
  `errors` itself.
- **A `PRRT_` id where a pull request's `PR_` id belongs** answers
  `{"data":{"node":{}}}` at HTTP 200 with no `errors`. A reader of
  `data.node.reviewThreads` must treat an absent connection as a failure, or it
  reports a clean review of a pull request nothing looked at.

### How GitHub refuses an anchor

Every refusal is a loud HTTP 422.

| What was sent | What came back |
|---|---|
| `path` not in the diff | `pull_request_review_thread.path`: `could not be resolved` |
| `line` outside every hunk for that file | `pull_request_review_thread.line`: `could not be resolved` |
| `line` past the end of the file | `pull_request_review_thread.line`: `could not be resolved` |
| `side: LEFT` on an added file | `pull_request_review_thread.line`: `could not be resolved` |
| `commit_id` omitted | `No subschema in "oneOf" matched` |
| `commit_id` set to the base sha | `pull_request_review_thread.path`: `could not be resolved` |
| `commit_id` set to a sha the pull request does not carry | `commit_id`: `commit_id is not part of the pull request` |
| `body` empty, anchor valid | `pull_request_review_thread.body`: `required when requesting changes` |

A refusal under `pull_request_review_thread.` is an anchor that did not fit only
where the field is `path`, `line` or `side`. The same prefix carries real
failures, such as an empty body. A file-scoped create sends no `line` or `side`,
so it can be refused only under `path`. The base sha fails as a `path` refusal,
which never names the commit.

## Limits

- **One account.** `viewerCanResolve` and `viewerCanUnresolve` were observed
  only for the thread's own author. A thread resolved by another account was not
  tried.
- **Rate limits under a full round were not approached.**
- **How wide GitHub draws a hunk was not varied.** Treat a refused anchor as the
  signal rather than computing the window.
- **A line thread with neither `line` nor `originalLine` was never produced.**
  The schema makes both nullable *(unverified)*, so a reader has to handle it.
