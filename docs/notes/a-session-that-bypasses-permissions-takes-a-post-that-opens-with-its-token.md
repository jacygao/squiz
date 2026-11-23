---
settles: "§ 3: what the round host's wake must carry to reach a Claude Code session that bypasses permission prompts"
issue: 840
recorded: 2026-11-24
versions: { claude-code: 2.1.330, macos: 26.6.2 }
recheck-when: Claude Code changes how it checks CLAUDE_CODE_MESSAGING_TOKEN, how it classes a post from a process it did not start, or what `crossSessionInbound` defaults to
---

# A session that bypasses permissions takes a post that opens with its token

## Intent

- Whether a post to the messaging socket of a session started with
  `--dangerously-skip-permissions` is delivered, or held for a person.
- Whether the post can attest something that gets it delivered, or whether
  setting `crossSessionInbound` to `accept` is the only route.

## Decisions

- **Open every wake with the session's token, as an auth line.** The session
  delivered a post that opened with its `CLAUDE_CODE_MESSAGING_TOKEN` and
  answered it within seconds, though the poster was a process the session had
  not started. It held the same post without the token, and with a wrong token.
  Claude Code reads a post carrying the token as one from the session's own
  child, and delivers that whatever the session's permission mode.
- **Have the hook record the token beside the socket.** Claude Code exports the
  token to hooks with the socket, and a subagent's hook sees its parent's. The
  round host is detached from the hook, so it has the token only if the hook
  writes it down.
- **Leave `crossSessionInbound` and the permission mode alone.** The token is
  enough under the default, so squiz needs no setting from the user. A
  `from-mode` attribute exists only in the envelope one session's `SendMessage`
  writes, and squiz would have to claim a class to use it.

## Needs your input

Nothing.

## Reference

The post, one JSON object per line on one connection:

```
{"type":"auth","token":"<CLAUDE_CODE_MESSAGING_TOKEN>"}
{"type":"user","message":{"role":"user","content":"<text>"}}
```

Without the token, the pane shows this and starts no turn until a person picks
"Deliver this message to Claude":

```
Held peer message — from an unidentified session [verified pid 38413]; preview: «…» — not delivered to Claude (1 held). The sender did not attest its permission mode and this session bypasses prompts. Review it below, or set "crossSessionInbound" to "accept".
```

The socket accepts a held post as it accepts a delivered one, and writes nothing
back, so the poster cannot tell the two apart.

The rules for `crossSessionInbound`:

| Value | A wake that opens with the token |
| :- | :- |
| None set | Delivered, in every permission mode |
| `accept` | Delivered |
| `hold` | Held for a person, and never dropped |
| `refuse` | Dropped |

A project's `.claude/settings.json` or `.claude/settings.local.json` can only
make it stricter: an `accept` there is ignored.

## Limits

- **macOS only, one interactive session, on Haiku.** Linux, where Claude Code
  can also verify a child by its process, and a `-p` session were not run.
- **The posts came from a shell beside the session**, not from squiz's round
  host. Both are processes the session did not start.
- **The `hold` and `refuse` rows come from Claude Code's documentation**
  (unverified).
- **A held wake is not detected.** `host.log` still says the owner was woken
  when an explicit `hold` keeps the note from the session.
