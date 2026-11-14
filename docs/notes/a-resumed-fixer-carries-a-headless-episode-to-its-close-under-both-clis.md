---
settles: "§ 3 — whether a headless episode's later rounds resume the fixer round 1 started under each CLI, what the fixer's grants let it run, and how a test run reaches a resume at all; § 4 — that the local venue under a headless run calls no GitHub and keeps its record in `.squiz/local/`"
issue: [880, 876, 882]
recorded: 2026-11-14
versions: { claude: 2.1.325, copilot: 1.0.111, claude-model: claude-opus-5-5, copilot-model: gpt-6.1-sol, reviewer: "copilot 1.0.111 on gpt-6-astra", node: 24.15.0, git: 2.54.0, macos: 26.6.2, squiz: a3b5d74 }
recheck-when: Claude Code or Copilot CLI change how `--resume` restores a session, which commands they run without a grant, or what a `-p` run's footer reports; or the handoff, the update or the fixer's command line changes
---

# A resumed fixer carries a headless episode to its close under both CLIs

Each CLI ran as both the coding agent and the fixer, once, in a scratch
repository with one base commit and no remote. Squiz was loaded from this
repository's checkout with `--plugin-dir`. `.squiz.json` named the local venue,
the repository's own reviewer (`copilot` on `gpt-6-astra`), `"rounds": 4`, the
fixer, and `"fixerCommands": ["node"]`. Both episodes ended in `closed.json` at
exit status 0 after four rounds. Round 1 started the fixer, and rounds 2 and 3
resumed that session. Both resumed fixers ran `node --test`, and nothing called
GitHub.

## Intent

- Whether a `-p` run under each CLI ends in `closed.json` or `stopped.json`
  once the run has exited.
- Whether later rounds resume the session round 1 started, and whether the
  resumed fixer still holds what its first turn was given.
- Whether `fixerCommands` lets the fixer run a focused check, and whether the
  CLI refuses what was not granted.
- Whether anything calls GitHub, and whether squiz writes anything outside
  `.squiz/local/` or into git.
- How a test task gets a round 2 that leaves threads open, which the resume
  needs.

## Decisions

- **Count the resumed fixer as working end to end under both CLIs.** Each
  episode records one `fixerSession` id. Rounds 2 and 3 have
  `"session": {"id": <that id>, "resumed": true}`, and every stop after round 1
  names that id as the owner. Copilot's `events.jsonl` for the session holds one
  `session.start` and two `session.resume` events.
- **Count the resumed fixer as answering from its first turn.** The Claude
  Code fixer ended rounds 2 and 3 with `Recalled run token: 0d43f689`, the token
  the coding agent printed. Its first turn read the token in `rounds/1/handoff.md`.
  Later it read only `rounds/2/update.md` and `rounds/3/update.md`, which do not
  hold the token, and no transcript. The Copilot fixer never opened the coding
  agent's `events.jsonl`, so it never saw the token. Asked after the close,
  with no tools and no plugin, it named `…/rounds/1/handoff.md | 5`. Only its
  first prompt held that path and that count.
- **Count `fixerCommands` as letting the fixer test what it changed.** Under
  both CLIs each fixer run ran `node --test` on the test file it touched, and
  the tests passed.
- **Rely on the CLI to refuse what was not granted.** Claude Code refused a
  `python3` heredoc and a `for` loop around `squiz reply` during the episode.
  Copilot refused nothing in the episode. Given the fixer's exact command line
  afterwards, outside any repository, it refused `npm`, `python3`, `touch` and
  `git --version && npm --version`.
- **Count the local venue under a headless run as calling no GitHub.** Every
  call the logging `gh` saw was `gh auth token`, and every caller was a
  `copilot` process. No caller was squiz's `node`, a Claude coding agent or a
  Claude fixer.
- **Treat a change-scoped finding that never reaches the fixer as a defect,
  #882.** The Claude Code run's round 1 recorded `About the change as a whole:
  All seven new exported helpers lack the required tests` under `unthreaded`.
  It is in neither the handoff nor `summary.md`.
- **Pace the fixer through the repository's own rules to test a resume.** A
  fresh fixer fixed every thread in round 1 in both unpaced attempts, so
  round 2 closed clean and nothing was resumed. A README rule allowing a fixer
  run at most two threads left three open after round 1, and two after round 2.
- **Write a test task as intent, with the defective code outside the
  description.** A description that gave the code to type word for word got
  no findings on five planted defects. The charter reads the description as
  the change's intent, and the code matched it.

## Needs your input

Nothing.

## Reference

### The task

The README said pages are numbered from 1, a size is a whole number from 1 to
100, a missing or unreadable size gives 25, and a missing or unreadable page
gives 1. It also required a test beside every export. The coding agent copied
five helpers from a draft outside the repository into `src/paging.js`, and a
draft `src/query.js`, without fixing them. The drafts held a floor where a
ceiling belongs, at two sites, a zero-based slice, swapped clamp bounds, an
unchecked `parseInt`, and a `Number()` that lets `NaN` through. The coding
agent's prompt asked it to end with `Run token: <8 random hex digits>`, and
told a resumed fixer to print `Recalled run token:` from memory.

| Attempt | Change to the task | Outcome |
|---|---|---|
| 1 | The code given word for word in the prompt | Round 1 found nothing and closed |
| 2 | The code copied from a draft file, five defects | 4 threads, all fixed by a fresh fixer, round 2 clean |
| 3 | Added `src/query.js` and the README's test rule | 5 threads and one change-scoped finding, all fixed, round 2 clean |
| 4 | Added the README's two-threads-a-run rule, and `"rounds": 4` | The runs below |

### The rounds

Times are UTC on 2026-11-14. A round's review ends where its fixer starts, and
a fixer run ends where the next round starts reviewing. Reviewer credits are
from `state.json`. Copilot's fixer credits are the differences between the
session totals its footer prints, which count from the session's start, not
the run's.

**Claude Code.** Coding agent `a2a6b2d8-…`, 10 s, $0.13, exited 00:13:07. Fixer
session `8f855875-d6eb-4b7e-ad2b-a9c5dcaa8bcb`.

| Round | Review | Reviewer | Threads | Fixer run |
|---|---|---|---|---|
| 1 | 64 s | 31.30 credits | raised `T1`–`T5`, and one finding on no thread | started: fixed `T1`, `T2`; `node --test src/paging.test.js` 4/4; 55 s, 11 calls, 5.6k output tokens |
| 2 | 36 s | 25.69 credits | ruled 2 fixed, 3 open | resumed: fixed `T3`, `T4`; 6/6; 38 s, 6 calls, 4.1k output tokens |
| 3 | 39 s | 27.70 credits | raised `T6` (no tests for `src/query.js`), ruled 2 fixed, 1 open | resumed: fixed `T5`, `T6`; `node --test src/query.test.js` 6/6; 34 s, 5 calls, 3.4k output tokens |
| 4 | 25 s | 30.63 credits | ruled 2 fixed; closed | none |

From the run's exit to `closed.json`: 4 min 53 s.

**Copilot CLI.** Coding agent `a927adcc-…`, 18 s, exited 00:16:40. Fixer session
`0d36aa65-fdb5-48ea-a3eb-6058c71df702`.

| Round | Review | Reviewer | Threads | Fixer run |
|---|---|---|---|---|
| 1 | 117 s | 32.70 credits | raised `T1`–`T5` | started: fixed `T1`, `T2`; `node --test src/paging.test.js` 3 tests; 43 s, 8.44 credits |
| 2 | 35 s | 26.50 credits | raised `T6` (tests), ruled 2 fixed, 3 open | resumed: fixed `T3`, `T4`; 5 tests; 35 s, 5.85 credits |
| 3 | 30 s | 28.39 credits | ruled 2 fixed, 2 open | resumed: fixed `T5`, `T6`; `node --test src/query.test.js` 5 tests; 32 s, 5.09 credits |
| 4 | 23 s | 31.93 credits | ruled 2 fixed; closed | none |

From the run's exit to `closed.json`: 5 min 17 s. The two episodes overlapped
from 00:16:40 to 00:18:00.

### What the CLIs refused and allowed

| Command | Claude Code fixer | Copilot fixer |
|---|---|---|
| `node --test …` | ran | ran |
| `node --input-type=module -e '…{…}…'` | refused: `Contains brace with quote character (expansion obfuscation)` | not tried |
| `python3 …` | refused: `The following part requires approval: python3 - <<'EOF' …` | refused: `Denied, no one to approve shell command (python3)` |
| `for t in …; do squiz reply …; done` | refused: `A variable in this command can't be checked before it runs` | not tried |
| `npm --version` | not tried | refused |
| `touch probe-touch.txt` | not tried | refused |
| `ls` | ran, as `cat README.md && … && ls -R . \| grep -v node_modules \| head -30` | ran, as `git --no-pager status --short && ls -a`, and alone |
| `git --version && npm --version` | not tried | refused |

**This contradicts § 3 Headless runs.** It says the CLI refuses any command not
granted "except the file and read-only commands, such as `touch` and `ls`, that
Claude Code's `acceptEdits` allows on its own". Copilot also runs `ls`
ungranted, and refuses `touch`.

### What else was seen

- `update.md` carries the venue's `followUp`, which says to run
  `(cd '…' && squiz review)` again, while the resume prompt says not to. Neither
  fixer ran `squiz review`.
- Every `handoff.md` holds every agent's final report so far, the coding
  agent's included. Only the fixer's reads show which handoff it read.
- The Copilot coding agent ran with Copilot's experimental features on, so its
  stop recorded `…/session-state/<id>/squiz.sock`. `host.log` then wrote
  `<head>: no wake: .squiz.json names a fixer, so the run is headless` for each
  round, as § 3 says.
- `git status --short --ignored`, in each repository, after the close:
  ` M src/paging.js`, ` M src/paging.test.js`, `?? src/query.js`,
  `?? src/query.test.js`, and `.claude/`, `.squiz.json` and `.squiz/` ignored.
  `git log --all` holds the base commit alone, and `git remote -v` prints
  nothing.

### The setup

- Each process ran under `env -i` with `HOME`, `USER`, `TERM`, `TMPDIR` and a
  `PATH` of a scratch `bin/`, holding a logging `gh`, `claude`, `copilot`, and
  `squiz` linked to this checkout's `bin/squiz`, then the system directories.
  `squiz doctor` in each repository named this checkout and the local venue.
- `.squiz.json` and `.claude/` were kept out of git by `.git/info/exclude`.
  `.claude/settings.local.json` held
  `{ "enabledPlugins": { "squiz@squiz": false } }`, since the installed release
  is enabled for Claude Code everywhere else. Copilot's installed release was
  disabled.
- Claude Code coding agent:
  `claude -p <task> --output-format json --permission-mode bypassPermissions --plugin-dir <checkout>`.
- Copilot coding agent:
  `copilot --prompt=<task> --yolo --output-format json --disable-builtin-mcps --no-auto-update --disable-client-telemetry --no-ask-user --plugin-dir <checkout> --excluded-tools web_fetch web_search`.

## Limits

- **The resume was reached by pacing the fixer.** No unpaced task gave a
  round 2 with threads open, in two tries. Whether one does in ordinary use
  was not established.
- **The Copilot fixer's recall was shown after the close, not during the
  episode.** Its resumed turns drew on nothing that only round 1 held.
- **One run per CLI.** A failed resume, a fresh fixer after a changed CLI,
  `stopped.json`, and a close at the round cap with threads open were not
  exercised.
- **The Claude Code fixer's cost is in tokens.** Its `-p` run prints no cost,
  and its tokens are read from the session transcript.
- **The hosts the fixer reaches were not measured.**
- **Copilot's `touch` and `npm` refusals come from a run of the fixer's command
  line outside the episode**, in a directory that is no repository.
