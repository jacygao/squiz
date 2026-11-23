---
settles: "§ 5: whether Copilot meets Adapters' requirement to exit on SIGTERM, what of its processes the round's signal reaches, and why the Copilot grant has no shell; § 8: what a Copilot round stopped by the time bound leaves running"
issue: 458
recorded: 2026-10-06
versions: { copilot: 1.0.91, model: gpt-5-mini, tmux: 3.7b, macos: 26.6.2 }
recheck-when: Copilot CLI upgrades past 1.0.91, or changes how it starts shell tools or handles signals
---

# A signal to Copilot's group stops everything but its shell calls

## Intent

- Whether the CLI, and every process it starts, the MCP server and shell tools
  among them, exit on `SIGTERM` to the CLI and to its process group.

## Decisions

- **Hold Copilot to the round's bound by signalling its process group, as for
  `pi`.** On `SIGTERM`, to its pid or its group, mid-command or idle, Copilot
  exited at once and took its MCP server down with it.
- **Never read Copilot's exit status as a finished review.** Copilot exited 0
  on `SIGTERM`, under `-p` and `-i`, and still wrote `--usage-output-file`.
- **Grant Copilot no shell tool.** Copilot runs each shell call in a process
  group of its own, so the round's signal never reaches it. Copilot signals it
  on the way out, and nothing else does:
  - a shell that ignored `SIGTERM` and `SIGHUP` outlived Copilot, reparented to
    `launchd`, and was still running 41 seconds later;
  - after `SIGKILL` to Copilot's group, an ordinary `sleep` survived the same
    way.

  With no shell granted, everything Copilot starts, the reporting server and
  the `git` a history tool runs, stays in the group the round signals.

## Needs your input

Nothing.

## Reference

The processes of a `-p` run mid-call, from `ps -o pid,ppid,pgid,stat`:

```
62352 45814 62352 Ss+  copilot -p …
62562 62352 62352 S+   node …/server.mjs                     (MCP server, Copilot's group)
62858 62352 62858 Ss   /bin/bash --norc --noprofile -c sleep 345 && echo finished
62859 62858 62858 S    sleep 345
```

| Signal | Copilot | MCP server | Shell call |
|---|---|---|---|
| `SIGTERM` to Copilot's pid, mid-call | exit 0 | got `SIGHUP` | gone |
| `SIGTERM` to Copilot's group, mid-call | exit 0 | got `SIGTERM` | gone |
| `SIGTERM` to Copilot's group, shell ignoring `TERM` and `HUP` | exit 0 at once | got `SIGTERM` | survived |
| `SIGKILL` to Copilot's group, mid-call | killed | killed | survived |
| `SIGTERM` to an idle `copilot -i` | exit 0 | got `SIGTERM` | none running |
| `-p` run ending by itself | exit 0 | got `SIGTERM` | none running |

After `SIGKILL` Copilot wrote no usage file.

## Limits

- **One run of each row**, with Copilot as the tmux window's command, so its pid
  led its group. A round runs Copilot under the adapter's `sh` line, which
  leads the group instead, and that this changes nothing here is (unverified).
- **Which signal Copilot sends its shells was not read.** It did not wait to
  escalate.
- **A shell call Copilot had moved to the background**, the case its
  `read_bash` and `stop_bash` tools serve, was not stopped.
