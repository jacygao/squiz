---
settles: "§ 4 — how a reviewer CLI is told to record the group of each shell it detaches, and what one round's own directory has to carry; § 8 — whether `ps` is a subprocess the harness runs"
issue: 242
recorded: 2026-09-29
versions: { pi: 0.85.1, node: 24.15.0, bash: 3.2.57, macos: 26.6.2 }
recheck-when: pi upgrades, pi's settings resolution changes, or the harness runs on Linux
---

# The shell prefix arrives through a directory that moves whole

## Intent

- Which route delivers `shellCommandPrefix` to an installed `pi`.
- What else moves when `pi`'s configuration directory is redirected.
- Whether a credential reached through a symlink survives `pi` writing to it.
- Whether a prefix prepended as a line survives the command it is prepended to.
- Whether `pi` stalls on a tool whose stdout a backgrounded descendant holds
  open.
- What a round can establish about a recorded process group once the shell that
  recorded it has been reaped.

## Decisions

- **Point `PI_CODING_AGENT_DIR` at a directory the round owns, holding a
  `settings.json`.** No flag and no other variable carries the prefix.
  2026-10-06: removed, with the four decisions after this one. No depth grants
  `pi` a shell, so the adapter writes no settings and leaves
  `PI_CODING_AGENT_DIR` as the user has it. The recording line now runs only in
  the shell `run_tests` starts to lead the test command's group.

- **Mirror the user's whole configuration directory into it: link every entry,
  write `settings.json` alone.** Every path `pi` resolves hangs off that one
  directory, so a directory holding only the settings is a reviewer with no
  credential.

- **Carry the user's own settings forward into that file.** The harness names no
  model on its command line, so a file that dropped them would run the review on a
  model nobody chose.

- **Put the round's own line in front of a prefix the user configured**, rather
  than replacing it. A prefix of theirs that exits or fails would otherwise stop
  the recording line from running at all.

- **Link the credential rather than copying it.** `pi` writes `auth.json` in
  place, so the link is followed and no copy of the user's credential lands in
  the round's directory.

- **Ask the system about the group, not about the shell.** `pi` reaps each shell
  tool about a tenth of a second after it exits, and the group lives on holding
  whatever that shell backgrounded.

- **Refuse a group `ps` will not answer about, rather than signalling it.** A
  stranger's process killed over a number the system handed on is worse than a
  tool left running.

- **Expect the prefix to run whatever the command turns out to be.** Five
  commands that could have swallowed it did not: one that `exec`s, one opening a
  here-document, one with an unterminated quote, one that is only a comment, and
  an empty one.

- **Redirect the shell's stderr before the append, not after.** A record that
  cannot be opened is the shell's own complaint rather than `printf`'s, so a
  redirection written after the append arrives in the reviewer's tool output as
  though the command had made it.

- **Do not expect `pi` to stall on a tool whose output a backgrounded descendant
  holds open.** It waits for the pipes to fall idle rather than to close, and
  returns about a tenth of a second after the shell exits.

## Needs your input

- Nothing.

## Reference

### The directory

The variable is `PI_CODING_AGENT_DIR`, and `pi` falls back to `~/.pi/agent`. What
it resolves against that directory: `settings.json`, `auth.json`,
`models-store.json`, `models.json`, `bin/` (prepended to the shell's `PATH`),
`tools/`, `prompts/`, `themes/` and `sessions/`.

The setting is `shellCommandPrefix`, a string, which `pi` joins to the command
with a newline and runs inside every shell tool.

### The line each shell runs

It exits 0 and says nothing on either stream:

```sh
printf '%s\n' "$$" 2>/dev/null >> "${SQUIZ_GROUPS:-/dev/null}" || :
```

`$$` is the shell's own identifier, and a shell `pi` started leads the group that
identifier names, so the line records the group holding everything the command
goes on to start.

### What the round asks the system

```
ps -o pid=,pgid=,etime= -g <the recorded identifiers, comma separated>
```

`-g` takes a comma-separated list and may be repeated. It exits 1 with nothing on
either stream where none of the groups exists, which is an answer rather than a
failure, and 0 where any one of them does. `etime` arrives as `[[dd-]hh:]mm:ss`
and counts whole seconds, so a process of the round can report a second more than
the round has run. On macOS `-g` selects a process group; on Linux it selects a
session *(unverified)*. A shell started detached leads both under one identifier,
so a row belongs to a recorded group where its own `pgid` is that identifier.

A shell that backgrounds something and exits leaves this shape, which is what the
round has to reach:

```
$ ps -o pid=,pgid= -p 23954        # the shell: nothing, it has been reaped
$ ps -o pid=,pgid=,command= -g 23954
23955 23954 sleep 45
```

## Limits

- **Age alone does not separate the round's own group from a stranger's.** A
  group's number is handed on once the group empties, and what takes it began
  after the round did, exactly as the round's own shells did. What this note
  establishes is what a recorded number cannot say, not what can be put in its
  place.

- **One machine, one operating system, one `pi`, one provider.** macOS 26.6.2,
  `pi` 0.85.1, `deepseek-v4-pro`. Nothing here was run on Linux, and the meaning
  of `ps -g` there is read from its documentation rather than measured.

- **One real round.** A single `pi --print` run with `--tools bash` recorded one
  group and cost $0.008. Everything else about the shell was measured against
  `/bin/bash` spawned the way `pi` spawns it.

- **The identifier a group reserves was not measured.** That a process group's
  identifier cannot be handed to a new process while the group has members is
  taken from how the systems document themselves, not from an observation here.

- **A hostile record was not modelled.** The path is in the reviewer's own
  environment and the reviewer has a shell, so a reviewer that sets out to make
  the round signal something can. The guard is against a stale identifier and a
  garbled record.

- **Nothing was measured about a round whose reviewer ran many shells.** One
  shell, one recorded group. The reading is batched at 128 identifiers per `ps`
  on the argument list's account alone.

- **Nothing was established about two `pi` processes writing `auth.json` at once.**
  Each round is handed its own directory, so each takes its lock beside its own
  path. Only a refreshed token is ever written, and an API key is not, so no write
  happens to be lost.

