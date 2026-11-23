---
settles: "§ 3: who a round's note wakes for a subagent's pull request and for a session's own; § 10: whether the README's Claude Code install gives a fresh config the squiz its hooks run"
issue: 658
recorded: 2026-11-23
versions: { claude-code: "2.1.292 (doctor), 2.1.293 (the reviewed sessions)", squiz: 87ebfc4, plugin-version: 0.1.0, copilot: 1.0.93, models: "haiku (session), gpt-6-astra (reviewer, Copilot's default)", node: 24.15.0, gh: 2.97.0, git: 2.54.0 }
recheck-when: Claude Code changes how a hook reaches a session's messaging socket, how a subagent's stop is reported, or where `claude plugin install` puts a plugin; Copilot changes its default model; or the README's Claude Code steps change
---

# A Claude Code session set up from the README is woken with its review

## Intent

- Whether the README's install commands, run into a config of its own, give a
  session the squiz its hooks run.
- What `! squiz doctor` prints in a session in a project whose `.squiz.json`
  names Copilot.
- Whether a subagent that opens a pull request and stops is reviewed to exit 0
  or 3, and who is woken.
- Whether a main session that opens a pull request is woken with the note and
  works it to exit 0 or 3 with no instruction.
- What a Claude Code user needs that the README does not say.

## Decisions

- **Install as the README says.** `claude plugin marketplace add jacygao/squiz`
  and `claude plugin install squiz@squiz` installed `main`'s commit into a fresh
  config, and a review started on every stop. The run allowed `squiz` through a
  project `.claude/settings.json`. The README now has `! squiz init` add the
  rules to the user's settings instead, and no session was run on that
  (unverified).
- **Read `! squiz doctor` as passing where it exits 0.** Typed after `!`, it
  printed a line per dependency, the link line and the reviewer line, with no
  link on `PATH`:

  ```
  squiz link: none on PATH. Not required in Claude Code, whose own shell runs squiz; for another coding agent, run squiz init
  ```

- **Expect a subagent's pull request to wake the parent, which works it.** The
  hook record for the subagent's pull request names the subagent as well as the
  session, and the note the parent received says whose work it was. The
  parent, not the subagent, ran `squiz review`, fixed the thread and replied,
  and round 2 closed at exit 0.
- **Expect a session's own pull request to wake it, and the session to act
  unasked.** After each round the session's next message was the note, and its
  first command was `squiz review <number>`. Where a thread was open it went on
  to fix, reply, push and review again. Four pull requests closed at exit 0.
- **Set `model` where Copilot's default is the model Claude Code runs.**
  Copilot's default was `gpt-6-astra` here and has been `claude-sonnet-5`, so a
  Claude Code session on Sonnet can be reviewed by its own model. Compare the
  model on doctor's `Reviewer` line with Claude Code's.

## Needs your input

- **Whether `squiz doctor` should warn where a Copilot reviewer's model could
  be the coding agent's.** The same question holds where Copilot is on both
  sides. Recommendation: answer it once for both runtimes, with a warning,
  which leaves the exit status alone.

## Reference

### Telling which reviewer ran

Each round in `.squiz/<number>/state.json` records `"reviewer": "copilot"` and
`"models": ["gpt-6-astra"]`, and the summary comment says Reviewed by
`copilot` on `gpt-6-astra`. A Copilot round fills `credits` and leaves
`dollars` 0.

### Telling a wake from a silent failure

A woken session shows three things in this order:

- `.squiz/<number>/state.json` holds a record whose `owner` names a
  `messagingSocket`, and, for a subagent, a `subagent` id.
- `host.log` ends the round with `<head>: noted its owner, <session id>` and
  `<head>: woke its owner through /tmp/cc-socks/<pid>.sock`.
- The session's transcript, under `<config>/projects/`, has a `user` message
  beginning `Another Claude session sent a message: Squiz reviewed PR #<n> at
  <head>`, tens of milliseconds after the wake line.

A record with no `messagingSocket` means the hook found no socket, and the
note waits to be pulled. A round started by the session's own `squiz review`
records no owner, because no hook made it.

A note that closes the episode reads:

```
Squiz reviewed PR #2 at d1f4f6e: nothing is open, and the episode has closed. Run `squiz review 2` to read the close.
```

A subagent's note names it after the head, as `at 4c25208, the work of subagent
a32560faae495c8cf`.

## Limits

- **`! squiz init` was not run**, so neither its link nor its permission rules
  were seen from a session here.
- **One machine, one coding model, one reviewer model.** Only `haiku` coded
  and only Copilot's default reviewed.
- **No round ended at exit 3**, and no thread was disputed.
- **The subagent worked in the session's own checkout**, not a worktree of its
  own.
- **The marketplace was cloned over SSH**, with the owner's key.
