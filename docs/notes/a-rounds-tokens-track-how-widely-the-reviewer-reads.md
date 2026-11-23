---
settles: "§ 8: what bounds a round's spend; § 10: the lowest `tokens` that leaves a good review room"
issue: [105, 165]
recorded: 2026-09-26
versions: { pi: 0.85.1, provider: deepseek, model: deepseek-v4-pro, node: 24.15.0 }
recheck-when: pi upgrades, the reviewer's model changes, or the token bound's default or range changes
---

# A round's tokens track how widely the reviewer reads

## Intent

- What a round costs, and whether to bound it on tokens or dollars.
- How low a token bound can go without cutting off a good review.

## Decisions

- **Bound a round on tokens, not dollars.** Dollars stay recorded and reported,
  and bound nothing: a subscription puts no price on a round, and this model was
  repriced within a week.
- **Set no token bound below about 875,000 for a review of this size.** The
  widest of three rounds used 873,569 tokens, and it was the round that found the
  seeded defect, so a lower bound cuts off a good review. `tokens` defaults to
  10,000,000 and can be set as low as 100,000, which is below that.

## Needs your input

Nothing.

## Reference

| Round | Wall | Cost | Tokens | Calls before reporting |
|---|---|---|---|---|
| 1 | 70.3 s | $0.0472 | 53,933 | 4 |
| 2 | 313.8 s | $0.2048 | 873,569 | 43 |
| 3 | 188.0 s | $0.1090 | 321,396 | 24 |

A round's size follows how many files the reviewer opens, not what it finds.
Cache reads were 819,000 of round 2's 874,000 tokens: every file opened is
re-sent on every later request of the round.

## Limits

- **Three rounds of one 1,950-byte change, on one model.** A larger change, or a
  reviewer that reads more widely, needs more.
- **The figures are a floor.** The rounds were stopped on `finish_review`,
  before the reviewer's closing message, which a round now lets arrive.
- **The dollars are `pi`'s arithmetic**, from a catalogue that refreshes itself.
