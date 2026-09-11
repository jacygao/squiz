---
settles: "§ 2 — reading a pull request's diff, and whether it is the diff the anchor validator was built for"
issue: 67
recorded: 2026-09-12
versions: { gh: 2.97.0, git: 2.54.0 }
recheck-when: GitHub changes the diff media type it serves
---

# GitHub's diff is git's, byte for byte

The diff GitHub serves for a pull request is identical, byte for byte, to what
`git diff <base sha>...<head sha>` writes for the same commits — the trailing
tab after a path holding a space and the one-octal-escape-per-byte quoting of a
path outside ASCII included. The anchor validator, which was built against local
`git` output, therefore keys every file under the name a finding names. What
GitHub does with a diff too large to serve is not established.

## Decisions

- **The diff is fetched with one `gh api` call carrying the diff media type.**
  `gh pr diff <number>` reaches the same endpoint with the same `Accept` header,
  but spends a GraphQL call first to find a number the harness already holds.
- **The head sha comes from `headRefOid` in the same `gh pr list --json` call as
  the number, the refs and the body.** It is the value `.head.sha` returns, and
  it is the one an anchored comment is posted against.
- **A pull request that does not exist arrives as a non-zero exit, not as an
  empty diff.** So does every other refusal: the failure is typed and carries
  the line `gh` printed.

## Needs your input

**Whether GitHub refuses an oversized diff with a status or truncates the
body.** Nothing local bounds the response, so GitHub's limit is the only limit,
and a body cut between two files parses cleanly as a whole diff with the last
files absent. A body cut inside a hunk is loud: the parser throws.

Settling it needs a pull request whose diff is past whatever GitHub serves,
which means pushing a large commit somewhere. Recommendation: make one scratch
pull request carrying 30,000 added lines across 400 files, run the fetch against
it, and record the exit status, the HTTP status, the message and the last bytes
of stdout. Issue #82 holds this.

## Reference

The call, from a directory whose remotes name the repository:

```
gh api repos/{owner}/{repo}/pulls/{number} --header 'Accept: application/vnd.github.v3.diff'
```

`gh` fills `{owner}` and `{repo}` in itself. The answer is the diff, not JSON,
so it does not go through the REST helper that reads an HTTP status.

The lookup asks for every field in one call:

```
gh pr list --state open --json number,baseRefName,headRefName,headRefOid,body --limit 1 --head <branch>
```

`headRefOid` is the head sha. There is no `baseRefOid` in that list, and there
is no need for one: the base sha is refused as a *path* error when it is sent as
`commit_id`.

The two path shapes, exactly as both `git diff` and GitHub write them:

```
+++ b/scratch/a file with spaces.txt<TAB>
+++ "b/scratch/\303\274n\303\257c\303\266d\303\251.txt"
```

A name holding a space carries a trailing tab and is not quoted. A name with a
byte above ASCII is quoted whole, one `\ooo` escape per byte, and carries no
trailing tab. Both come back from the parser as the repository-relative name a
finding carries: `scratch/a file with spaces.txt` and `scratch/ünïcödé.txt`.

A pull request number that does not exist:

```
exit 1, stderr: gh: Not Found (HTTP 404)
```

## Limits

- **Size.** The only diff checked was 846 bytes across three files. See *Needs
  your input*.
- **Shapes not seen from GitHub.** The diff checked was three added files. A
  rename, a deletion, a mode change and a binary file were not fetched from
  GitHub, so only `git`'s rendering of those is known.
- **One repository, one account.** Everything here ran against a public
  repository under the account `gh` was authenticated as.
- **One `git`.** The comparison used git 2.54.0, where § 2 Verified against
  records 2.50.1. The quoting on 2.50.1 was not re-run.
