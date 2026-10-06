---
settles: "§ 3 — what starts a round when the coding agent is Copilot; § 6 — whether a Copilot session runs `squiz review` from the skill or the `AGENTS.md` section on its own; § 9 — which of the two a Copilot project needs"
issue: 535
recorded: 2026-10-06
versions: { copilot: 1.0.92, model: gpt-6-astra, effort: high, node: 24.15.0, herdr: 0.9.3, macos: 26.6.2, squiz-plugin: 4925c3a }
recheck-when: Copilot CLI upgrades past 1.0.92, the default Copilot model changes, or the skill's description or the AGENTS.md section is reworded
---

# Copilot runs `squiz review` unprompted, from the skill or from `AGENTS.md`

## Intent

- Whether a Copilot session, given a task and no mention of squiz, runs `squiz
  review` once it has opened a pull request, with the instruction reachable only
  through the plugin's skill.
- The same, with the instruction reachable only through the `AGENTS.md` section
  `squiz init` writes.
- What the session does with the exit code.
- Whether the round was started by the session or by squiz's own stop hook.

## Decisions

- **Either route is enough on its own, so a Copilot project needs only one.**
  With the plugin and no `AGENTS.md`, the session loaded the `squiz-review` skill
  three seconds after `gh pr create` returned, and ran `squiz review 11`. With
  the `AGENTS.md` section and no plugin, it ran `squiz review 12` straight after
  `gh pr create`. A control run with neither opened its pull request and stopped,
  without running `squiz` or naming it.
- **Expect the session to follow the exit code it gets.** Both reviews exited 0,
  and both sessions ended their turn without running it again, as "Exit 0:
  nothing is open. You are done." tells them to. Both gave the shell call
  `initial_wait: 600`, so the command ran in the foreground to its end.
- **Count on the session, not the stop hook, to start a Copilot round.** Each
  round started within two seconds of the session's own `squiz review` call. Under the
  plugin, Copilot's `agentStop` fired after the round had closed, ran `squiz
  hook` in the plugin checkout, and queued nothing:

  ```
  [hook stderr] squiz: no review ran: HEAD is detached in "/Users/jacy/Documents/Dev/squiz-plugin", so no pull request has it as its head
  ```

  The hook resolves the repository from its working directory, and Copilot runs
  it from the plugin root. Under Copilot it never reaches the session's pull
  request.

## Needs your input

- **Which route § 9 sets up for Copilot.** Both worked, and each still needs
  `squiz` on the shell's `PATH`, which neither provides. Recommended: the plugin,
  because Claude Code reads the same skill, so there is one instruction text for
  both runtimes. The `AGENTS.md` section stays the route for a Copilot that
  cannot be started with `--plugin-dir`.

## Reference

### The prompt

Given verbatim to `copilot -p`, with `r1`, `r2` or `r0` at the end of the branch
name:

```
Add a shell script named greet.sh at the root of this repository. It prints "Hello, NAME!" where NAME is its first argument, or "world" when no argument is given. Make it executable. Do the work on a new branch named add-greet-r1, commit it, push the branch, and open a pull request against main. Then finish.
```

### Setup

- **The repository** was a fresh clone of the private scratch repository
  `jacygao/greet-cli`, one per run, holding only a `README.md`.
- **`.squiz.json`** at the clone's root held `{ "reviewer": "copilot",
  "rounds": 1 }`. It and `.squiz/` were listed in `.git/info/exclude`.
- **`squiz` reached the shell by test setup, not by any mechanism squiz
  provides.** A scratch directory holding a symlink to
  `<plugin checkout>/bin/squiz` was put first on the `PATH` Copilot was started
  with. How `squiz` should reach a Copilot shell is open, as
  `copilot-loads-the-plugin-directory-but-leaves-bin-off-path.md` records.
- **Every `CLAUDE*` variable was unset**, `CLAUDE_CODE_MESSAGING_SOCKET`
  included, so that squiz's hook, which fires under `--plugin-dir`, could not
  take the run for one owned by the Claude Code session that started it.
- **No plugin was installed in Copilot.** `copilot plugin list` printed `No
  plugins installed.`

### Reproducing it

From the clone, with the `PATH` and environment above:

```
# Route 1, the skill:
copilot --plugin-dir <plugin checkout> -p "<prompt>" --allow-all-tools --no-ask-user --log-dir <dir> --log-level debug

# Route 2, the AGENTS.md section:
squiz init
echo AGENTS.md >> .git/info/exclude
copilot -p "<prompt>" --allow-all-tools --no-ask-user --log-dir <dir> --log-level debug
```

The control is route 2's command without `squiz init`.

### Where each result shows

- **The skill's offer.** The debug log's system prompt lists it under
  `<available_skills>` with its description, `Load this after opening a pull
  request and after every push to one, before reporting the work done.`
- **The skill's load.** `events.jsonl` under
  `~/.copilot/session-state/<session id>/` records a `skill` call, then
  `skill.invoked` with `path` `<plugin checkout>/skills/squiz-review/SKILL.md`.
- **The `AGENTS.md` section.** The debug log's system prompt carries it whole,
  inside `<custom_instruction>`. Copilot read it from the working tree although
  git excluded it.
- **The call and its exit.** A `tool.execution_start` for `bash` with
  `"command": "squiz review 11"`, and its result ending `<shellId: 3 completed
  with exit code 0>`.
- **Who started the round.** `.squiz/<number>/host.log` gives the round's start,
  to compare with the session's call, and the debug log carries the hook's
  stderr as `[hook stderr]`.

### Cost

| Run | Coding session | Reviewer round |
| --- | --- | --- |
| Route 1, the skill | 36.4 AI credits | 8.73 |
| Route 2, `AGENTS.md` | 22.58 | 8.48 |
| Control | 19.34 | none |

## Limits

- **Only exit 0 was seen.** The reviewer found nothing on a three-line script, so
  what a session does with exit 2, 3 or 4 is untested.
- **One run per route, one model, `-p` only.** An interactive session was not
  tried, and neither was a model other than `gpt-6-astra` at effort `high`.
- **The session could see squiz's name before the instruction reached it.** In
  every run it listed `.squiz.json`, and read `README.md`, which says "Throwaway
  fixture for a Squiz spike." Routes 1 and 2 also read `.squiz.json`. The
  control saw the same two files and ran nothing, so the files alone did not
  prompt a review, but whether they made the skill likelier to load was not
  separated.
- **Neither session mentioned the review in its final report.** With exit 0 the
  instruction asks for nothing more, so this is not a failure, but a person
  reading only the last message would not know a review ran.
- **A review took about 20 seconds here**, against the "several minutes" the
  instruction warns of. Whether a session waits as patiently for a long round was
  not tested.
