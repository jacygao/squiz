---
settles: "§ 4 — what a round can establish about a recorded process group whose leader has been reaped, and what it may signal on"
issue: 246
recorded: 2026-10-01
versions: { macos: 26.6.2, node: 24.15.0, bash: 3.2.57, ubuntu: 24.04.5, procps: 4.0.4 }
recheck-when: macOS changes what ps -E withholds, Linux's pid_max default changes, or the round's time bound grows
---

# An empty group loses its number inside one round

## Intent

- Whether a group whose leader has been reaped can be shown to be the round's own.
- How close a machine comes to handing a recorded number to a stranger inside one
  round.
- Whether the reviewer can put a number of its own choosing into the record.

## Decisions

- **Hold a recorded number with a process of the round's own, named in
  `argv[0]`.** A number cannot be handed out while its group still holds a
  process, and `argv[0]` is the one place both systems show a name for
  `/bin/sleep`.

- **Do not treat the age test as a guard on macOS.** The pid space comes round in
  about 100 seconds against a round's 480-second bound, so a stranger holding a
  recorded number is younger than the round exactly as the round's own shells
  are. This contradicts § 4, which has the round signal only where the system
  says the group is still its own.

- **Leave the reviewer's ability to forge the record alone.** At `deep` its shell
  runs with the user's permissions and can signal those processes itself, so a
  forged number changes who sent the signal rather than what can be reached.

## Needs your input

- **Whether to leave one process of the round's own alive in each recorded
  group.** It costs a line in the shell prefix and one process per shell tool for
  the rest of the round, and it answers the question the age test cannot: the
  number cannot be taken while the group holds it, and the holder carries the
  round's name where every `ps` on both systems prints it. Recommended: take it.
  The alternative is a round that sends `SIGTERM`, and then `SIGKILL`, to a
  process of the user's own that it never started, which this measurement reached
  in 106 seconds. **Which program holds it is unresolved**, and an ordinary
  `/bin/sleep` is not the answer: it dies on the round's own `SIGTERM`, before the
  reading that decides whether to escalate.

- **What a shell with no `exec -a` should mean.** The line that leaves the
  process behind is bash's, and the prefix is silent about its own failures by
  design, so under a shell without it no process is left and the round is back
  to the age test with nothing saying so. Recommended: have the round refuse a
  group it finds no process of its own in, and report the refusal. A round that
  recorded groups and signalled none is then visible rather than silent.

## Reference

The reading the round makes of each recorded group:

```
ps -o pid=,pgid=,etime= -g <the recorded numbers, comma separated>
```

`-g` selects a process group on macOS and a session on Linux. On Linux,
`ps -g 2503` returned pid 2503 of group 2503 and pid 2505 of group 2505, both of
session 2503, and `ps -g 2505` returned nothing. A recorded number that is no
session's gets no rows there, so such a group is neither signalled nor refused.

macOS prints no session in `ps`: `ps -o sess=` gave `0` for every process, pid 1
included. The session is still readable there through `getsid(2)`, reachable as
`os.getsid()` in `/usr/bin/python3`.

### Reading a process's environment

On macOS the environment follows the command in the same `ps` call that reads
the age, so nothing more is run:

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
read returned 5,112 to 5,149 bytes. It is one read per process.
`ps eww -p <pid>` returns the same content in 5,193 to 5,249 bytes, and
`ps -ww -p <pid> eo pid=,args=` in 5,135 to 5,191. The flag is `-E` on macOS and
`e` on Linux.

### Leaving a process behind, named for the round

Run inside the recording shell, after the line that records the group:

```sh
exec -a "squiz-<the round>" /bin/sleep 900 >/dev/null 2>&1 &
```

`ps -o pid=,pgid=,command= -g <the group>` then prints
`84354 84353 squiz-0ddba11 120`, and the name is there for `/bin/sleep`, whose
environment the same `ps` withholds. It survived a command that `exec`s.
`exec -a` is bash's, and `/bin/sh -c "sleep 120" "squiz-0ddba11"` does not stand
in for it: the shell execs its last command and the name goes with the shell.

**A holder must outlive the `SIGTERM` the round sends first.** The shutdown
signals the group, waits the grace, and establishes the group's identity a second
time before it escalates, because a `SIGKILL` cannot be taken back. An ordinary
`/bin/sleep` dies on that first signal, so a group holding a tool that ignores
`SIGTERM` has lost its holder by the second reading:

```
before TERM   52506 52505 squiz-term01 900
              52507 52505 /bin/bash -c trap "" TERM; sleep 300
after TERM    52507 52505 /bin/bash -c trap "" TERM; sleep 300
```

A round that refuses a group with no holder of its own then refuses this one and
leaves the tool running, which is the case the escalation exists for. A holder
that ignores `SIGTERM` and dies at `SIGKILL` is what the two readings need, and
which program should hold it that way was not measured.

A process carrying the round's name is not a proof of the round's own group. One
can be put into a group the round never created, where that group is in the
reviewer's own session. This joined a group holding a process of the user's own,
and `ps -Eww -g <group>` then showed the round's token in it:

```sh
perl -e 'use POSIX; POSIX::setpgid(0,<group>); exec("node", "-e", "...")'
```

### Forging a record

The path reaches the shell as `SQUIZ_GROUPS`. `printenv SQUIZ_GROUPS` printed
`/var/folders/.../round.<uuid>/groups`, and this appended a number of its own:

```sh
printf '%s\n' <a pid> >> "$SQUIZ_GROUPS"
```

`recordedGroups` then returned both the shell's own number and the appended one,
`stopRecordedGroups` returned `{"signalled":[6030],"refused":[]}`, and the
process named 6030 was gone. The same run on Linux signalled and killed the
appended number too.

`SQUIZ_GROUPS=` appears in the `ps -Eww` output of every `node` the round runs,
so the path is readable by anything of the user's uid, not by the reviewer
alone.

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
  imported from there. The shells were `/bin/bash` started detached, the way
  `pi` starts one, with the prefix prepended as a line.

- **The allocation rate came from one shell loop running `/usr/bin/true`.** No
  build, test suite or compiler was measured, and nothing here says how long a
  real machine sustains a thousand a second.

- **The strangers that took the numbers were started on purpose, each detached
  so that it led a group.** What the run establishes is that the numbers were
  handed out again inside the round, and that a new process holding one is
  signalled. How often a machine's own next process both takes a recorded number
  and leads a group was not measured.

- **The wrap point is reckoned from the counter's own arithmetic**, not read
  from a kernel variable, and the number it restarts from was not seen.

- **Why macOS withholds an environment was not established.** Every program it
  withheld for sits in `/bin` or `/usr/bin`, and the two it showed run from
  elsewhere. A copy of `/bin/sleep` would have separated the program from where
  it sits, and the copy will not run.

- **Whether root reads such an environment on macOS was not tested.** Nothing
  here ran as root, which is the case that matters.

- **The `ps` probe did not establish whether the round's shells share a session
  with processes of the user's own.** That is what a forged holder needs. macOS
  prints no session in `ps -o sess=`, and that is the column rather than the
  machine: `getsid(2)` is there, reachable as `os.getsid()` in
  `/usr/bin/python3`, and it answers. The question is open because this probe used
  the column, not because the system withholds it.

- **The 200 processes left behind were measured against the pid space, not
  against `pi`.** Nothing says what `pi` makes of a shell tool whose group keeps
  a process alive for the rest of the round. The one left behind here held no
  pipe of the shell's, because its output went to `/dev/null`.

- **A bound for how long such a process should live was neither chosen nor
  measured.** A round killed before it signals leaves them running until their
  own `sleep` ends.
