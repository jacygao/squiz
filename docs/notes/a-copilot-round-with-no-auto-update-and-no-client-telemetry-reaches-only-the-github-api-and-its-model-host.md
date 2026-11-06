---
settles: "§ 5 — the hosts a Copilot reviewer run reaches, and the two flags that keep it to them"
issue: 797
recorded: 2026-11-07
versions: { copilot: 1.0.107, model: gpt-6-astra, node: 24.15.0, macos: 26.6.2 }
recheck-when: Copilot CLI upgrades past 1.0.107, changes its telemetry or update check, or stops honouring HTTPS_PROXY
---

# A Copilot round with `--no-auto-update` and `--disable-client-telemetry` reaches only the GitHub API and its model host

## Intent

- Which hosts one real Copilot reviewer run reaches with both flags on.
- Whether the flags change that set.

## Decisions

- **Pass `--no-auto-update` and `--disable-client-telemetry` on every reviewer
  run.** With both, the run reached `api.github.com` and
  `api.enterprise.githubcopilot.com` and nothing else. Without them, the same run
  also reached `cafe.github.com` and `telemetry.enterprise.githubcopilot.com`.

## Needs your input

Nothing.

## Reference

Each run was the adapter's own line, from `argv` and `confine`, with the round's
`variablesOf` environment and `terminal: "none"`. The snapshot was a one-commit
git repository under `TMPDIR`, and the model was the user's default. Every run
exited 0 and its report file held a finding and a finish.

The hosts come from a logging forward proxy on `127.0.0.1`, named in
`HTTPS_PROXY` and `HTTP_PROXY`, which wrote down every `CONNECT` target:

| Run | Hosts, all on port 443, in the order first reached |
|---|---|
| With both flags | `api.github.com`, `api.enterprise.githubcopilot.com` |
| Without them | `api.github.com`, `api.enterprise.githubcopilot.com`, `cafe.github.com`, `telemetry.enterprise.githubcopilot.com` |

**The proxy saw every connection the process tree made.** While each run lasted,
`lsof -a -g <pgid> -i -n -P` and `ps -g <pgid>` were sampled about every 80 ms,
225 and 246 times. `ps` saw `sh`, `copilot`, the reporting server's `node`, a
history tool's `git`, and Copilot's `gh auth token` and `security
find-generic-password -s gh:github.com`. Every socket `lsof` listed belonged to
`copilot`, and every one was connected to the proxy. No socket went anywhere else.

A third run with both flags and no proxy held sockets to two remote addresses
only: `4.237.22.34`, which `api.github.com` resolved to, and `140.82.112.22`,
one of the `glb-db52c2cf8be544.github.com` addresses behind
`api.enterprise.githubcopilot.com`.

The model host is the plan's. This account's reached
`api.enterprise.githubcopilot.com`, which is a Business or Enterprise seat's
host (unverified). Another plan's host was not observed.

## Limits

- A direct connection shorter than one `lsof` sample, about 80 ms, could have
  been missed. The proxy sees only connections that honour `HTTPS_PROXY`.
- No auto-update host appeared in the run without the flags, so the effect of
  `--no-auto-update` on its own was not observed. Copilot may check for an update
  less often than once a run.
- DNS is resolved by the system's `mDNSResponder`, outside the process tree, and
  was not captured.
- The run without a proxy cannot tell the model host from the telemetry host by
  address: `api.enterprise.githubcopilot.com`, `cafe.github.com` and
  `telemetry.enterprise.githubcopilot.com` all resolve behind the same
  `glb-db52c2cf8be544.github.com`.
- One run of each kind, on one machine, on one plan, detached. A pane runs the
  same line and was not captured.
