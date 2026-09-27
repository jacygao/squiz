# Prose

Everything written for a person to read: `docs/specs/`, `docs/notes/`, issue and
pull request bodies, the text a command prints, and the replies an agent writes
in a session.

## Do

- **One idea per sentence.** Two ideas joined by a comma are two sentences.
- **Put the subject first.** A sentence whose subject arrives at the end makes
  the reader carry the whole thing before any of it means anything.
- **Say it rather than point at it.** "Which threads those are is set out under
  Findings below" sends the reader away. Say whose threads they are.
- **Show the output.** A description of a message, a comment or a command
  carries an example, copied from a run rather than written from memory.
- **Use the shorter word** where both are exact.

## Never

- **Stack nouns.** "every thread on it the reviewer's own findings opened" is
  five nouns the reader has to take apart. Name a subject and give it a verb.
- **Hang a clause on its last word.** "with the replies and resolved state of
  each" means nothing until it ends. "each with its replies and whether it is
  resolved" means something as it goes.
- **Write a sentence that carries another one.** Delete it and see whether
  anything is missing.

## The test

Read it once, at speed. Going back means the sentence is wrong, not the reader.

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
