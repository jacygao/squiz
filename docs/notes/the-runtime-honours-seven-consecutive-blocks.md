---
settles: "§ 3 — whether the runtime caps consecutive blocks below the round cap's maximum of 8; § 8 — whether stop_hook_active is set when the hook re-enters"
issue: 14
recorded: 2026-09-06
versions: { claude-code: 2.1.261, node: 24.15.0 }
recheck-when: Claude Code changes hook delivery, or adds a guard on consecutive blocks
---

# The runtime honours seven consecutive blocks, and the hook need not read `stop_hook_active`

Seven consecutive exit-2 blocks all landed. The hook fired eight times, blocked
on the first seven, and every one of those blocks was delivered to the subagent
verbatim and resumed its turn. The runtime did not intervene at any point: it
did not stop feeding the reason back, did not end the turn, did not warn, and
did not truncate. `stop_hook_active` was `false` on the first firing and `true`
on every firing after it, but nothing in the runtime acted on it.

## Decisions

- **§ 3's round cap keeps its range of 1 to 8.** The maximum cap of 8 asks for
  7 consecutive blocks, and 7 consecutive blocks were honoured in full, twice.
  Nothing above 7 was tried, so the ceiling is known to be at least 7 and is not
  known to be finite.
- **The hook does not read `stop_hook_active`, and must not exit 0 because of
  it.** The flag is `true` from the second firing of an episode onward, which is
  every firing where the loop wants to block. A hook that stopped at `true`
  would cap every episode at one round and § 3's loop would never reach round
  2. The round cap is Squiz's only bound on consecutive blocks, and it is the
  only one the runtime offers no help with.
- **Squiz's own round cap has to be a real bound, because nothing else is one.**
  The runtime honoured every block it was given and showed no sign of a ceiling.
  A hook that always exits 2 is an unbounded billed loop, and the round cap
  living in the episode state file is what stops it.
- **The coding agent may refuse the blocking reason as prompt injection, and
  that is the loop failing silently.** In the first run the subagent declined
  all seven blocks, saying the feedback was "unauthenticated content" and not an
  instruction from its caller. Every block still landed, so this is not a
  runtime limit — the machinery worked and the agent chose not to act. § 3's
  loop assumes the coding agent works the threads it is handed. The same
  problem is recorded on the dispatching side in
  `subagent-stop-blocks-and-the-subagent-resumes.md`; this is the side that
  matters more. What the blocking reason has to say for the coding agent to act
  on it is settled in
  `the-blocking-reason-is-trusted-when-it-is-checkable.md`.

## Needs your input

**Whether M1's acceptance criteria include a round where the coding agent acts
on a real blocking reason, rather than only checking that exit 2 was
delivered.** A round that blocks correctly and is then declined looks, from the
pull request, exactly like a round the coding agent ignored: the threads stay
open, the next round re-reads the same code, and the round cap is spent on
nothing. A delivered-but-declined block is otherwise invisible, and delivery is
the only half of it this note established.

The recommendation is yes.

How the coding agent is made to trust the blocking reason is no longer open.
`the-blocking-reason-is-trusted-when-it-is-checkable.md` settles it: the reason
is acted on where it names a pull request the coding agent can confirm for
itself, and the host project declares nothing. A standing line in `AGENTS.md`
saying Squiz's feedback is authorised is rejected there, having been read by a
coding agent as evidence of an attack rather than as permission.

## Reference

### What eight invocations look like

With the hook set to block seven times, the sequence is the same in both runs:

| Invocation | Exit | `outcome` in the stream | `stop_hook_active` |
|---|---|---|---|
| 1 | 2 | `error` | `false` |
| 2 | 2 | `error` | `true` |
| 3 | 2 | `error` | `true` |
| 4 | 2 | `error` | `true` |
| 5 | 2 | `error` | `true` |
| 6 | 2 | `error` | `true` |
| 7 | 2 | `error` | `true` |
| 8 | 0 | `success` | `true` |

The invocation count is what says whether a block landed, and it is better
evidence than anything the flag reports. Each exit 2 resumes the subagent, the
subagent finishes again, and the hook fires again — so a run that stops at the
kth invocation is a runtime that stopped honouring the kth block. Both runs
reached 8, which is 7 honoured blocks and one clean finish.

### What `stop_hook_active` reports, and what it does not

- It is `false` on the first firing and `true` on the second and every firing
  after it, which matches the three firings in
  `subagent-stop-blocks-and-the-subagent-resumes.md`.
- It stays `true` for the whole run of blocks. It did not flip back, decay, or
  change at any point during seven consecutive blocks.
- It was still `true` on invocation 8, the one where the hook exited 0. So it
  reports what happened before this firing, not what the hook is about to do.
- Nothing in the runtime acts on it. It is a report to the hook, not a limit on
  the hook.
- Nothing here says what it reports on a subagent that was blocked earlier and
  has since stopped without being blocked. Both runs blocked continuously, so
  the only `false` either of them saw was on the very first firing. A hook must
  not treat `false` as proof that this is the first firing of an episode
  without establishing that first.

### What the runtime does with the seventh block

Exactly what it does with the first. The reason arrives as a new user message in
the subagent's still-open turn, in the format
`subagent-stop-blocks-and-the-subagent-resumes.md` records:

```
Stop hook feedback:
[<absolute path to the hook command>]: <the hook's stderr, verbatim from here>
```

`agent_id` and `prompt_id` were identical across all eight invocations in both
runs, so all of it is one subagent inside one turn. No message from the runtime
mentioned looping, repetition or a limit, in the stream or in `--debug-file`
output.

### The clamp in the spike hook

`SQUIZ_SPIKE_MAX_BLOCKS` in `spike/hooks/subagent-stop.sh` is now clamped to 7
rather than the 5 it was written with. Seven is the most consecutive blocks
§ 3's round cap can ever ask for, so it is a ceiling with a reason behind it
rather than a round number. A non-numeric value still falls back to 2. The
clamp exists because an always-blocking `SubagentStop` hook is an unbounded
billed loop, and the runtime will not stop one.

**The counter file is still not reset between runs.** Delete `$SQUIZ_SPIKE_DIR`
before each run, or the hook starts over budget and exits 0 the first time it
fires, which looks exactly like a runtime that refused the block.

## Limits

- **Anything above 7 consecutive blocks.** The clamp stops at 7 because that is
  what § 3 can ask for. Whether a ceiling exists at 8, 20 or not at all is
  untested, and 7 is a floor rather than a measurement of the ceiling.
- **Whether `stop_hook_active` ever resets to `false` for a subagent that has
  already been blocked.** Both runs blocked continuously, so neither could break
  a run of blocks and watch what happened. The concurrent worktree work on #15
  reported one incidental observation of the flag back at `false` after a parent
  resumed a subagent by `agent_id` once the block budget was spent. That is a
  lead, not a result: it was not what that run set out to test, and nothing here
  confirms or contradicts it.
- **One model.** `claude-sonnet-5` for both parent and subagent in both runs.
  Nothing says whether a different model changes what the runtime honours.
- **Print mode only.** Both runs were `claude -p`. Interactive sessions were not
  tried.
- **One registered hook, with no `matcher`.** How several `SubagentStop` hooks
  interact over consecutive blocks is untested.
- **Two runs, minutes apart, on one machine and one Claude Code version.**
  Nothing says whether the behaviour is stable across versions.
