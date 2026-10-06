---
settles: "§ 3 — whether a Copilot coding agent, never told about squiz, runs `squiz review` and works its threads to exit 0, and what the plugin's hooks queue meanwhile; § 9 — whether the Copilot setup § 9 gives is enough on its own; M13 — the live-run criterion"
issue: 573
recorded: 2026-10-06
versions: { copilot: 1.0.92, models: "gpt-6-astra (medium and low effort), gpt-5-mini, claude-haiku-4.5", reviewer: gpt-6-astra, herdr: 0.9.3, node: 24.15.0, macos: 26.6.2, squiz-plugin: 21ed14b }
recheck-when: Copilot CLI upgrades past 1.0.92, the default Copilot model changes, the skill's description or text changes, or `squiz reply` or the round host's handling of a superseded state changes
---

# A Copilot session works a squiz finding to exit 0, unprompted, on gpt-6-astra

An interactive Copilot session in a Herdr pane was given a task that never named
squiz. It opened pull request #20 on the scratch repository, loaded the plugin's
skill, and ran `squiz review 20`, which exited 2 with one thread. It fixed the
code, replied with `squiz reply`, pushed, and ran the command again until it
exited 0. Six earlier runs on the same task are recorded too, because each
showed something the successful one did not.

## Intent

- Whether a Copilot session, given a task and no mention of squiz, opens a pull
  request, runs `squiz review`, and works a finding to exit 0 or 3, on a
  repository set up as § 9 says.
- Whether it runs the command in the foreground or the background, and if the
  background, whether the command's end wakes it.
- Whether the plugin's hooks fire, and queue for the right pull request and
  session with no socket.
- Whether a defect planted in the code the task touches survives to the review.
- What a run costs, and how to reproduce it.

## Decisions

- **Count M13's live-run criterion as met, by run 7.** The session ran on
  `gpt-6-astra` at reasoning effort `low`. It loaded `squiz-review` five seconds
  after `gh pr create` returned. Round 1 posted a `low` thread on
  `test/cli.test.js`, saying a test helper passed a percent-encoded file URL
  path to Node. The session changed the helper to `fileURLToPath`, ran the
  tests, replied, committed and pushed. Round 2 ruled the thread fixed, and the
  command exited 0. The summary read `Fixed 1 · Withdrawn 0 · Open 0 · Disputed
  0`.
- **Expect the session to run `squiz review` in the foreground.** Every call, in
  every run that made one, was a `bash` call with `initial_wait: 600`. None moved
  to the background, so no `system.notification` was recorded and the wake was
  not exercised.
- **Expect the hooks to queue exactly as § 3 says.** Copilot fired the plugin's
  `Stop` once per session, as `agentStop`, when the session went idle:
  - Where the session ran `squiz review` itself (runs 1, 2, 4 and 7), the firing
    found the state already reviewed and queued nothing. The record's `owner`
    stayed `null`.
  - Where it did not (runs 5 and 6), the firing queued the session's pull
    request, #18 and #19, with `owner` `{"sessionId": "<the session's id>"}`
    and no socket. The round host reviewed it and wrote a note for that session.
    Nothing woke the session, as § 3 The report says of a round the session did
    not start.
  - Where no pull request existed (run 3), the hook wrote `squiz: no review ran:
    no open pull request has "add-paging" as its head` to its stderr.
- **Do not expect a planted defect to reach the reviewer when the coding model
  is `gpt-6-astra`.** In each run on that model the session read
  `lib/pages.js` and dealt with the defect before opening the pull request. In
  runs 1, 2 and 7 it fixed it, and in run 4, whose prompt forbade changing the
  file, it worked around it in `greet.js`. The finding worked in run 7 was in
  the session's own new test helper. `gpt-5-mini` left the defect in run 5, and
  the reviewer found it.

## Needs your input

- **Whether § 9 should say that the skill reaches only some Copilot models.**
  Under the same setup, `gpt-5-mini` (runs 3 and 5) and `claude-haiku-4.5`
  (run 6) opened their pull requests and stopped. They never loaded the skill
  and never ran `squiz`. The hook's round then ran with nobody to read its
  result. Recommended: run the `AGENTS.md` route once each with `gpt-5-mini` and
  `claude-haiku-4.5` before changing § 9, since that route puts the text in the
  system prompt rather than leaving it to the model to load.
- **#588: a `squiz review` straight after a reply and a push waited out its
  540-second deadline with no round running.** In run 7 the session chained
  `squiz reply`, `git push` and `squiz review 20` in one shell call. The reply's
  round found the pushed commit and recorded itself superseded, then the host
  exited with nothing queued. The waiting command exited 4 after 538 seconds,
  and the round for the pushed commit started only when the session ran the
  command again. Recommended: fix it in M9, where it is filed.

## Reference

### The prompt

Given verbatim to `copilot -i` in runs 1, 3, 5, 6 and 7:

```
Add a --page option to greet.js. With --page N, it prints only the Nth page of greetings, five names to a page, then a line "Page N of M". A page number outside 1 to M prints an error to stderr and exits 1. Use the helpers in lib/pages.js. Do the work on a new branch named add-paging, commit it, push the branch, and open a pull request against main.
```

Run 2 ended the fourth sentence `Use the helpers in lib/pages.js, parsePage
among them.` Run 4 replaced it with `Use pageCount and pageItems from
lib/pages.js. Another tool shares that file, so leave it unchanged.`

### What was planted

The scratch repository `jacygao/greet-cli` held a Node CLI, `greet.js`, with
`lib/greet.js`, `lib/pages.js`, two test files under `test/`, a `README.md`
that does not name squiz, and a committed `.gitignore` listing `.squiz/`.

- **Runs 1 and 3 to 7**, `main` at `fea3e5d` and then `857d673`, which hold
  the same tree: `pageCount` returned `Math.floor(total / perPage) + 1`, so an
  exact multiple of five gets an extra empty page. Its test checked only
  `pageCount(7, 5)` and `pageCount(3, 2)`.
- **Run 2**, `main` at `c563a13`: `pageCount` was correct, and a new
  `parsePage` used `parseInt`, so `--page 2abc` reads as page 2.

### The runs

| Run | Coding model | Pull request | Skill and `squiz review` | Review | Session AI credits | Reviewer AI credits |
|---|---|---|---|---|---|---|
| 1 | `gpt-6-astra`, `medium` | #15 | loaded, ran it | exit 0, no findings; the session had fixed the defect | 60.39 | 18.09 |
| 2 | `gpt-6-astra`, `medium` | #16 | loaded, ran it | exit 0, no findings; the session had fixed the defect | 55.32 | 20.65 |
| 3 | `gpt-5-mini` | none: `gh pr create --web` | neither | none | 1.46 | — |
| 4 | `gpt-6-astra`, `medium` | #17 | loaded, ran it | exit 0, no findings; the session worked around the defect | 49.02 | 17.91 |
| 5 | `gpt-5-mini` | #18 | neither | the hook's round: exit 2, one `medium` thread on the planted defect | 1.49 | 19.45 |
| 6 | `claude-haiku-4.5` | #19 | neither | the hook's round: exit 2, three `medium` threads, the planted defect among them | 7.81 | 21.24 |
| 7 | `gpt-6-astra`, `low` | #20 | loaded, ran it three times | exit 2, then 4, then 0 | 83.89 | 41.76 |

The session's credits are `totalNanoAiu` over 10⁹, from `session.shutdown` in
its `events.jsonl`. `medium` is the effort `session.start` recorded where none
was set, and `low` was set with `--reasoning-effort low`. Each `gpt-6-astra` session was one
premium request, and run 6 was 0.33. The reviewer's credits are from the summary
comment. Run 7's two rounds used 66,937 and 57,873 tokens. Run 7's session used
219,496 input tokens, 175,902 of them cache reads, and 2,364 output tokens.

### Run 7, as the session's events record it

| Time (UTC) | Call | Result |
|---|---|---|
| 08:53:43 | the prompt | |
| 08:54:29 | `npm test`, `git commit`, `git push`, `gh pr create` in one call | PR #20 |
| 08:54:39 | `skill` `squiz-review` | loaded from `<plugin>/skills/squiz-review/SKILL.md` |
| 08:54:41 | `squiz review 20`, `initial_wait: 600` | exit 2 at 08:55:28: `Squiz reviewed PR #20 at 984d9d5: round 1 of 3, 1 new finding.` |
| 08:55:37 | `apply_patch` on `test/cli.test.js` | |
| 08:55:41 | `npm test`, `squiz reply PRRT_kwDOUP9_Ns6pY6Lt "<text>"`, `git commit`, `git push`, `squiz review 20` in one call | exit 4 at 09:04:46: `Squiz is reviewing PR #20 at 33e58f5 instead of 984d9d5.` |
| 09:04:52 | `squiz review 20`, `initial_wait: 600` | exit 0 at 09:05:27: `Squiz reviewed PR #20 at 33e58f5: round 2 of 3, no new findings.` |
| 09:05:31 | `agentStop` | queued nothing |

The reply posted was `Updated the CLI test runner to use fileURLToPath from
node:url so checkout paths containing spaces are decoded correctly.` The session's
last message ended `Squiz review is closed with no open findings.`

### Setup

- **The plugin**: `copilot --plugin-dir <plugin checkout>`, the checkout
  detached at `21ed14b`.
- **`squiz` on `PATH`**: `squiz init` run by path from that checkout, with
  `HOME` set to a scratch directory whose `.local/bin` was first on `PATH`.
  It printed `squiz: linked <scratch>/home/.local/bin/squiz to <plugin
  checkout>/bin/squiz`. It ran in a throwaway repository, so the `AGENTS.md`
  section it writes never reached the scratch repository, and the skill was the
  only route to the instruction. The pane's `PATH` held that directory and not
  the plugin's `bin/`, and `command -v squiz` in it printed the link.
- **`.squiz.json`**: `{"reviewer": "copilot"}`, listed in `.git/info/exclude`.
  The reviewer ran on `gpt-6-astra`, the model in the scratch `COPILOT_HOME`'s
  `settings.json`, in a Herdr tab of its own.
- **`COPILOT_HOME`**: a scratch directory. Its `config.json` listed the scratch
  clones under `trustedFolders`, so `-i` opened no trust dialog. On first launch
  Copilot moved `model` out of `config.json` and into `settings.json`.
- **The environment**: no `CLAUDE*` variable, checked by dumping the pane's
  environment before Copilot started.
- **The pane**: a new Herdr tab. Nothing was typed into it after the line that
  started Copilot.

### Reproducing it

From a fresh clone of the scratch repository, in a Herdr pane, with the
environment above:

```
copilot --plugin-dir <plugin checkout> --reasoning-effort low --allow-all \
  --log-dir <dir> --log-level debug -i "<the prompt>"
```

Run 5 is the same line with `--model gpt-5-mini` and without
`--reasoning-effort`, and run 6 uses `--model claude-haiku-4.5`. The session
ends only when it is signalled. `SIGTERM` while it was idle made it write
`session.shutdown`, which holds the totals.

### Where each result shows

- **The calls and the wake**: `<COPILOT_HOME>/session-state/<session id>/events.jsonl`,
  as `tool.execution_start` and `tool.execution_complete`, `skill.invoked`, and
  `system.notification` for a wake.
- **The hook's firing**: the same file, as `hook.start` with `hookType`
  `agentStop` and the payload under `input`. Its stderr is in the debug log as
  `[hook stderr]`.
- **What was queued, and for whom**: `.squiz/<number>/state.json`, each record's
  `owner`. The note the host wrote is under `.squiz/<number>/notes/<session id>/`.

## Limits

- **One successful run.** It was on `gpt-6-astra` at effort `low`. The three
  runs at `medium` had no finding to work, so whether a session at `medium`
  works one was not seen.
- **Exit 3, and a disputed thread, were not reached.** The one thread worked was
  `low`, and the session took its suggested fix.
- **The background wake was not exercised.** No session ran `squiz review` in
  `async` mode, and none of its calls outlived `initial_wait`.
- **The session could see squiz's name before the skill loaded.** `.gitignore`
  lists `.squiz/`, as § 9 step 1 asks, and `.squiz.json` sat in the working
  tree. Run 7's first shell call listed both.
- **`--allow-all` was set in every run.** A session that asks for tool
  permissions was not tried, because nothing could be typed into the pane.
- **One machine, one try per configuration.** Whether `gpt-5-mini` or
  `claude-haiku-4.5` ever loads the skill on another try was not established.
