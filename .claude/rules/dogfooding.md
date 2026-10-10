# Dogfooding

Squiz is used on this repository's own work. A failure found that way goes to the
tracker, not into a reply.

## Do

- **File it before resuming what it interrupted.** The issue is the record. A
  finding in a reply is gone by the next screen.
- **Say what was being done when it happened.** A failure found in use is
  reproducible from the session that hit it and from nothing else.
- **Give it a milestone and a priority, and say why on the issue.** A `P0` goes
  in the release being worked, because it blocks that release. A `P1` goes in
  that release or the next. A `P2` goes in `Backlog`.
- **Carry `needs-human` where it needs a credential, a setting, or a person's
  judgement.**
- **Name what was found and not filed, with the reason.** A judgement that
  something is not worth an issue is a judgement worth seeing.

## Never

- **Read nothing filed as nothing found.** Only what a person reports, or what
  happens in a session Claude is part of, reaches here. Nothing detects a failure
  on its own, and this rule is a reflex rather than a monitor.
- **File without a milestone.** An issue no milestone claims is invisible to every
  listing that decides what to work on next. `Backlog` is a milestone.

## The test

Name the issue number. Not being able to is the answer.

## Reference

The `skills:writing-issues` skill owns what goes in the body. `AGENTS.md`, under
Releases, says what the milestones and the priority labels mean.
