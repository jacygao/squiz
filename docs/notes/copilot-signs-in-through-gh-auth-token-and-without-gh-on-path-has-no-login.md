---
settles: "§ 6 — what Copilot's sign-in prompt prints signed in and signed out, and how a signed-out run is reached without touching the user's login; § 4 — where a Copilot reviewer's login comes from"
issue: 673
recorded: 2026-10-08
versions: { copilot: 1.0.93, gh: 2.97.0, macos: 26.6.2 }
recheck-when: Copilot CLI upgrades past 1.0.93 or changes how it finds a login, or gh changes where it keeps its token
---

# Copilot signs in through `gh auth token`, and without `gh` on `PATH` has no login

## Intent

- What `copilot -p` prints and exits with where no login works.
- How to reach that state without signing the user out.

## Decisions

- **Read a non-zero exit from the prompt as a failed sign-in, and print its
  first line with the indented lines under it.** Copilot exits 1 within about a
  second, before any request, and the reason GitHub gave is indented below a
  first line that names none.
- **Make a run signed-out by leaving `gh` off `PATH`, with the token variables
  empty.** Nothing is written to the keychain or to the user's Copilot home, so
  the user's login is untouched. A made-up `COPILOT_GITHUB_TOKEN` does not do
  it while `gh` is on `PATH`: Copilot falls back to `gh`'s login and answers.

## Needs your input

Nothing.

## Reference

Each run was `copilot -p "Reply with the single word OK." --model gpt-5-mini
--no-ask-user` under an empty `COPILOT_HOME` and `COPILOT_ALLOW_ALL=`, in an
empty directory:

| Environment | Exit | Took | What it printed |
|---|---|---|---|
| `PATH` as the user has it | 0 | 13 s | `OK` on stdout; `AI Credits 0.35` on stderr |
| `COPILOT_GITHUB_TOKEN=github_pat_<made up>`, `gh` on `PATH` | 0 | 13 s | `OK`; `AI Credits 0.35` |
| `PATH=/usr/bin:/bin`, `GH_TOKEN=`, `GITHUB_TOKEN=`, `COPILOT_GITHUB_TOKEN=` | 1 | 1 s | the first block below, on stderr |
| The same, with `COPILOT_GITHUB_TOKEN=github_pat_<made up>` | 1 | 8 s | the second block below, on stderr |

```
Error: No authentication information found.

Copilot can be authenticated with GitHub using an OAuth Token or a Fine-Grained Personal Access Token.

To authenticate, you can use any of the following methods:
  • Start 'copilot' and run the '/login' command
  • Set the COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN environment variable
  • Run 'gh auth login' to authenticate with the GitHub CLI
```

```
Error: Authentication token found but could not be validated.

  Failed to fetch PAT user login (401): GitHub returned: Bad credentials

Your token may still be valid. Check your network connection and try again.

To authenticate, you can use any of the following methods:
  • Start 'copilot' and run the '/login' command
  • Set the COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN environment variable
  • Run 'gh auth login' to authenticate with the GitHub CLI
```

The user's login keychain holds one GitHub entry, service `gh:github.com`, and
none for Copilot. Copilot's runtime library names `gh auth token` and an
`AuthInfo::GhCli` login source. `~/.copilot/config.json` holds no
`logged_in_users`.

**This contradicts § 4 Tools**, which says the round leaves alone "Copilot's own
login in the system's credential store". On this machine Copilot has no login
of its own. It signs in with `gh`'s, which it reads by running `gh auth token`,
so a round whose `PATH` has no `gh` would have no model credential.

## Limits

- One machine, signed in to Copilot only through `gh`. A user who ran Copilot's
  `/login` may have an entry of Copilot's own that leaving `gh` off `PATH` does
  not hide. That was not run, because it needs a login this machine does not
  have.
- That no request was made in the signed-out runs is read from the missing
  usage lines and the one-second exit, not from the account's credit history.
