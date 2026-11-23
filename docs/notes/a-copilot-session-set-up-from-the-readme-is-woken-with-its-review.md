---
settles: "§ 3: whether an idle Copilot session is woken with its round's note and works it; § 10: whether the README's Copilot install and experimental switch work into a fresh `COPILOT_HOME`, and what a Copilot user needs that it left out"
issue: 659
recorded: 2026-11-23
versions: { copilot: 1.0.92, squiz: f5ce5ca, plugin-version: 0.1.0, models: "gpt-5-mini (session), claude-sonnet-5 (reviewer, Copilot's default)", node: 24.15.0, gh: 2.97.0, macos: 26.6.2 }
recheck-when: Copilot CLI upgrades past 1.0.92, changes its default model, where `copilot plugin install` puts a plugin, or how `--experimental` is stored; or the README's Copilot steps change
---

# A Copilot session set up from the README is woken with its review

## Intent

- Whether the README's Copilot install, `squiz init` by path, and experimental
  switch work into a fresh `COPILOT_HOME`.
- Whether `squiz doctor` reports the Copilot CLI and its experimental features.
- Whether a Copilot session that opens a pull request and goes idle is woken
  with the round's result, and works it to exit 0 or 3.
- What a Copilot user needs that the README does not say.

## Decisions

- **Install as the README says.** `copilot plugin marketplace add
  jacygao/squiz` and `copilot plugin install squiz@squiz` installed `main`'s
  commit to `<COPILOT_HOME>/installed-plugins/squiz/squiz`, the path the README
  gives for `squiz init`. `copilot --experimental` in a `-p` run wrote
  `"experimental": true`, and later sessions loaded the wake extension with no
  flag.
- **Read `copilot 1.0.92, experimental features on` as doctor's Copilot line
  passing.**
- **Expect an idle session's pull request to wake it, and the session to work
  the thread.** Three sessions were each woken within 60 milliseconds of their
  round's end. Each one's first command was `squiz review <number>`, and the
  one with a thread fixed it, replied, pushed and ran it again until it exited
  0.
- **Tell a user with Copilot on both sides to set `model` in `.squiz.json`.**
  With no model in Copilot's settings, both the reviewer and a session started
  without `--model` ran `claude-sonnet-5`, and doctor passed with the model
  unknown. Nothing makes the two differ.

## Needs your input

- **Whether `squiz doctor` should warn, or squiz pick a model, where a Copilot
  reviewer's model is unknown and Copilot is also the coding agent.**
  Recommendation: warn, since the README tells the user what to set and a
  warning leaves the exit status alone.

## Reference

### Telling which reviewer ran

Each round in `.squiz/<number>/state.json` records `"reviewer"` and
`"models"`, here `"copilot"` and `["claude-sonnet-5"]`. The summary comment
says the same, as Reviewed by `copilot` on `claude-sonnet-5`.

### Telling a wake from a silent failure

A woken session shows, in this order:

- `hook.end agentStop` in its `<COPILOT_HOME>/session-state/<id>/events.jsonl`;
- `woke its owner through <COPILOT_HOME>/session-state/<id>/squiz.sock` in
  `host.log`;
- a `user.message` with `"source":"system"` in `events.jsonl`, holding the note.

A record whose owner has no `messagingSocket` in `state.json` means the hook
reached no extension, because it never loaded or had died, and the note waits
to be pulled.

### Traps in a first Copilot run that are not squiz's

- A first interactive start offers to install Copilot's desktop app, and asks
  whether to trust the folder.
- `--allow-all-tools` does not cover paths. A session that wrote a shell command
  holding a file's text had it read as a path outside the session, and waited
  on `Allow path access` until it was answered.

The rule a session needs to run `squiz` without asking is settled in
`copilot-allows-a-command-by-its-name-and-never-by-its-subcommand.md`.

## Limits

- **One machine, one Copilot version, one coding model.** Only `gpt-5-mini`
  was the session's model, and only Copilot's default reviewed.
- **The sessions ran with `--allow-all-tools`.**
- **`squiz doctor` ran from a shell, not typed after `!` in Copilot.**
- **Two Copilot prompts were answered by hand**: the folder trust at each
  start, and one path prompt.
- **No subagent's stop was tried.**
