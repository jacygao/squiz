## Intent

- Ordered list markers were limited to nine digits. Documents that number items by date and sequence, such as `2024010101.`, need ten, so the limit is raised to ten everywhere a marker is matched.

## What changed

- The ordered marker pattern is `\d{1,10}` in `src/Tokenizer.ts` and in the three rules in `src/rules.ts` that match a list item.
