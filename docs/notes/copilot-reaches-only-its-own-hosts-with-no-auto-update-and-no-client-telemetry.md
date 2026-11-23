---
settles: "§ 5: the hosts a Copilot reviewer reaches, and the two flags that keep it to them"
issue: [797, 805]
recorded: 2026-11-23
versions: { copilot: "1.0.107, 1.0.110", model: gpt-6-astra, node: 24.15.0, macos: 26.6.2 }
recheck-when: Copilot CLI upgrades past 1.0.110, changes its telemetry, update check or experiment host, or stops honouring HTTPS_PROXY
---

# Copilot reaches only its own hosts with `--no-auto-update` and `--disable-client-telemetry`

## Intent

- Which hosts a real Copilot reviewer run reaches with both flags on.
- Whether the flags change that set.

## Decisions

- **Pass `--no-auto-update` and `--disable-client-telemetry` on every reviewer
  run.** With both, a reviewer reached `api.github.com`,
  `api.enterprise.githubcopilot.com` and, from a fresh `COPILOT_HOME`,
  `exp.enterprise.githubcopilot.com`, and nothing else. Without them, the same
  run also reached `cafe.github.com` and
  `telemetry.enterprise.githubcopilot.com`.
- **Allow `exp.enterprise.githubcopilot.com` wherever a Copilot reviewer's
  network is confined.** Copilot 1.0.110 reaches it whenever `COPILOT_HOME` is
  empty, and the reviewer always starts from a fresh one under its round's
  `session/`. Whether a round works with it blocked was not tried.

## Needs your input

Nothing.

## Reference

| Host, all on port 443 | Reached by the reviewer |
|---|---|
| `api.github.com` | Always |
| `api.enterprise.githubcopilot.com` | Always. The model host for this account's plan, a Business or Enterprise seat's (unverified); another plan's was not seen |
| `exp.enterprise.githubcopilot.com` | On 1.0.110 from an empty `COPILOT_HOME`; not on 1.0.107 |
| `cafe.github.com`, `telemetry.enterprise.githubcopilot.com` | Only without the two flags |

A coding agent on the same flags reaches `exp.enterprise.githubcopilot.com`
too when its `COPILOT_HOME` is empty, and not from a used `~/.copilot`.

**This differs from § 5 The Copilot adapter**, which says a Copilot run reaches
"only Copilot's own host and its model's". On 1.0.110 Copilot has two hosts of
its own beside the model's.

Without a proxy, `api.enterprise.githubcopilot.com`, `cafe.github.com` and
`telemetry.enterprise.githubcopilot.com` all resolve behind the same
`glb-db52c2cf8be544.github.com`, so an address-based allowlist cannot tell the
model host from the telemetry host.

## Limits

- **A direct connection shorter than one socket sample, about 80 ms, could have
  been missed.** The proxy sees only connections that honour `HTTPS_PROXY`.
- **No auto-update host appeared** in the run without the flags, so the effect
  of `--no-auto-update` on its own was not observed. Copilot may check for an
  update less often than once a run.
- **DNS was not captured.**
- **The 1.0.110 reviewer's hosts are attributed by time**, from the windows in
  which it was the only Copilot process alive.
- **Detached runs only, on one machine and one plan.** A pane runs the same line
  and was not captured.
