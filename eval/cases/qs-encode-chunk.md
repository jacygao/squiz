## Intent

- `utils.encode` split long strings into 1024-character segments with a `for` loop that stepped its own index back by one when a segment ended on a high surrogate. Changing the loop variable inside the loop made it hard to follow, so the loop now works out each segment's end first.

## What changed

- `encode` in `lib/utils.js` walks the string with a `while` loop. Each segment ends at the limit or at the string's end, and one character earlier where it would otherwise separate a surrogate pair.
