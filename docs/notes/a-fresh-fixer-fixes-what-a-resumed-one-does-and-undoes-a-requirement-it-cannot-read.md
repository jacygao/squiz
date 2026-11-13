---
settles: "§ 3 — that a headless round's fixer is a fresh run and never a resume, and what a fresh fixer must be handed to keep the task's requirements"
issue: [804, 870]
recorded: 2026-11-14
versions: { claude: 2.1.321, claude-model: claude-opus-5-5, copilot: 1.0.110, copilot-model: gpt-6.1-sol, node: 24.15.0 }
recheck-when: squiz hands the fixer the run's prompt or transcript (#859, #870), either CLI changes what `--resume` restores or how its prompt cache survives a resume, the fixer is given a grant to run tests (#864), or a task set where the real defects are harder to fix exists
---

# A fresh fixer fixes what a resumed one does, and undoes a requirement it cannot read

## Intent

- Given the same findings, does a fresh fixer handed `rounds/<k>/handoff.md`
  leave a better or worse change than a resume of the session that wrote it?
- What does each cost?
- Does resume earn a place beside the fresh fixer?

## Decisions

- **Keep the fresh fixer, and do not add a resume.** Both fixed every real
  defect they were handed, broke nothing the finding did not ask for, and left
  the project's own suite passing. On fixing, no difference was measured.
- **Hand the fresh fixer the task, not the session.** The one difference was a
  finding that contradicts a requirement stated only in the task prompt. A
  fresh Copilot fixer with no description applied it in 10 of 15 trials. With
  the prompt as `.squiz/local/description.md`, it applied it in none, as the
  resumed session did. A headless run writes no description today, so this is
  #870.
- **Do not resume to save money.** A warm Claude resume cost 58% of a fresh
  fixer, about $0.11 less a round on these tasks. A Copilot resume saved
  nothing measurable. Copilot has no fork, and the earlier measurement found
  that a cold resume costs about what the original run did. A saving that small
  and that conditional does not pay for a second route.

## Needs your input

Nothing.

## Reference

### What was compared

Three small Node tasks, each a repository at a base commit and a prompt with
one requirement a reviewer could plausibly argue against:

- `config`: extend a `key=value` parser. Keys are lowercased, last one wins.
- `retry`: add backoff. The first retry is immediate.
- `money`: format currencies. Negative amounts go in parentheses.

One `-p` writer run per task and CLI wrote the change. Each change then got the
same two threads:

- **A real defect**, that a hidden test fails on the writer's change: a
  `__proto__` key is dropped; a negative or `NaN` `retries` never calls `fn`;
  an integer above `Number.MAX_SAFE_INTEGER` is formatted as if exact.
- **A wrong finding**, that asks to undo the prompt's requirement.

Every arm got the same prompt, `fixerPrompt` naming a handoff built by
`handoffFor`, and the grants of `fixerCommand` without `--plugin-dir`:

| Arm | How the fixer starts |
|---|---|
| resumed | Claude: `claude -p <prompt> --resume <writer> --fork-session`. Copilot: `copilot -p <prompt> --resume=<copy>`, a copy of the writer's session directory under a new id, because Copilot has no fork. Run in the writer's own directory. |
| fresh | A new run. The handoff says "The change has no description.", as a headless run's does. |
| fresh-desc | A new run, with the task prompt as `.squiz/local/description.md`, so in the handoff. |

A trial is graded by tests it never saw, run on the tree it left:

- the real defect's test passes;
- the wrong finding's test, which pins the requirement, still passes;
- every other hidden test, all of which passed on the writer's change, still
  passes;
- the repository's own `npm test` passes.

Each hidden suite passes on a reference implementation.

### Results, five trials an arm on each task

| | real defect fixed | wrong finding kept out | nothing else broken | own suite passes | cost a fixer, mean (min–max) | seconds, mean (min–max) |
|---|---|---|---|---|---|---|
| Claude resumed | 15/15 | 15/15 | 15/15 | 15/15 | $0.150 (0.117–0.206) | 38 (32–45) |
| Claude fresh | 15/15 | 15/15 | 15/15 | 15/15 | $0.260 (0.223–0.300) | 43 (34–52) |
| Claude fresh-desc | 15/15 | 15/15 | 15/15 | 15/15 | $0.271 (0.220–0.322) | 45 (31–58) |
| Copilot resumed | 14/15 | 15/15 | 15/15 | 15/15 | 5.65 AIU (4.18–6.57) | 31 (22–37) |
| Copilot fresh | 15/15 | 5/15 | 5/15 | 15/15 | 5.91 AIU (5.17–7.02) | 38 (35–45) |
| Copilot fresh-desc | 15/15 | 15/15 | 15/15 | 15/15 | 5.35 AIU (4.91–5.86) | 41 (30–118) |

- **Copilot fresh applied the wrong finding on `config` 5/5 and `retry` 5/5,
  and `money` 0/5.** Each break in "nothing else broken" is that one change and
  the tests that follow from it. On `retry` the writer's own test,
  `does not sleep before the first retry`, pinned the requirement, and every
  fresh fixer rewrote it to match the finding.
- **Claude's writers put each requirement's reason in a code comment, and
  Copilot's put none.** Every Claude fresh fixer declined the wrong finding by
  quoting that comment. Every fresh-desc fixer, on both CLIs, quoted the
  description.
- **The one real defect left unfixed was a resumed Copilot fixer's choice.** It
  replied that a negative `retries` was "a pre-existing input-validation issue,
  not introduced by backoff".
- **Each fixer answered both threads, and none ran `squiz review`.**
- A writer run cost $0.30 to $0.31 on Claude and about 6 AIU on Copilot.

### Warm and cold

- **Every Claude resume was warm.** A fork wrote 2,575 to 11,702 tokens to the
  cache over its whole run. A fresh fixer wrote 16,309 to 23,282, and the
  writer's last call held about 30,000.
- **Every Copilot resume was cold past the 10,918-token prefix every session
  shares.** Each first call after the resume read 10,918 and wrote 8,105 to
  8,709, inside the 30-minute cache lifetime. Whether a resume of the original
  id, rather than a copy, would be warm is unverified.

### Cost fields

- A Claude fork's `total_cost_usd` and `modelUsage` include the writer's run,
  so its own share is the difference from `writer.json`'s.
- A Copilot run's figures are the last `totalNanoAiu`, `cacheReadTokens` and
  `cacheWriteTokens` in its `--output-format json` stream, a session total, so
  a resumed copy's share is again the difference. AIU is `totalNanoAiu` / 10⁹.
  Each first call's cache figures are the `session.usage_record` events in
  `~/.copilot/session-state/<id>/events.jsonl`.

### Running it

The rig is shell and Node scripts in a scratch directory, not in the
repository. Each run sets `enabledPlugins: { "squiz@squiz": false }`, in the
repository's `.claude/settings.local.json` and through `--settings`. It puts a
`squiz` stand-in first on `PATH` that logs each call and answers `reply`. It
also unsets the dispatching session's `CLAUDE_CODE_*` variables.

```sh
SQUIZ=<this checkout>
./writer.sh <task>                                  # claude -p <prompt> --model claude-opus-5-5 --output-format json --permission-mode acceptEdits --allowedTools 'Bash(npm:*)' 'Bash(node:*)' 'Bash(git:*)'
CLI=copilot ./writer.sh <task>                      # copilot -p <prompt> --no-ask-user --output-format json --allow-tool=write '--allow-tool=shell(npm)' '--allow-tool=shell(node)' '--allow-tool=shell(git)'
SQUIZ=$SQUIZ ./run-arms.sh 1 5 config retry money   # each arm's trials one after another, arms and tasks side by side
SQUIZ=$SQUIZ CLI=copilot ./run-arms.sh 1 5 config retry money
node table.mjs                                      # the table above
```

Resumed trials of one task share the writer's directory, because a Claude
session resumes only from the directory it was written in. They must run one
at a time. The tree is restored from a tarball of the writer's result before
each one.

## Limits

- **The tasks were easy for both models.** Every arm fixed every real defect,
  so this shows no difference in fixing at the ceiling, and none on a defect
  that needs the session's working knowledge to fix.
- **Three tasks, five trials an arm, one model each.** The wrong-finding
  difference is 10 of 15 against 0 of 15, but it falls on two tasks. Each
  case is all or nothing, so it is two task-level results, not fifteen.
- **The wrong finding stood in for the context a resume carries.** It tests
  whether the fixer knows what it was asked. It does not test reasons that
  were reached during the work and never stated.
- **The handoff held no agent's report or transcript path**, as a headless
  run's does today (#859). Whether a fresh fixer reads a transcript path to
  recover the prompt was not measured.
- **No fixer could run the tests.** `fixerCommand` grants only `squiz` and
  `git`, and Claude's fixers said `npm test` was blocked waiting for approval.
  That is #864, and it applied to every arm alike.
- **A cold Claude resume was not run here.** The earlier measurement put a cold
  resume at about the first run's cost. That it would make a resume cost more
  than a fresh fixer on these tasks is a prediction.
- **The findings were written by hand** in squiz's comment format, against
  each writer's change, not by squiz's reviewer.
