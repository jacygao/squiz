## Intent

- "its summary is on the pull request" reads to some users as if the summary were the pull request's description. Say that it is posted there.

## What changed

- `src/review/output.ts`: the closing line of a review that ends with nothing open says the summary is posted on the pull request.
- The four test files that quote the line quote the new one.
