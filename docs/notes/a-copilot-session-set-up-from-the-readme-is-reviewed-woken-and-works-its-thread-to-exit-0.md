---
settles: "§ 9 — whether the README's Copilot install and project setup work in a fresh project, and what a Copilot user needs that it left out; M9 — the Copilot half of the end-to-end criterion"
issue: 659
recorded: 2026-10-07
versions: { copilot: 1.0.92, squiz: f5ce5ca, plugin-version: 0.1.0, models: "gpt-5-mini (session), claude-sonnet-5 (reviewer, Copilot's default)", node: 24.15.0, gh: 2.97.0, tmux: 3.7b, macos: 26.6.2 }
recheck-when: Copilot CLI upgrades past 1.0.92, changes its default model or `--allow-tool`, or the README's Copilot steps change
---

# A Copilot session set up from the README is reviewed, woken, and works its thread to exit 0

Following the README alone, squiz went into a fresh `COPILOT_HOME` from the
marketplace, `squiz init` linked it, and `squiz doctor` reported Copilot with
experimental features on. In a new repository, three Copilot sessions' pull
requests were each reviewed by Copilot, and each session was woken through the
plugin's extension within 60 milliseconds of the round's end. The session on
`jacygao/squiz-e2e-659` #3 ran `squiz review`, got exit 2 with one high
thread, fixed it, replied, pushed and ran it again, and the second round closed
the episode at exit 0. The README left out two things a Copilot user needs: how
to let a session run `squiz` without asking, and that a Copilot reviewer with no
model set runs on the coding session's model.

## Intent

- Whether the README's Copilot install, `squiz init` by path, and experimental
  switch work into a fresh `COPILOT_HOME`.
- Whether `squiz doctor` reports the Copilot CLI and its experimental features.
- Whether a Copilot session that opens a pull request and goes idle is woken
  with the round's result, and works it to exit 0 or 3.
- What a Copilot user needs that the README does not say.

## Decisions

- **Keep the README's Copilot install as it is.** `copilot plugin marketplace
  add jacygao/squiz` and `copilot plugin install squiz@squiz` installed `main`'s
  commit to `<COPILOT_HOME>/installed-plugins/squiz/squiz`, the path the README
  gives for `squiz init`. `copilot --experimental` in a `-p` run wrote
  `"experimental": true`, and later sessions loaded the extension with no flag.
- **Read `copilot 1.0.92, experimental features on` as doctor's Copilot line
  passing.** It printed in a project whose `.squiz.json` names Copilot, and
  doctor exited 0.
- **Tell a Copilot user to start sessions with
  `--allow-tool='shell(squiz:*)'`.** With it, a `-p --no-ask-user` session ran
  `squiz status`. Without it, the same run was refused with `Permission denied
  because no interactive user response was available`. The README gave only
  Claude Code's permission, and now gives Copilot's.
- **Tell a user with Copilot on both sides to set `model` in `.squiz.json`.**
  With no model in Copilot's settings, both the reviewer and a session started
  without `--model` ran `claude-sonnet-5`, and doctor passed with `model
  unknown`. § 4 The Copilot adapter already says nothing makes sure the two
  differ. The README now says so, and #687 holds whether doctor should warn.
- **Count the wake and the exit as working.** Each round's host log ended
  `woke its owner through <socket>`, the session's next event was the note as a
  `user.message` with `"source":"system"`, and its first command was
  `squiz review <number>`.

## Needs your input

- **#687: whether `squiz doctor` should warn, or squiz pick a model, where a
  Copilot reviewer's model is unknown and Copilot is also the coding agent.**
  Recommendation: warn, since the README now tells the user what to set and a
  warning leaves the exit status alone.
- **Delete `jacygao/squiz-e2e-659`.** It is a private scratch repository made
  for this run, and the token here has no `delete_repo` scope. Its pull
  requests are closed and their branches deleted.

## Reference

### Telling which reviewer ran

Each round in `.squiz/<number>/state.json` records `"reviewer"` and
`"models"`, here `"copilot"` and `["claude-sonnet-5"]`. The summary comment
says the same, as Reviewed by `copilot` on `claude-sonnet-5`.

### Telling a wake from a silent failure

A woken session shows, in this order, `hook.end agentStop` in its `events.jsonl`,
`woke its owner through <COPILOT_HOME>/session-state/<id>/squiz.sock` in
`host.log`, and a `user.message` with `"source":"system"` holding the note.
A record whose owner has no `messagingSocket` in `state.json` means the hook
reached no extension, either because it never loaded or because it had died,
and the note waits to be pulled.

### Running it from an agent without touching the owner's link

`squiz init` links into `$HOME/.local/bin`, which on the owner's machine is
ahead of the owner's own squiz on `PATH`. Run it with `HOME` set to a scratch
directory whose `.local/bin` exists and is first on the sessions' `PATH`, and
the owner's link is untouched.

### Traps in a first Copilot run that are not squiz's

- A first interactive start offers to install Copilot's desktop app, and asks
  whether to trust the folder.
- `--allow-all-tools` does not cover paths. #3's session wrote a shell command
  holding the file's text, which Copilot read as a path outside the session,
  and it waited nine minutes on `Allow path access` until it was answered.

## Limits

- **One machine, one Copilot version, one coding model.** Only `gpt-5-mini`
  was the session's model, and only Copilot's default reviewed.
- **The sessions ran with `--allow-all-tools`**, so the interactive approval of
  `squiz` without `--allow-tool` was not seen; only the `-p` refusal was.
- **`squiz doctor` ran from a shell, not typed after `!` in Copilot.**
- **Two Copilot prompts were answered by hand**: the folder trust at each
  start, and the path prompt in #3. Neither is squiz's.
- **No subagent's stop was tried** in this run.
