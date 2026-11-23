---
settles: "§ 5: why the round reads the change's diff from the snapshot, and why the router's file names are the ones GitHub anchors to"
issue: 67
recorded: 2026-09-12
versions: { gh: 2.97.0, git: 2.54.0 }
recheck-when: GitHub changes the diff media type it serves, or git changes how `git diff` quotes a path
---

# GitHub's diff is git's, byte for byte

## Intent

- Whether the diff GitHub serves for a pull request is the diff `git` writes for
  the same commits, quoting of unusual paths included.

## Decisions

- **Read the change's diff in the snapshot with `git diff <base sha>...HEAD`,
  and ask GitHub for none.** The diff GitHub serves is byte for byte what
  `git diff <base sha>...<head sha>` writes, so the router, which parses it,
  keys every file under the name GitHub anchors a comment to. The base sha is
  `baseRefOid`, from the same `gh pr list --json` call as the head, and
  `--no-ext-diff --no-textconv --no-color` keep the repository's config from
  changing the bytes.

## Needs your input

Nothing.

## Reference

The two path shapes, exactly as both `git diff` and GitHub write them:

```
+++ b/scratch/a file with spaces.txt<TAB>
+++ "b/scratch/\303\274n\303\257c\303\266d\303\251.txt"
```

A name holding a space carries a trailing tab and is not quoted. A name with a
byte above ASCII is quoted whole, one `\ooo` escape per byte, and carries no
trailing tab. Both come back from the parser as the repository-relative name a
finding carries: `scratch/a file with spaces.txt` and `scratch/ünïcödé.txt`.

GitHub's diff, for comparing again:

```
gh api repos/{owner}/{repo}/pulls/{number} --header 'Accept: application/vnd.github.v3.diff'
```

## Limits

- **Size.** The only diff compared was 846 bytes across three added files.
- **Shapes not seen from GitHub.** A rename, a deletion, a mode change and a
  binary file were not fetched from GitHub, so only `git`'s rendering of those
  is known.
- **One repository, one account, one `git`.** The comparison ran against a
  public repository on git 2.54.0.
