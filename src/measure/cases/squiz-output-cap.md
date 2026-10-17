## Intent

- `git_blame` on a long file is cut at 64 KiB, so the reviewer cannot see who wrote the end of it. Raise the history tools' output cap to 256 KiB.

## What changed

- `src/reviewers/git-tools.ts`: `OUTPUT_CAP` is 262,144 bytes. The test that checks the cut reads the constant, so it needs no change.
