---
settles: "§ 4 — what a round can establish about a recorded process group whose leader has been reaped, and what it may signal on"
issue: 246
recorded: 2026-10-01
versions: { macos: 26.6.2, node: 24.15.0, bash: 3.2.57, ubuntu: 24.04.5, procps: 4.0.4 }
recheck-when: macOS changes what ps -E withholds, Linux's pid_max default changes, or the round's time bound grows
---

# An empty group loses its number inside one round

## Intent

- **Nothing said whether a group whose leader has been reaped can be shown to be
  the round's own.** Every process in such a group began during the round, and so
  would every process of a stranger's group that took the number after the
  round's own emptied.
- **Nothing said how close a machine comes to handing a recorded number to a
  stranger inside one round.** The age test rests on that distance being long.
- **Nothing said whether the reviewer can put a number of its own choosing into
  the record.** The path is in the reviewer's own environment and the shell
  appends to the file.

## Decisions

- **Hold a recorded group's identity while the group lives, rather than reading
  it back once the group has emptied.** A number cannot be handed to anything
  while the group still holds a process. One `sleep` left behind in each of 200
  recorded groups kept all 200 numbers through a full turn of the pid space;
  with the same 200 groups empty, strangers took 199 of them.

- **Do not treat the age test as a guard on macOS.** The pid space holds 99,999
  numbers, and one ordinary shell loop running a program allocates about a
  thousand a second, so the space comes round in about 100 seconds. A round's
  time bound is 480. Strangers held 199 of 200 recorded numbers 106 seconds into
  a round, every one of them younger than the round, and the round signalled all
  200 and killed them.

- **§ 4 says the round signals a recorded group only where the system says it is
  still the round's own, and the age reading does not establish that.** It
  separates a group older than the round from a younger one. It does not separate
  the round's own group from a stranger's that took the number, and on macOS that
  case is a hundred seconds of build load away.

- **Name the round in the surviving process's `argv[0]`, not in its
  environment.** macOS withholds a process's environment from `ps -E` where the
  program is one the system ships, and a backgrounded `sleep`, `tail` or `bash`
  loop is exactly that case. It withholds nothing from `argv`.

- **Read a token in the environment as an answer on Linux and as half an answer
  on macOS.** `/proc/<pid>/environ` is readable by the uid that owns the process
  and carries the inherited variable whatever the program is. On macOS `ps -E`
  carries it for `node` and for the Command Line Tools' Python, and carries
  nothing at all for `/bin/sleep`, `/bin/bash` or `/usr/bin/perl`.

- **Expect the reviewer to append any number it likes to the record.** The path
  arrives in the shell as `SQUIZ_GROUPS`, the command the reviewer gives runs in
  the shell the prefix ran in, and the file is the user's own to append to. A
  command standing where the reviewer's stands printed the path and appended the
  number of a process the round never started; the round signalled that number
  and the process died. Hiding the path would not help: it is in the process
  table for the uid to read.

- **Leave the forged record alone, because it gives the reviewer nothing it does
  not already have.** At `deep` the reviewer has a shell that runs with the
  user's own permissions, so it can signal any of the user's processes itself,
  under no age test and with any signal it likes. What the forged record changes
  is who sent the signal, not what can be reached.

## Needs your input

- **Whether to leave one process of the round's own alive in each recorded
  group.** It costs a line in the shell prefix and one `sleep` per shell tool for
  the rest of the round, and it answers the question outright: the number cannot
  be taken while the group holds it, and the process that holds it carries the
  round's name where every `ps` on both systems prints it. Recommended: take it.
  The alternative is a round that sends `SIGTERM`, and then `SIGKILL`, to a
  process of the user's own that it never started, which this measurement reached
  in 106 seconds.

- **What a shell with no `exec -a` should mean.** The line that leaves the
  process behind is bash's, and the prefix is silent about its own failures by
  design, so under a shell without it no process is left and the round is back to
  the age test with nothing saying so. Recommended: have the round refuse a group
  it finds no process of its own in, and report the refusal. A round that
  recorded groups and signalled none is then visible rather than silent.

## Reference

The reading the round makes of each recorded group:

```
ps -o pid=,pgid=,etime= -g <the recorded numbers, comma separated>
```

`-g` selects a process group on macOS and a session on Linux. On Linux
`ps -g 2503` returned pid 2503 of group 2503 and pid 2505 of group 2505, both of
session 2503, and `ps -g 2505` returned nothing: a recorded number that is no
session's gets no rows there, so such a group is neither signalled nor refused.
macOS prints no session for any process — `ps -o sess=` gave `0` for every one,
pid 1 included.

### Reading a process's environment

On macOS the environment follows the command in the same `ps` call that reads the
age, so nothing more is run:

```
ps -Eww -o pid=,pgid=,etime=,command= -g <the recorded numbers>
```

About 2.4 KB per process whose environment is shown, and 12,215 bytes for five
groups of one process each. One call covers every group.

What macOS shows and what it withholds, each measured by looking for a variable
the shell inherited:

| The program left in the group | Its environment in `ps -E` |
|---|---|
| `node`, from the user's own path | Shown |
| `/usr/bin/python3`, which runs a binary under `/Library/Developer` | Shown |
| `/bin/sleep` | Nothing |
| `/bin/bash` | Nothing |
| `/usr/bin/perl` | Nothing |

On Linux the file is `/proc/<pid>/environ`, mode `-r--------` and owned by the
uid, holding the variables NUL-separated. `stat` reports its size as 0 and the
read returned 5,112 to 5,149 bytes. It is one read per process. `ps eww -p <pid>`
returns the same content in 5,193 bytes, and `ps -ww -p <pid> eo pid=,args=` in
5,135. The flag is `-E` on macOS and `e` on Linux.

### Leaving a process behind, named for the round

Run inside the recording shell, after the line that records the group:

```sh
exec -a "squiz-<the round>" /bin/sleep 900 >/dev/null 2>&1 &
```

`ps -o pid=,pgid=,command= -g <the group>` then prints `84354 84353
squiz-0ddba11 120`, and the name is there for `/bin/sleep`, whose environment the
same `ps` withholds. It survived a command that `exec`s. `exec -a` is bash's, and
`/bin/sh -c "sleep 120" "squiz-0ddba11"` does not stand in for it: the shell
execs its last command and the name goes with the shell.

A process carrying the round's name is not a proof of the round's own group. One
can be put into a group the round never created, where that group is in the
reviewer's own session: `perl -e 'use POSIX; POSIX::setpgid(0,<group>);
exec("node", ...)'` joined a group holding a process of the user's own, and
`ps -Eww -g <group>` then showed the round's token in it.

### Forging a record

The path reaches the shell as `SQUIZ_GROUPS`. `printenv SQUIZ_GROUPS` printed
`/var/folders/.../round.<uuid>/groups`, and
`printf '%s\n' <a pid> >> "$SQUIZ_GROUPS"` appended a number. `recordedGroups`
returned both the shell's own number and the appended one, `stopRecordedGroups`
returned `{"signalled":[6030],"refused":[]}`, and the process named 6030 was
gone. The same run on Linux signalled and killed the appended number too.

`SQUIZ_GROUPS=` appears in the `ps -Eww` output of every `node` the round runs,
so the path is readable by anything of the user's uid, not by the reviewer alone.

### How fast a number comes round

| | macOS 26.6.2 | ubuntu 24.04.5 |
|---|---|---|
| Numbers in the space | 99,999 | 4,194,304 (`/proc/sys/kernel/pid_max`) |
| Allocated per second, nothing running but agent sessions | 5.53 | — |
| Allocated per second, one shell loop running a program | 1,008 | 1,539 to 2,000 |
| Seconds for the space to come round under that loop | about 100 | 2,100 to 2,700 |

The macOS space was measured by reading a fresh process's number before and
after: the counter went 93,534, then 34,311 after 40,000 allocations, which puts
the wrap at 99,999 and the restart near 100.

## Limits

- **One macOS machine and one Linux runner.** macOS 26.6.2 on Apple silicon, and
  GitHub's `ubuntu-24.04` image on kernel 6.17.0-1022-azure. A Linux whose
  `pid_max` is 32,768 would come round in about 20 seconds under the same loop,
  which no measurement here covers (unverified).

- **No `pi` ran.** The code measured is `src/reviewers/groups.ts` of the branch
  `reviewers/the-shell-records-its-group`, copied into a scratch directory and
  imported from there. The shells were `/bin/bash` started detached, the way `pi`
  starts one, with the prefix prepended as a line.

- **The allocation rate came from one shell loop running `/usr/bin/true`.** No
  build, test suite or compiler was measured, and nothing here says how long a
  real machine sustains a thousand a second.

- **The wrap point is reckoned from the counter's own arithmetic**, not read from
  a kernel variable, and the number it restarts from was not seen.

- **Why macOS withholds an environment was not established.** Every program it
  withheld for is one the system ships, and the two it showed are not, and a copy
  of `/bin/sleep` could not be measured because the copy will not run.

- **Whether root reads such an environment on macOS was not tested.** Nothing
  here ran as root, which is the case that matters.

- **Whether the round's shells share a session with processes of the user's own
  was not established.** That is what a forged witness needs, and macOS prints no
  session for any process, so this machine cannot answer it.

- **The 200 processes left behind were measured against the pid space, not
  against `pi`.** Nothing says what `pi` makes of a shell tool whose group keeps
  a process alive for the rest of the round. The one left behind here held no
  pipe of the shell's, because its output went to `/dev/null`.

- **A bound for how long such a process should live was neither chosen nor
  measured.** A round killed before it signals leaves them running until their
  own `sleep` ends.
