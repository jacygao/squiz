# Comments

The code says what it does. A comment adds what it is for, and why.

## Do

- Keep a comment only if removing it makes something ambiguous or dangerous.
  That rules out restating a name, a type, or a file header, and commenting
  boilerplate: getters, wiring, config. When a rule here does not cover the
  case in front of you, apply that test.
- Update or delete the comment above code you change. One that outlived its code
  is worse than none, because it still reads as true.
- Turn an open question into a GitHub issue, and never `// TODO`. The comment
  says what the code does and why it stops where it does; the tracker tracks
  the question. A comment that turns out to be false is a finding, not a
  tidy-up.
- One line by default. Go longer only to answer a question the code around it
  does not.
- Open with a sentence saying what the code is for. The why is the body, where
  there is one. A noun phrase names the topic and leaves the reader to infer
  the claim.
- Short sentences, ordinary words, no stacked clauses.
- State the conclusion, and nothing about where it came from. A reader at this
  line needs what is true, not how it was learned.
- Put `//` on the line directly above the code it explains, not in a paragraph
  at the top of the block.
- Use `/** */` for a module's purpose, a function's contract, or a reason needing
  more than one line.
- Make three or more items a bulleted list, not one sentence.
- Comment a test for a fixture whose shape is not obvious, or for why the test
  exists at all. A regression test names what regressed, by issue number, in
  its name — a test name and an assertion message are output rather than
  comments, and a reason that belongs in the failure goes in the assertion
  message, where the run prints it.

## Never

- Say a thing twice in one file. A rule stated on the module and again on the
  method has one of them wrong from the first edit that touches either.
- Record current state ("three adapters", "M4 not built"). That belongs in
  `docs/specs/` or `docs/notes/`.
- Reproduce an argument a spec already makes. Give the one-line claim, not the
  reasoning.
- **Point out of the file.** No specification, no note, no issue, no rule, no
  URL. Every one of them moves without the comment moving with it, and a
  comment that survives what it named still reads as true. The conclusion is
  what a reader needs here; `docs/specs/` says what the code must do,
  `docs/notes/` says how it came to be known, and someone who reads those
  understands every comment in the repository without any of them pointing at
  anything.

## Reference: one comment, bad and good

A comment on a branch says why it does what it does, never what it does. A
branch that looks unreachable or removable is the case that most needs one.

```ts
// Bad: restates the code.
// Loop over the threads
for (const thread of threads) {
```

```ts
// Good: the why, and what it obeys.
// A thread the reviewer returned no verdict for is treated as open.
for (const thread of threads) {
```
