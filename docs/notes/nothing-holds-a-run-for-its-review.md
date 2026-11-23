---
settles: "§ 3: that a stop never blocks the coding agent, and how a round's result reaches a session that has ended; § 4: that the local venue wakes its owner as the GitHub venue does"
issue: [787, 801]
recorded: 2026-11-23
versions: { claude: 2.1.319, copilot: 1.0.106 }
recheck-when: Claude Code or Copilot CLI change how a `Stop` hook's block is read, whether a `-p` run keeps its messaging socket after it exits, or whether an async hook outlives a `-p` run
---

# Nothing holds a run for its review

## Intent

- Whether a headless run (`claude -p`, `copilot -p`) should wait for its review
  by having the `Stop` hook block until the review is done.
- Whether an interactive session and a headless run need the same way of
  getting a round's result back.
- What happens when a person closes an interactive session before its review
  finishes.

## Decisions

- **Hold no run with a blocking `Stop`.** Each block is a paid turn. The agent
  polls a command that is only waiting, and a model that ends its turn instead
  is blocked again, so a review that breaks leaves the run spending until
  something kills it. The hook queues the round and returns, the round host
  runs it detached, and the wake delivers it.
- **Wake a live session, in both venues, and nothing else.** The wake needs
  only a live session, never a pull request. The local venue posts its note to
  the owner's socket exactly as the GitHub venue does. A headless run has
  always exited by the time its review finishes, so its wake fails and its note
  waits.
- **Leave the findings of a session that has ended waiting in its notes.** A
  close may mean stop. Starting an agent in that tree unasked spends credits
  and may edit files a person is changing. Continuing after a close would be a
  setting a person turns on.

## Needs your input

Nothing.

## Reference

### What an ended session leaves

- **The review still runs.** The round host is detached, so it outlives the
  session and writes or posts the findings.
- **Only the wake fails.** The note stays in `.squiz/<number>/notes/`, or
  `.squiz/local/notes/` under the local venue, and waits for `squiz review` or
  `squiz status`.
- **No squiz process is left.** The round host exits after its round, whether
  or not the wake reached anyone.

### Why a headless run cannot be woken

- A plain `claude -p` session removes its messaging socket when it exits, and a
  post to it fails with `FileNotFoundError`.
- An async hook still running when a `-p` run ends is killed, so
  `asyncRewake` never reaches a run that has exited.
- `copilot -p` without experimental features loads no wake extension, so its
  hook records no socket.

## Limits

- **How a session is found to have ended was not tested** for either agent,
  and squiz does not try: the wake's failure is the only sign.
- **The cost of a blocked turn was argued, not measured.**
