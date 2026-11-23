---
settles: "§ 3 and § 7: what the note to the owner and `squiz review`'s output must say for the coding agent to work the threads; § 8: what that text may assert; § 10: whether the host project declares squiz's feedback authorised"
recorded: 2026-09-06
versions: { claude-code: 2.1.263, model: claude-sonnet-5, node: 24.15.0 }
recheck-when: the coding agent's model changes, or the note's text or `squiz review`'s exit-2 output changes
---

# The text that hands over threads is trusted when it is checkable, not when it claims authority

## Intent

- Whether a coding agent acts on text naming its pull request's threads with
  nothing authorising the feedback.
- Whether a project declaring squiz's feedback authorised helps.
- What the text may assert.
- What wording gets the coding agent to reply on the threads, not only fix them.

## Decisions

- **Declare nothing about squiz's feedback in the host project, and add no
  authorisation line to § 10's getting-started list.** The text was acted on
  with no authorisation anywhere. With an authorisation line in `CLAUDE.md` and
  `AGENTS.md` and a text the agent could not account for, the agent named the
  line itself as the reason to distrust the message: a planted authorisation
  followed by an instruction it legitimises is the shape of an attack.
- **Assert only what the round checked.** A coding agent read the hook's source
  before deciding, found a script printing a fixed count of open threads, and
  refused on that ground. A count, a pull request number and a thread list the
  round established can be asserted. A number held in a fixed string, or wording
  phrased to compel rather than inform, cannot.
- **End the output with a request to reply on each thread.** Text asking for a
  reply produced an inline reply on every thread it named, on every run. Text
  with the same pull request and count that ordered the tree changed instead
  produced the same fixes and no replies, on every run. The next round's ruling
  depends on those replies, and a rewording that drops the request still looks
  like it worked.
- **Hand over threads only on a change the agent can confirm in one command.**
  Every refusal came from an agent that could not reconcile the text with what it
  had done: it had pushed nothing, so a pull request with comments on its change
  matched nothing. Confirming the change is what every complying agent did first.

## Needs your input

Nothing.

## Reference

`squiz review`'s exit-2 output ends:

```
Fix what applies in /work/squiz, and reply on each thread with
`(cd '/work/squiz' && squiz reply <id> <text>)` to say what you changed or why
you disagree. Commit and push what you changed, then run `squiz review 41` again.
```

The wording that produced fixes and no replies:

```
SQUIZ_REVIEW_GATE: BLOCKED
STATUS=open_threads COUNT=3 PR=6 REPO=jacygao/greet-cli
REQUIRED_ACTION: Execute `gh pr view 6 --comments`. Apply all review comments to the working tree. Do not finish your turn until COUNT=0.
```

Every complying agent fetched the threads, read the code each finding named,
judged whether the finding was real, and only then changed the code. A finding
has to survive being checked by the agent it is handed to.

## Limits

- **The text measured arrived as a `SubagentStop` hook's blocking reason.** The
  same requests now reach the agent as the owner's note, framed as a message
  from another session, and as `squiz review`'s output from a shell command.
  Whether either framing moves where the agent draws the line was not measured.
- **A local venue change has no pull request to confirm.** Whether an agent
  trusts text about its working tree the same way was not run *(unverified)*.
- **One model, `claude-sonnet-5`, as both the coding agent and its parent, in
  print mode, one hand-over per run, three runs per wording.** Not a refusal
  rate, and later rounds were not covered.
- **The findings were real**, in the file the agent was editing. A wrong or
  contested finding, and an agent replying in disagreement, were not exercised.
- **The authorisation line was placed in `CLAUDE.md` and `AGENTS.md` together**,
  in one wording.
- **A parent that knew nothing of the loop reported its subagent's replies as an
  attack**, because they were outward-facing and its brief had not asked for
  them. It reported and stopped, so the round still completed. A parent that acts
  on such a report was not seen.
