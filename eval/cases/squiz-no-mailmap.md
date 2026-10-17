## Intent

- A repository's `.mailmap` is a tracked file, so the change under review can set it, and `git log` and `git show` apply it to the author they print. A change could rename the author of an earlier commit in what the reviewer reads from the history tools. Show the author each commit actually records.

## What changed

- `src/reviewers/git-tools.ts`: `git_log_search` and `git_show` pass `--no-mailmap`. `git_blame` is unchanged.
- The specification's account of how the history tools are hardened says so.
