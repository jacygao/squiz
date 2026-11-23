---
settles: "§ 5: what `--tools` withholds from the `pi` reviewer, and how a grant short of a reporting call fails"
issue: [11, 165]
recorded: 2026-09-25
versions: { pi: "0.84.2, 0.85.1", model: deepseek-v4-pro, node: 24.15.0 }
recheck-when: pi upgrades, or pi changes how --tools filters extension tools
---

# `pi` registers no tool the grant does not name

## Intent

- Whether `--tools` reaches a tool an extension registered, and whether a grant
  that leaves one out says anything.
- Whether `--tools` withholds a tool or only discourages it, and what a name
  that matches no tool does.

## Decisions

- **Put every reporting call and history tool in the grant.** `--tools` filters
  extension tools exactly as it filters built-in ones: a call the grant does not
  name is not registered, and the run exits 0 with an empty stderr. A grant
  short of a reporting call is a reviewer with no way to report, and a round
  with nothing to say about why.
- **Rely on `--tools` to withhold `edit`, `write` and `bash`.** A tool the grant
  leaves out is absent rather than discouraged: its schema is never sent, and it
  has no implementation in the run.
- **Spell every name in the grant exactly.** A name that matches no tool never
  grants anything. Beside real names it is dropped, and alone it leaves the run
  no tools at all rather than `pi`'s default set of `read`, `bash`, `edit` and
  `write`. Either way the run exits 0 with an empty stderr.

## Needs your input

Nothing.

## Reference

The reporting calls the grant carries: `report_finding`, `report_verdict`,
`finish_review`. `src/reviewers/pi/argv.ts` builds the grant, and hands the
extension the same list, so the extension's refusal and `--tools` cannot name
different tools.

Where the grant is enforced: in `core/agent-session.js`, `--tools` becomes a set
that every registered tool name is filtered against, for both the definitions
sent to the model and the executable registry. At 0.84.2 a typo beside real
names, `read,grep,find,ls,bahs`, produced a request identical in size to
`read,grep,find,ls`. A grant of `notatool` alone matched `--no-tools` at 662
tokens.

`pi`'s own documentation: "Pi does not include a built-in sandbox. Built-in
tools can read files, write files, edit files, and run shell commands with the
permissions of the pi process." Granted `bash`, a reviewer asked for a fix
modified a tracked file on its first attempt, so a grant that carries a shell
confines nothing.

## Limits

- **The filtering was measured at `pi` 0.84.2** and not run again at 0.85.1.
- **The grant filter is a `pi` internal,** not part of its documented
  interface.
