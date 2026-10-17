## Intent

- Raise the default round cap from 3 to 4. Dogfooding shows a review that disputes one finding often spends its third round on the dispute, so the closing round arrives before the last fix has been checked.

## What changed

- `src/config/config.ts`: `rounds` defaults to 4.
- `src/config/config.test.ts`: the two tests that state the defaults expect 4.
