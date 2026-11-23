---
settles: "§ 7 The setup check: how Copilot's sign-in is checked and read; § 5 Adapters: the line that names a reviewer not signed in, and how a signed-out run is reached without touching the user's login"
issue: [673, 849]
recorded: 2026-10-08
versions: { copilot: "1.0.93, 1.0.109", gh: 2.97.0, macos: 26.6.2 }
recheck-when: Copilot CLI upgrades past 1.0.109, changes how it finds a login or words a missing one, gains a command that reports a sign-in, or gh changes where it keeps its token
---

# A signed-out Copilot exits 1, saying `No authentication information found`

## Intent

- Whether any `copilot` command reports a sign-in without a model request.
- What `copilot -p` prints and exits with where no login works.
- How to reach that state without signing the user out.

## Decisions

- **Check Copilot's sign-in with one real prompt, and say that it spent a
  request.** No `copilot` command reports a sign-in without reaching the model.
  The owner chose a real request over no check.
- **Read a non-zero exit from the prompt as a failed sign-in, and print its
  first line with the indented lines under it.** Copilot exits 1 within about a
  second, before any request, and indents the reason GitHub gave below a first
  line that names none.
- **Read the exact stderr line `Error: No authentication information found.` as
  a reviewer that is not signed in.** Leave `Error: Authentication token found
  but could not be validated.` unrecognised: a token GitHub refused may be a
  network failure rather than a sign-out.
- **Make a run signed out by leaving `gh` off `PATH`, with the token variables
  empty.** Nothing is written to the keychain or to the user's Copilot home, so
  the user's login is untouched. A made-up `COPILOT_GITHUB_TOKEN` does not do
  it while `gh` is on `PATH`: Copilot falls back to `gh`'s login and answers.

## Needs your input

Nothing.

## Reference

The prompt is `copilot -p "Reply with the single word OK." --no-ask-user`, with
`--model <model>` where the model is known.

| Environment | Exit | Took | What it printed |
|---|---|---|---|
| `PATH` as the user has it | 0 | 13 s | `OK` on stdout; `AI Credits 0.35` on stderr |
| `COPILOT_GITHUB_TOKEN=github_pat_<made up>`, `gh` on `PATH` | 0 | 13 s | `OK`; `AI Credits 0.35` |
| `PATH=/usr/bin:/bin`, `GH_TOKEN=`, `GITHUB_TOKEN=`, `COPILOT_GITHUB_TOKEN=` | 1 | 1 s | the first block below, on stderr |
| The same, with `COPILOT_GITHUB_TOKEN=github_pat_<made up>` | 1 | 8 s | the second block below, on stderr |

Each ran under an empty `COPILOT_HOME` and `COPILOT_ALLOW_ALL=`, in an empty
directory.

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

Copilot reads `gh`'s login by running `gh auth token`, so a run whose `PATH`
has no `gh` cannot use it. Copilot's runtime library names `gh auth token` and
an `AuthInfo::GhCli` login source. `gh` keeps the token in the login keychain
under the service `gh:github.com`. A login of Copilot's own, from
`copilot login`, is not hidden by leaving `gh` off `PATH`, and reaches a round
through the two fields
`copilot-finds-its-own-login-through-the-two-login-fields-of-config-json.md`
records.

## Limits

- **The signed-out runs were on a machine signed in to Copilot only through
  `gh`.** On a machine with a login of Copilot's own, leaving `gh` off `PATH`
  does not reach the signed-out state, and no other way was run.
- That no request was made in the signed-out runs is read from the missing
  usage lines and the one-second exit, not from the account's credit history.
- That no `copilot` command reports a sign-in offline was concluded on 1.0.93,
  and the commands searched were not recorded.
- A Copilot that words the signed-out line differently is not recognised.
