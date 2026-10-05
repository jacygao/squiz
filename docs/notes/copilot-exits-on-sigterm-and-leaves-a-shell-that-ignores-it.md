---
settles: "§ 4 — whether Copilot meets Adapters' requirement to exit on SIGTERM, and what of its processes the round's signal reaches; § 7 — what a Copilot round stopped by the time bound leaves running"
issue: 458
recorded: 2026-10-06
versions: { copilot: 1.0.91, model: gpt-5-mini, tmux: 3.7b, macos: 26.6.2 }
recheck-when: Copilot CLI upgrades past 1.0.91, or changes how it starts shell tools or handles signals
---

# Copilot exits on SIGTERM, and leaves a shell that ignores it

## Intent

- Whether the CLI, and every process it starts, the MCP server and shell tools
  among them, exit on `SIGTERM` to the CLI and to its process group.

## Decisions

- **Hold Copilot to the round's bound by signalling its process group, as for
  `pi`.** It meets § 4 Adapters' requirement for itself: on `SIGTERM`, to its pid
  or to its group, mid-command or idle, it exited at once. It took its MCP server
  down with it, and the bash running a shell call, and that bash's children.
- **Tell a stopped run from a finished one by the stream, not by the exit
  status.** Copilot exited 0 on `SIGTERM`, in `-p` and in `-i`. A stopped `-p`
  run ends its stream with `agent.interrupted`, then `abort` with
  `"reason":"user_initiated"`, then `result`, whose `exitCode` is also 0.
- **Record each shell's group, as § 4 Confinement does for `pi`, because
  Copilot runs every shell call in a session of its own.** The shell leads its
  own session and group, so the round's signal to Copilot's group never reaches
  it. Copilot signals it on the way out, and that is all that does:
  - a shell that ignored `SIGTERM` and `SIGHUP` outlived Copilot, reparented to
    `launchd`, and was still running 41 seconds later;
  - after `SIGKILL` to Copilot's group, an ordinary `sleep` survived the same way.

  So § 4 Adapters' case of a CLI that starts a shell tool in a group of its own
  is Copilot's case, at depth `deep`.

## Needs your input

Nothing.

## Reference

The processes of a `-p` run mid-call, with `ps -o pid,ppid,pgid,stat`:

```
62352 45814 62352 Ss+  copilot -p …
62562 62352 62352 S+   node …/server.mjs                     (MCP server, Copilot's group)
62858 62352 62858 Ss   /bin/bash --norc --noprofile -c sleep 345 && echo finished
62859 62858 62858 S    sleep 345
```

What each stop did:

| Signal | Copilot | MCP server | Shell call |
|---|---|---|---|
| `SIGTERM` to Copilot's pid, mid-call | exit 0 | got `SIGHUP` | gone |
| `SIGTERM` to Copilot's group, mid-call | exit 0 | got `SIGTERM` | gone |
| `SIGTERM` to Copilot's group, shell ignoring `TERM` and `HUP` | exit 0 at once | got `SIGTERM` | **survived** |
| `SIGKILL` to Copilot's group, mid-call | killed | killed | **survived** |
| `SIGTERM` to an idle `copilot -i` | exit 0 | got `SIGTERM` | — |
| `-p` run ending by itself | exit 0 | got `SIGTERM` | — |

On `SIGTERM` the run still wrote `--usage-output-file`. After `SIGKILL` it wrote
none.

## Limits

- One run of each row. The tmux window's command was Copilot itself, so its pid
  led its group, as it does for a round's reviewer in tmux.
- Which signal Copilot sends its shells was not read. The shell that ignored
  `SIGTERM` and `SIGHUP` survived it, and Copilot did not wait to escalate.
- **How a shell would record its group under Copilot.** `pi` runs a settings
  line before every command. Copilot's nearest is `--bash-env`, which enables
  `BASH_ENV` for its bash shells *(unverified — read from `--help`, never run)*.
  Copilot starts bash with `--norc --noprofile`, and nothing here shows that a
  file `BASH_ENV` names is read then.
- A shell call that Copilot had moved to the background, the case its
  `read_bash` and `stop_bash` tools serve, was not stopped. Every call here was
  still in its `initial_wait`.
