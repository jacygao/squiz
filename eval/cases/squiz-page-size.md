## Intent

- Listing the threads of a long-running pull request has failed with a GitHub timeout, because one page asks for 100 threads with 100 comments each. Ask for 50 of each instead.

## What changed

- `src/github/threads.ts`: `PAGE_SIZE` is 50, with a comment saying why. Both connections are already followed through `hasNextPage` to their last page.
