---
settles: "§ 4 — how a reviewer CLI is told to record the group of each shell it detaches, which groups a round may signal, and what a round can establish about one; § 8 — whether `ps` is a subprocess the harness runs"
issue: 242
recorded: 2026-09-29
versions: { pi: 0.85.1, node: 24.15.0, bash: 3.2.57, macos: 26.6.2 }
recheck-when: pi upgrades, pi's settings resolution changes, or the harness runs on Linux
---

# The shell prefix arrives through a directory that moves whole

## Intent

- **Nothing said which route delivers `shellCommandPrefix` to an installed
  `pi`.** It is a setting rather than a flag, and `pi --help` names no option
  that carries one.
- **Nothing said what else redirecting `pi`'s configuration directory costs.**
  The credential lives in the same directory, and so might other things.
- **Nothing said whether a symlinked credential survives `pi` writing to it.** A
  rewrite that replaces the file rather than writing through it would leave a
  copy of the user's credential in squiz's own directory.
- **Nothing said whether a prefix prepended as a line survives the command it is
  prepended to.** A here-document, an `exec` and an unterminated quote could each
  swallow it.
- **Nothing said whether `pi` stalls on a tool whose stdout a backgrounded
  descendant holds open.** A stall would end a finished review at the round's
  time bound.
- **Nothing said what can be established about a recorded process group once the
  shell that recorded it has been reaped.**

## Decisions

- **Deliver the prefix by pointing `PI_CODING_AGENT_DIR` at a directory the round
  owns, holding a `settings.json`.** `pi` resolves its global settings to
  `<that directory>/settings.json`, and the value of `shellCommandPrefix` is run
  as a line inside every shell tool, before the command the reviewer gave. There
  is no flag and no other environment variable for it.

- **Mirror the user's own configuration directory into it rather than writing the
  settings alone.** Every path `pi` resolves hangs off the same directory: its
  credential, its model catalogue and the binaries it puts on the shell's path.
  Link every entry and write only `settings.json`, from the user's own settings
  with the prefix added.

- **Carry the user's settings forward into that file.** The harness names no
  model on its command line, so `defaultProvider` and `defaultModel` come from
  the settings. A directory holding the prefix alone runs the reviewer on
  whatever `pi` defaults to, which is a different model and no complaint.

- **Put the round's own line in front of a prefix the user configured**, rather
  than replacing it. A prefix of the user's that exits or fails would otherwise
  stop the recording line from running at all.

- **Link the credential rather than copying it.** `pi` writes `auth.json` in
  place, so the link is followed and the user's own file is what changes. No copy
  of the credential lands in the round's directory.

- **Expect the shell to be gone and its group to live on.** `pi` reaps each shell
  tool about a tenth of a second after it exits, so by the end of a round
  `ps -p <the recorded identifier>` answers nothing while the group still holds
  whatever the shell backgrounded. Asking about the group is the only reading
  that sees it.

- **Signal a recorded group only where every process in it is younger than the
  round.** The identifier is the shell's own and is free the moment that shell is
  reaped, so nothing about the number alone says it is still the round's. Refuse a
  group `ps` would not answer about, rather than signalling it.

- **Do not expect `pi` to stall on a tool whose output a backgrounded descendant
  holds open.** It waits for the pipes to fall idle rather than to close, and
  returns about a tenth of a second after the shell exits. A `sleep 600` holding
  the pipe delayed the tool call by 104 ms.

- **Expect the prefix to run whatever the command turns out to be.** A command
  that `exec`s, one opening a here-document, one with an unterminated quote, one
  that is only a comment and an empty one each ran the prefix first.

- **Redirect the shell's stderr before the append, not after.** A record that
  cannot be opened is the shell's own complaint rather than `printf`'s, so a
  redirection written after the append arrives in the reviewer's tool output as
  though the command had made it.

## Needs your input

- **Whether a group whose leader has been reaped can be shown to be the round's
  own.** Every process in such a group began during the round, and so would every
  process of a stranger's group that took the identifier after the round's own
  emptied. What would settle it is a per-round token in the environment the
  shells inherit, read back from a member of the group; on macOS `ps -E` prints
  another process's environment, and on Linux it does not. Recommended: leave it,
  and treat the age test as the guard. Reaching the stranger needs the whole pid
  space to turn over inside one round, and the record is the reviewer's to write
  anyway.

- **Whether two `pi` processes writing `auth.json` through two directories can
  lose one of the writes.** The lock file sits beside the path each process was
  given, so a round's `pi` and the user's own take different locks over one file.
  Only a refreshed OAuth token is ever written, and an API key is not. Recommended:
  leave it until squiz runs against a provider whose credential expires.

## Reference

The variable is `PI_CODING_AGENT_DIR`, and `pi` falls back to `~/.pi/agent`. What
it resolves against that directory: `settings.json`, `auth.json`,
`models-store.json`, `models.json`, `bin/` (prepended to the shell's `PATH`),
`tools/`, `prompts/`, `themes/` and `sessions/`. The setting is
`shellCommandPrefix`, a string, and `pi` joins it to the command with a newline.

The line each shell runs, which exits 0 and says nothing on either stream:

```sh
printf '%s\n' "$$" 2>/dev/null >> "${SQUIZ_GROUPS:-/dev/null}" || :
```

`$$` inside it is the shell's own identifier, and a shell `pi` started leads the
group that identifier names, so the line records the group holding everything the
command goes on to start.

What the system is asked at the end of a round:

```
ps -o pid=,pgid=,etime= -g <the recorded identifiers, comma separated>
```

`-g` takes a comma-separated list and may be repeated. It exits 1 with nothing on
either stream where none of the groups exists, which is an answer rather than a
failure, and 0 where any one of them does. `etime` arrives as `[[dd-]hh:]mm:ss`
and counts whole seconds, so a process of the round can report a second more than
the round has run. On macOS `-g` selects a process group; on Linux it selects a
session (unverified). A shell started detached leads both under one identifier,
so a row belongs to a recorded group where its own `pgid` is that identifier.

A shell that backgrounds something and exits leaves this shape, which is what the
round has to reach:

```
$ ps -o pid=,pgid= -p 23954        # the shell: nothing, it has been reaped
$ ps -o pid=,pgid=,command= -g 23954
23955 23954 sleep 45
```

## Limits

- **One machine, one operating system, one `pi`, one provider.** macOS 26.6.2,
  `pi` 0.85.1, `deepseek-v4-pro`. Nothing here was run on Linux, and the meaning
  of `ps -g` there is read from its documentation rather than measured.

- **One real round.** A single `pi --print` run with `--tools bash` recorded one
  group and cost $0.008. Everything else about the shell was measured against
  `/bin/bash` spawned the way `pi` spawns it.

- **The identifier a group reserves was not measured.** That a process group's
  identifier cannot be handed to a new process while the group has members is
  taken from how the systems document themselves, not from an observation here.
  The age test does not rest on it; the residual risk above does.

- **A hostile record was not modelled.** The path is in the reviewer's own
  environment and the reviewer has a shell, so a reviewer that sets out to make
  the round signal something can. The guard is against a stale identifier and a
  garbled record.

- **Nothing was measured about a round whose reviewer ran many shells.** One
  shell, one recorded group. The reading is batched at 128 identifiers per `ps`
  on the argument list's account alone.
