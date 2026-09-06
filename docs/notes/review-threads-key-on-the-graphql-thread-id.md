---
settles: "§ 8 — the gh api shapes for a review comment thread's lifecycle"
issue: 10
recorded: 2026-09-06
versions: { gh: 2.97.0 }
recheck-when: GitHub changes the review-thread API
---

# Review threads key on the GraphQL thread id

The full lifecycle works through `gh api`: create anchored to a file and a line,
reply inside the thread, resolve, re-open, and read back with replies and
resolved state. Only the GraphQL `PRRT_` thread node id serves every operation,
so that is what `squiz threads`, `reply` and `resolve` round-trip. Four calls in
this area return success while doing the wrong thing, and one of them posts a
review nobody can see.

## Decisions

- **`<id>` in `squiz threads`, `reply` and `resolve` is the GraphQL `PRRT_`
  thread node id.** It is the only identifier serving every operation the coding
  agent needs. The REST comment id can only be replied to; the resolve
  mutations reject it.
- **Threads are created over REST, not with `addPullRequestReviewThread`.** The
  single GraphQL call leaves the comment in a pending review that nobody can
  see. One REST call plus a read-back to learn the thread id is the cheaper of
  the two honest routes.
- **Resolve and re-open are GraphQL-only.** Checked rather than assumed: no REST
  field carries resolution state.
- **A finding is anchored to a changed line, so the anchoring boundary does not
  decide anything.** GitHub accepts an anchor anywhere inside a hunk, context
  lines included, and rejects anything outside it. Since a finding is anchored to
  the line whose change caused it, the anchor is inside the diff by construction,
  and how wide GitHub draws a hunk never affects whether a finding gets a thread.
  A finding whose effect lands elsewhere names that location in the comment body
  rather than being anchored there. Issue #26 carries this into § 4.

## Needs your input

Nothing. The anchoring boundary was raised and settled: see the last decision
above.

## Reference

Worked examples are still readable on the scratch pull requests this was
established against, [#17](https://github.com/jacygao/squiz/pull/17) (lifecycle)
and [#20](https://github.com/jacygao/squiz/pull/20) (anchoring to a modified
file). Both are closed and their branches deleted. Every call ran under the `gh`
scopes `gist`, `read:org`, `repo`, `workflow`; none needed more.

### The two identifier spaces

This is the fact the rest of the note depends on, so it comes first.

A review comment thread has two identifiers, and they are not interchangeable.

| | Looks like | Comes from | Consumed by |
|---|---|---|---|
| The thread's node id | `PRRT_kwDOUEd2qM6fnpx6` | GraphQL `reviewThreads.nodes[].id` only | `resolveReviewThread`, `unresolveReviewThread`, `addPullRequestReviewThreadReply` |
| A comment's REST id | `3942350907` | The REST create response's `id`, and `GET /pulls/{n}/comments` | Replies only — the resolve mutations reject it |

A comment also has a node id of its own, `PRRC_kwDOUEd2qM7q-4A7`. It is the
comment's, not the thread's, and the resolve mutations reject it.

**`<id>` in `squiz threads`, `squiz reply <id>` and `squiz resolve <id>` is the
`PRRT_` thread node id.** It is the only one of the three that serves every
operation the coding agent needs, because GraphQL has a reply mutation that
takes it. It is 21 characters, which is short enough for an agent to copy.

The REST comment id cannot play that role: it can be replied to but not
resolved, so a client carrying it needs a second lookup before it can resolve
anything.

There is no field that maps a comment to its thread. `PullRequestReviewComment`
in GraphQL has no `pullRequestReviewThread`, so a thread node id is obtained by
listing `reviewThreads` and matching on the root comment's `databaseId` — or by
creating the thread through GraphQL, which returns it directly. See *Creating a
thread* below for why that second route has a catch.

### The failures that are not loud

Every call in this section returns a success while doing something other than
what the caller intended.

**A second top-level thread lands where a reply was meant.** A
`POST /pulls/{n}/comments` carrying `body`, `commit_id`, `path` and `line` but no
reply parameter returns 201 with a comment on the right file and the right line.
It is a new thread. The only tell in the response is `in_reply_to_id: null`;
otherwise it takes a `reviewThreads.totalCount` before and after, which a reply
leaves unchanged. Note this comes from *omitting* the reply parameter — a
misspelled one is rejected, 422, `"in_reply_to_id" is not a permitted key`,
because the endpoint validates its keys against a `oneOf`.

**A wrong id to a resolve mutation returns HTTP 200.** Neither the comment node
id nor the REST database id is accepted; both give a GraphQL `NOT_FOUND`,
`Could not resolve to PullRequestReviewThread node with the global id of
'PRRC_…'`. The status code is 200 and the failure is in the `errors` array, so a
client checking only the status reads a failed resolve as a success. `gh api
graphql` exits non-zero; a client calling GitHub directly must check `errors`
itself.

**A GraphQL-created thread is invisible until the review is submitted.** Covered
under *Creating a thread* above. This is the worst of the four, because the
mutation returns a well-formed thread with a usable node id, later calls against
that id all succeed, and the harness would report a round of findings that
nobody but the authenticating account can see.

### Creating a thread anchored to a file and a line

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

`commit_id` is required, and it has to be the pull request's current head sha —
`gh api repos/{owner}/{repo}/pulls/{n} --jq .head.sha`. The base sha is rejected.

`side` is optional and defaults to `RIGHT`. `line` counts lines in the file at
`side`, not positions in the diff hunk. `RIGHT` numbers lines in the head file,
`LEFT` in the base file, and both work: on a modified file, `line: 3, side: LEFT`
anchors to the removed line and `line: 3, side: RIGHT` to the line replacing it.
They are two separate threads on the same line number, so `side` is part of a
thread's identity and not a detail.

`start_line` (with the optional `start_side`) makes the anchor a range ending at
`line`. Passing `subject_type: "file"` instead of `line` anchors to the file as a
whole; the response then reads back as `line: 1`, `subject_type: "file"`.

The response is the comment, and the fields worth keeping are:

```jsonc
{
  "id": 3942350907,
  "node_id": "PRRC_kwDOUEd2qM7q-4A7",
  "in_reply_to_id": null,        // null means this comment opened a thread
  "path": "scratch-probe.txt",
  "line": 4,
  "side": "RIGHT",
  "subject_type": "line",
  "html_url": "https://github.com/jacygao/squiz/pull/17#discussion_r3942350907"
}
```

The response does not carry the thread's node id. Nothing in the REST response
does.

This call publishes the comment immediately. It creates a review of its own in
state `COMMENTED` as a side effect, which needs no submitting.

#### Why not `addPullRequestReviewThread`

The GraphQL create takes the pull request's node id and returns the thread node
id directly, which would save the read-back. **It leaves the comment in a
pending review**: `state: "PENDING"`, `publishedAt: null`, absent from
`GET /pulls/{n}/comments`, and visible to nobody but the author. The mutation
returns a well-formed thread with a usable node id, and every later call against
that id succeeds, so a round can post its whole review to an audience of nobody
and look healthy throughout.

Publishing needs a second call, `submitPullRequestReview` with `event: COMMENT`
and the review id from the new thread. Two GraphQL calls is defensible; the
single call is not.

### Replying inside a thread

Take the `PRRT_` thread node id, which is what `squiz reply <id>` holds:

```graphql
mutation($threadId:ID!, $body:String!) {
  addPullRequestReviewThreadReply(input:{
    pullRequestReviewThreadId: $threadId, body: $body
  }) { comment { databaseId replyTo { databaseId } } }
}
```

This publishes immediately — no submit — and does not change the thread count.

A reply is recognised in a read-back by `in_reply_to_id` being non-null.

### Resolving and re-opening

Both are GraphQL, as § 2 of the spec says. There is no REST equivalent, and this
was checked rather than assumed: no field on `GET /pulls/{n}/comments` mentions
resolution.

```graphql
mutation($threadId:ID!) {
  resolveReviewThread(input:{ threadId: $threadId })
  { thread { id isResolved } }
}
```

```graphql
mutation($threadId:ID!) {
  unresolveReviewThread(input:{ threadId: $threadId })
  { thread { id isResolved } }
}
```

`$threadId` is the `PRRT_` node id. Both take nothing else.

**Both are idempotent.** Resolving a resolved thread returns `isResolved: true`
and does not error; unresolving an open one returns `isResolved: false`. The
harness applies a verdict to a thread that may already be in that state, so this
matters: `fixed` on an already-closed thread and `open` on an already-open one
are both safe.

`viewerCanResolve` reads `false` on a thread that is already resolved. It is
describing what the UI would offer, not what the mutation will accept — the
mutation succeeded with it false. Do not gate on it.

### Reading the threads back

One query returns everything the harness needs, and only GraphQL returns the
resolved state.

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

`nodes[].id` is the `PRRT_` thread node id — this query is where it comes from.
Replies are the second and later entries in `comments.nodes`; the thread is not
a flat list that has to be reassembled by `in_reply_to_id`, as it is over REST.

Both connections paginate, so both need their `pageInfo` honoured. A pull
request can carry more than 100 threads, and a long argument can carry more than
100 comments.

**`line` goes null once the anchored line is edited**, with `isOutdated: true`
and `originalLine` still set. A thread whose lines merely shifted keeps a live
`line` and stays `isOutdated: false`.

`squiz threads` prints `file:line`, so it has to fall back to `originalLine`
when `line` is null, or it will print `file:null` for exactly the threads a
person most wants to look at.

`startLine` mirrors `line` for a single-line thread rather than being null, and
goes null when the thread is outdated. REST's `start_line` is null for a
single-line comment. The two disagree; treat `startLine == line` as single-line.

`GET /repos/{owner}/{repo}/pulls/{n}/comments` is not sufficient on its own. It
returns every comment flat with `in_reply_to_id`, `path`, `line` and
`original_line`, but it carries **no resolved state and no thread node id**, so
a client built on it can neither report what is open nor resolve anything.

### The summary comment

The episode's summary is an issue-level comment, which is a different endpoint
and a different object:

```
POST /repos/{owner}/{repo}/issues/{pull_number}/comments
{ "body": "..." }
```

The pull request number goes in the `issues/` path. The response has no `path`
and no `line`, its node id is prefixed `IC_`, and it does not appear in
`reviewThreads`. That is correct for the summary and wrong for a finding.

### Which anchors GitHub accepts, and how it refuses

**The boundary is the hunk**, context lines included, on both sides: an
unchanged line inside the hunk anchors, and a real line of the file one past the
hunk does not. A changed line is always inside its own hunk, so an anchor chosen
that way is always accepted.

Every anchoring failure is a loud HTTP 422. None is silent.

| What was sent | What came back |
|---|---|
| `path` not in the diff at all | `pull_request_review_thread.path` — `could not be resolved` |
| `line` outside every hunk for that file | `pull_request_review_thread.line` — `could not be resolved` |
| `line` past the end of the file | `pull_request_review_thread.line` — `could not be resolved` |
| `side: LEFT` on an added file, which has no base side | `pull_request_review_thread.line` — `could not be resolved` |
| `commit_id` omitted | `No subschema in "oneOf" matched` |
| `commit_id` set to the base sha | `pull_request_review_thread.path` — `could not be resolved` |

The `could not be resolved` messages are what the harness sees when a finding
lands outside the diff. § 4 routes that finding to the summary comment instead,
so this is a condition to detect and route on, not an error to report. A 422
whose `errors[].field` starts `pull_request_review_thread.` means the anchor was
rejected; anything else is a real failure.

Note that the wrong `commit_id` fails as a *path* error, not a commit error. The
message does not name the cause.

## Limits

- **Behaviour when another account resolves a thread.** Everything here ran under
  one account, which is what § 2 Identity describes, so `viewerCanResolve` and
  `viewerCanUnresolve` were only ever observed for the thread's own author.
- **Rate limits under a full round.** A round posts one thread per finding, and
  no limit was approached by the handful of calls here.
- **Whether the context window is always three lines.** The boundary is the
  hunk, which is what this note records. How wide GitHub draws a hunk was not
  varied, so a client should treat a rejected anchor as the signal rather than
  computing the window itself.
