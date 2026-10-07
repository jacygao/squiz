---
settles: "§ 9 — whether the README's Claude Code install and project setup work in a fresh project, and what it left out; M9 — the Claude Code half of the end-to-end criterion"
issue: 658
recorded: 2026-10-08
versions: { claude-code: "2.1.292 (doctor), 2.1.293 (the reviewed sessions)", squiz: 87ebfc4, plugin-version: 0.1.0, copilot: 1.0.93, models: "haiku (session), gpt-6-astra (reviewer, Copilot's default)", node: 24.15.0, gh: 2.97.0, git: 2.54.0, tmux: 3.7b, herdr: 0.9.3 }
recheck-when: Claude Code changes how a hook reaches a session's messaging socket, how a subagent's stop is reported, or where `claude plugin install` puts a plugin; Copilot changes its default model; or the README's Claude Code steps change
---

# A Claude Code session set up from the README is reviewed by Copilot, and woken for a subagent's pull request and for its own

Following the README alone, squiz went from the marketplace into a fresh Claude
Code config, and `! squiz doctor` in a session reported every dependency, the
reviewer and the `PATH` link. In the new repository `jacygao/squiz-e2e-658`,
with `{ "reviewer": "copilot" }` in `.squiz.json`, Copilot reviewed four pull
requests. A subagent opened #1 and stopped, and its parent session was woken
23 milliseconds after round 1 ended. A main session opened #2, #3 and #4 and
was woken after each. #1 and #4 each drew one thread, and each was fixed,
answered and resolved in round 2, which closed the episode at exit 0. #2 and #3
closed at exit 0 in one round with nothing found. Every pull request carries
squiz's summary comment.

## Intent

- Whether the README's two install commands, run into a config of its own,
  give a session the squiz its hooks run.
- What `! squiz doctor` prints in a session in a project whose `.squiz.json`
  names Copilot.
- Whether a subagent that opens a pull request and stops is reviewed to exit 0
  or 3, and who is woken.
- Whether a main session that opens a pull request is reviewed, woken by the
  note, and works it to exit 0 or 3 with no instruction.
- What a Claude Code user needs that the README does not say.

## Decisions

- **Keep the README's Claude Code install and project steps as they are.**
  `claude plugin marketplace add jacygao/squiz` and
  `claude plugin install squiz@squiz` installed `main`'s commit, and the
  `.gitignore`, `.claude/settings.json` and `.squiz.json` steps were enough for
  a review to start on every stop. On the first start, Claude Code's
  trust prompt listed `Bash(squiz *)` from `.claude/settings.json`, and no
  session was asked before running `squiz`.
- **Read `squiz doctor`'s output in a session as passing.** Typed after `!`, it
  printed a line per dependency, `squiz link: none on PATH. Not required in
  Claude Code, …` and `Reviewer copilot 1.0.93, model gpt-6-astra, Copilot's
  default`, and exited 0.
- **Count the subagent case as working, with the wake going to the parent.**
  The hook record for #1 names the subagent as well as the session, and the
  note the parent received says whose work it was. The parent, not the
  subagent, ran `squiz review 1`, fixed the thread and replied.
- **Count the main session's wake as working.** After each round, the session's
  next message was the note, and its first command was `squiz review <number>`.
  On #4 it went on to fix, reply, push and review again without being asked.
- **Tell a Claude Code user to check the reviewer's model against their own.**
  The README told only a user with Copilot on both sides to set `model`.
  Copilot's default was `gpt-6-astra` here and `claude-sonnet-5` in the
  Copilot run of #659, so a Claude Code session on Sonnet could be reviewed by
  its own model. The README now says to compare the model on doctor's
  `Reviewer` line with Claude Code's.
- **Show the summary comment as squiz posts it now.** The README's example had
  no `Reviewed by` line and no `Rounds` section, and gave dollars, which a
  Copilot review never shows. It now shows #1's.
- **Say in the README's opening that the review is on the pull request before
  you read it.** It said "you open a pull request that has already been
  reviewed", while a review starts only once a pull request is open.

## Needs your input

- **Whether `squiz doctor` should warn where a Copilot reviewer's model could
  be the coding agent's.** #687 asks this where Copilot is on both sides. The
  same question holds for Claude Code, since Copilot's default has been a
  Claude model. Recommendation: answer it once, in #687, for both.

## Reference

### Telling which reviewer ran

Each round in `.squiz/<number>/state.json` records `"reviewer": "copilot"` and
`"models": ["gpt-6-astra"]`, and the summary comment says Reviewed by
`copilot` on `gpt-6-astra`. Each round's `credits` field is filled and its
`dollars` is 0.

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

### What the notes said

```
Squiz reviewed PR #1 at 4c25208, the work of subagent a32560faae495c8cf: 1 thread is open. Run squiz review 1 to read it.
Squiz reviewed PR #2 at d1f4f6e: nothing is open, and the episode has closed. Run `squiz review 2` to read the close.
```

### Running it from an agent without touching the owner's setup

- **Every command ran under `env -i`** with `HOME` the owner's,
  `CLAUDE_CONFIG_DIR` the scratch config, `PATH` holding no squiz, and `TMUX`
  and `TMUX_PANE` passed through so the reviewer could open its window.
- **`HOME` cannot be a scratch directory.** The scratch config's sign-in is in
  the macOS keychain, and with another `HOME` `claude auth status` printed
  `"loggedIn": false`.
- **Set `DISABLE_AUTOUPDATER=1`.** The first session installed Claude Code
  2.1.293 and moved the owner's `~/.local/bin/claude` link to it, as any
  session of the owner's would have.
- **Keep the sessions from stopping on your word.** The first prompt told the
  parent to stop once the subagent returned. Woken, it asked whether to act on
  the thread instead of acting. The main session's prompts named no stop, and
  it acted on each note unasked.

## Limits

- **`! squiz init` was not run.** With `HOME` the owner's, it would have
  linked `~/.local/bin/squiz`, which is ahead of the squiz the owner's other
  sessions run on `PATH`. The #657 run saw it link.
- **One machine, one coding model, one reviewer model.** Only `haiku` coded
  and only Copilot's default reviewed. A reviewer's tmux window was recorded
  in `state.json` but not watched.
- **No round ended at exit 3**, and no thread was disputed.
- **The subagent worked in the session's own checkout**, not a worktree of its
  own, so the subagent case with a worktree was not tried here.
- **The marketplace was cloned over SSH**, with the owner's key.
