# Review comment threads through `gh api`

What the harness has to do to a review comment thread, and the exact call that
does it. The GitHub client in M3 is written against this rather than against a
rediscovered shape.

Established by running every call below against a scratch pull request,
[jacygao/squiz#17](https://github.com/jacygao/squiz/pull/17), which was closed
and its branch deleted afterwards. The comments are still on it and can be read.

Run against `gh` 2.97.0, authenticated against github.com with the scopes
`gist`, `read:org`, `repo`, `workflow`. Nothing here needed a scope outside
that set.

## The two identifier spaces

This is the fact the rest of the note depends on, so it comes first.

A review comment thread has two identifiers, and they are not interchangeable.

| | Looks like | Comes from | Consumed by |
|---|---|---|---|
| The thread's node id | `PRRT_kwDOUEd2qM6fnpx6` | GraphQL `reviewThreads.nodes[].id` only | `resolveReviewThread`, `unresolveReviewThread`, `addPullRequestReviewThreadReply` |
| A comment's REST id | `3942350907` | The REST create response's `id`, and `GET /pulls/{n}/comments` | The REST replies endpoint |

A comment also has a node id of its own, `PRRC_kwDOUEd2qM7q-4A7`. It is the
comment's, not the thread's, and the resolve mutations reject it.

**`<id>` in `squiz threads`, `squiz reply <id>` and `squiz resolve <id>` is the
`PRRT_` thread node id.** It is the only one of the three that serves every
operation the coding agent needs, because GraphQL has a reply mutation that
takes it. It is 21 characters, which is short enough for an agent to copy.

The REST comment id cannot play that role: it reaches the replies endpoint but
not the resolve mutations, so a client that carried it would need a second
lookup before it could resolve anything.

There is no field that maps a comment to its thread. `PullRequestReviewComment`
in GraphQL has no `pullRequestReviewThread`, so a thread node id is obtained by
listing `reviewThreads` and matching on the root comment's `databaseId` — or by
creating the thread through GraphQL, which returns it directly. See *Creating a
thread* below for why that second route has a catch.

## Creating a thread anchored to a file and a line

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
`side`, not positions in the diff hunk.

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

### The GraphQL alternative, and why it is not the default

`addPullRequestReviewThread` takes the pull request's node id and returns the
thread node id directly, which would save the match-back:

```graphql
mutation($prId:ID!, $body:String!) {
  addPullRequestReviewThread(input:{
    pullRequestId: $prId, path: "scratch-probe.txt",
    line: 2, side: RIGHT, body: $body
  }) { thread { id } }
}
```

**It leaves the comment in a pending review.** The mutation returns a normal
thread with a real node id, and the comment is `state: "PENDING"`,
`publishedAt: null`, absent from `GET /pulls/{n}/comments`, and visible to
nobody but the author. Publishing it takes a second call:

```graphql
mutation($id:ID!) {
  submitPullRequestReview(input:{ pullRequestReviewId: $id, event: COMMENT })
  { pullRequestReview { state } }
}
```

where `$id` is `comments.nodes[0].pullRequestReview.id` on the new thread. After
it, the comment reads `state: "SUBMITTED"` and appears in the REST list.

So the choice is one REST call plus a read-back to learn the thread id, or two
GraphQL calls. Either is defensible. What is not defensible is the single
GraphQL call, which posts a comment nobody can see and reports success.

## Replying inside a thread

Two calls do this. Both were run, and neither changed the thread count.

**By thread node id, which is what `squiz reply <id>` should use:**

```graphql
mutation($threadId:ID!, $body:String!) {
  addPullRequestReviewThreadReply(input:{
    pullRequestReviewThreadId: $threadId, body: $body
  }) { comment { databaseId replyTo { databaseId } } }
}
```

This one publishes immediately — the reply came back with a `databaseId` and
appeared in the REST list without a submit.

**By REST comment id, if the client is holding one:**

```
POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies
{ "body": "..." }
```

`{comment_id}` is any comment already in the thread; the root comment is the
obvious one. Only `body` is accepted: sending `path` and `line` alongside it is
a 422, `"line", "path" are not permitted keys`.

`POST /pulls/{n}/comments` with `in_reply_to: <comment_id>` and a body also
works and is equivalent. Unlike the replies endpoint it *accepts* `path`,
`line` and `commit_id` and then ignores them — the comment still lands as a
reply in the thread `in_reply_to` names, whatever the anchoring fields say.
Prefer the replies endpoint, which rejects what it will not honour.

A reply is recognised in a read-back by `in_reply_to_id` being non-null.

## Resolving and re-opening

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

## Reading the threads back

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

**`line` is null once the anchored line changes.** This was checked by pushing a
commit that edited the anchored line and inserted one above it:

- A thread whose line was edited: `isOutdated: true`, `line: null`,
  `originalLine: 4`.
- A thread whose lines only shifted: `isOutdated: false`, `line: 9`,
  `originalLine: 8` — `line` follows the code.

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

## The summary comment

The episode's summary is an issue-level comment, which is a different endpoint
and a different object:

```
POST /repos/{owner}/{repo}/issues/{pull_number}/comments
{ "body": "..." }
```

The pull request number goes in the `issues/` path. The response has no `path`
and no `line`, its node id is prefixed `IC_`, and it does not appear in
`reviewThreads`. That is correct for the summary and wrong for a finding.

## Anchoring: how it fails

Every failure below is a loud HTTP 422. None of them is silent.

| What was sent | What came back |
|---|---|
| `path` not in the diff (`LICENSE`) | `pull_request_review_thread.path` — `could not be resolved` |
| `line` past the end of the file | `pull_request_review_thread.line` — `could not be resolved` |
| `side: LEFT` on an added file | `pull_request_review_thread.line` — `could not be resolved` |
| `commit_id` omitted | `No subschema in "oneOf" matched` |
| `commit_id` set to the base sha | `pull_request_review_thread.path` — `could not be resolved` |

The two `could not be resolved` messages are what the harness sees when a
finding lands outside the diff. § 4 routes that finding to the summary comment
instead, so this is a condition to detect and route on, not an error to report.
A 422 whose `errors[].field` starts `pull_request_review_thread.` means the
anchor was rejected; anything else is a real failure.

Note that the wrong `commit_id` fails as a *path* error, not a commit error. The
message does not name the cause.

## The failures that are not loud

Every call in this section returns a success. Three were checked because they
were suspected in advance; one of those three turned out not to be silent at
all, and the fourth was found while checking the others.

**A second top-level thread posted where a reply was meant.** This is real. A
`POST /pulls/{n}/comments` carrying `body`, `commit_id`, `path` and `line` but
no reply parameter returns 201 with a comment on the right file and the right
line. It is a new thread. Told apart by counting `reviewThreads.totalCount`
before and after: it went 1 to 2, where a reply leaves it unchanged. The
response alone does not show it — the only tell is `in_reply_to_id: null`, and
nothing makes a caller look at it.

**A misspelled reply parameter does not do this.** `in_reply_to_id` in place of
`in_reply_to` was expected to be ignored and to create a second thread. It is
rejected, 422, `"in_reply_to_id" is not a permitted key`. The endpoint validates
its keys against a `oneOf`, so an unknown key fails rather than being dropped.
The silent case above comes from omitting the parameter, not from misnaming it.

**Passing the wrong id to a resolve mutation is loud.** Both the comment node id
and the REST database id were tried against `resolveReviewThread`. Both return a
GraphQL `NOT_FOUND`: `Could not resolve to PullRequestReviewThread node with the
global id of 'PRRC_…'`. Note that GraphQL returns HTTP 200 with an `errors`
array here, so a client that checks only the status code will read this as
success. `gh api graphql` exits non-zero, and a client calling GitHub directly
must check `errors` itself.

**A GraphQL-created thread is invisible until the review is submitted.** Covered
under *Creating a thread* above. This is the worst of the four, because the
mutation returns a well-formed thread with a usable node id, later calls against
that id all succeed, and the harness would report a round of findings that
nobody but the authenticating account can see.

## What was not established

- **Behaviour when another account resolves a thread.** Everything here ran under
  one account, which is what § 2 Identity describes, so `viewerCanResolve` and
  `viewerCanUnresolve` were only ever observed for the thread's own author.
- **Whether a thread can be anchored to the base side of a real modification.**
  The scratch file was added, so it has no `LEFT` side. `side: LEFT` was
  rejected here for that reason and not because the parameter does not work.
- **Rate limits under a full round.** A round posts one thread per finding, and
  no limit was approached by the handful of calls here.

## How this was run

The calls were run ad hoc with `gh api` against pull request 17. No script was
written and nothing but this note is committed.

The one check worth keeping is the thread count, which is what separates a reply
from an accidental second thread. Take it before and after any call meant to
land inside an existing thread:

```bash
gh api graphql -f query='
  { repository(owner:"OWNER",name:"REPO") { pullRequest(number:N) {
      reviewThreads(first:100) { totalCount } } } }' \
  --jq '.data.repository.pullRequest.reviewThreads.totalCount'
```
