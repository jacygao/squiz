# Prose

Everything written for a person to read: `docs/specs/`, `docs/notes/`, issue and
pull request bodies, the text a command prints, and the replies an agent writes
in a session.

## The test

Read it once, at speed. Where you go back, the sentence is wrong rather than the
reader.

That is the whole rule. What follows is what usually goes wrong, for use when the
test fails and it is not obvious why.

## What usually goes wrong

- **Two ideas in one sentence.** Often fine. Split it where the reader has to
  hold the first to reach the second.
- **Nouns stacked with no verb among them.** "every thread on it the reviewer's
  own findings opened" gets taken apart before it gets read. A subject and a verb
  fix it.
- **A clause that means nothing until its last word.** "with the replies and
  resolved state of each", against "each with its replies and whether it is
  resolved".
- **A pointer where the fact would fit.** "Which threads those are is set out
  under Findings below" sends the reader away to learn something the sentence
  could have said.
- **A description of output, with no output.** Where the subject is a message, a
  comment or a command, an example usually says it faster than the description.

## Prefer a test to a rule

Say how to tell that the writing is wrong, not which constructions to avoid. A
rule against a shape also rules out the places that shape reads well, and prose
written to satisfy a list reads like prose written to satisfy a list.

## Worked

Before:

> Its number, its base and head refs, its description, and every thread on it
> the reviewer's own findings opened, with the replies and resolved state of
> each. The harness fetches all of this and passes it in. Which threads those are
> is set out under Findings below.

After:

> Its number, its base and head refs, its description, and the threads the
> reviewer opened on it, each with its replies and whether it is resolved. The
> harness fetches all of this and passes it in.
