---
settles: "§ 4 — what a round can establish about a recorded process group whose leader has been reaped, and what it may signal on"
issue: 246
recorded: 2026-10-01
versions: { macos: 26.6.2, node: 24.15.0, bash: 3.2.57, ubuntu: 24.04.5, procps: 4.0.4 }
recheck-when: macOS changes what ps -E withholds, Linux's pid_max default changes, or the round's time bound or grace grows
---

# An empty group loses its number inside one round

## Intent

- Whether a group whose leader has been reaped can be shown to be the round's own.
- How close a machine comes to handing a recorded number to a stranger inside one
  round.
- Whether the reviewer can put a number of its own choosing into the record.

## Decisions

- **Hold each recorded number with an ordinary `sleep` of the round's own, named
  in `argv[0]`.** A number cannot be handed out while its group still holds a
  process, and `argv[0]` is the one place both systems show a name for `sleep`.
  Without it a round sends `SIGTERM`, and then `SIGKILL`, to a process of the
  user's own that it never started, which this measurement reached in 106
  seconds. The holder answers `SIGTERM` like anything else, and it can: only the first
  reading asks for it.

- **Before `SIGKILL`, accept a group only where it still holds a process the
  first reading found.** A group that still holds one never emptied, so its number
  was never free to hand out, and it is the group that was signalled. The holder
  cannot answer this question, because it is in the group the `SIGTERM` went to.

- **Refuse a group that holds no process of the round's own.** That is what a
  shell without `exec -a` leaves: the recording line runs and the holder does
  not, so the group is unclaimable rather than wrongly claimed, and a detached
  tool is left running.

- **Do not treat the age test as a guard on macOS.** The pid space comes round in
  about 100 seconds against a round's 480-second bound, so a stranger holding a
  recorded number is younger than the round exactly as the round's own shells
  are. The round still refuses a group holding anything older than itself, but
  that is not what tells its group from a stranger's.

- **Leave the reviewer's ability to forge the record alone.** At `deep` its shell
  runs with the user's permissions and can signal those processes itself, so a
  forged number changes who sent the signal rather than what can be reached.

## Needs your input

- Nothing.

## Reference

The reading the round makes of each recorded group:

```
ps -o pid=,pgid=,etime=,command= -g <the recorded numbers, comma separated>
```

`-g` selects a process group on macOS and a session on Linux. On Linux,
`ps -g 2503` returned pid 2503 of group 2503 and pid 2505 of group 2505, both of
session 2503, and `ps -g 2505` returned nothing. A recorded number that is no
session's gets no rows there, so such a group is neither signalled nor refused.

macOS prints no session in `ps`: `ps -o sess=` gave `0` for every process, pid 1
included. The session is still readable there through `getsid(2)`, reachable as
`os.getsid()` in `/usr/bin/python3`.

### What each reading accepts

| | Before `SIGTERM` | Before `SIGKILL` |
|---|---|---|
| Nothing in the group began before the round | Required | Required |
| A process named for this round's holder | Required | Not asked |
| A process whose pid the first reading found | Not asked | Required |

The pids the second reading looks for are every process the first reading found
in any group it accepted, not only that group's own.

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

The prefix runs these after the line that records the group, with
`SQUIZ_KEEPER` holding the round's name:

```sh
{ [ -n "${SQUIZ_KEEPER:-}" ] && exec -a "${SQUIZ_KEEPER}" sleep 900 >/dev/null 2>&1 & } 2>/dev/null || :
disown 2>/dev/null || :
```

Measured with the line `exec -a "squiz-<the round>" /bin/sleep 900`,
`ps -o pid=,pgid=,command= -g <the group>` printed
`84354 84353 squiz-0ddba11 120`, and the name is there for `/bin/sleep`, whose
environment the same `ps` withholds. It survived a command that `exec`s.
`exec -a` is bash's, and `/bin/sh -c "sleep 120" "squiz-0ddba11"` does not stand
in for it: the shell execs its last command and the name goes with the shell.

**The holder is gone by the second reading wherever the group outlived the
first signal.** The round's `SIGTERM` reaches the holder with everything else,
and a tool that ignores it stays:

```
before TERM   52506 52505 squiz-term01 900
              52507 52505 /bin/bash -c trap "" TERM; sleep 300
after TERM    52507 52505 /bin/bash -c trap "" TERM; sleep 300
```

A second reading that asked for the holder would refuse this group and leave
running the tool the escalation exists for. Pid 52507 is what the first reading
saw, so the reading by pid accepts the group and kills it.

**A tool that answers `SIGTERM` by leaving a fresh process behind and exiting is
not killed.** Every process the group then holds began after the first reading,
so the second refuses it with "nothing in it was there when the round signalled
it", and the fresh process runs on. A holder that ignored `SIGTERM` would still
be there and would let this group be killed. That design was abandoned: the
holder raced the round's own signal, and its test passed alone, failed inside its
file, and passed again once instrumentation added twenty milliseconds.

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
appended number too. That run predates the holder, which the first reading now
asks for, and was not repeated against it.

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

- **The reading by pid also rests on no pid coming round inside the grace.** A
  group whose shell was still running at the first reading has the shell's pid
  among those found, and that pid is the group's own number. Were the group to
  empty and that number lead a stranger's group within the grace, the second
  reading would accept it. The grace is two seconds against a wrap of about 100
  on macOS, and nothing here measured a pid coming round that fast.

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

- **The holder's 900 seconds were chosen, not measured.** It is longer than a
  round's bound, and a round killed before it signals leaves holders running
  until their own `sleep` ends.

- **A refusal reaches no channel yet.** A round that refuses a group, whether it
  holds no holder or only processes the first reading never saw, says so in the
  value it returns and nowhere a person reads.
