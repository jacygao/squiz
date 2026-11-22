---
settles: "§ 5 — where a Copilot reviewer's login comes from, and what of the user's `config.json` the round's `COPILOT_HOME` holds; § 7 — the home `squiz doctor`'s sign-in check runs in"
issue: [695, 850]
recorded: 2026-11-22
versions: { copilot: 1.0.109 }
recheck-when: Copilot CLI changes where it keeps a `copilot login` login, or renames `loggedInUsers` or `lastLoggedInUser`
---

# Copilot finds its own login through the two login fields of `config.json`

## Intent

- Whether a login from `copilot login` or `/login` reaches a reviewer that runs
  under the round's own `COPILOT_HOME`.
- What that home must hold for it to.

## Decisions

- **Copy `loggedInUsers` and `lastLoggedInUser` from the user's
  `<COPILOT_HOME>/config.json` into the round's, and no other field.** The
  token itself is in the system's credential store, and Copilot finds it
  through those two fields. A round's home with no `config.json` found no login:
  every round and `squiz doctor`'s sign-in check failed with
  `Error: No authentication information found.`. With the two fields copied,
  `squiz doctor` printed `Signed in` against a real `copilot login` login on
  Copilot 1.0.109.
- **Leave `authTokens`, `trustedFolders` and every other field out.** The round
  needs the login and nothing else of the user's configuration.

## Needs your input

Nothing.

## Reference

The places Copilot signs in from, in the order the specification gives:

1. `COPILOT_GITHUB_TOKEN`.
2. A login of its own, from `copilot login` or `/login`: the two fields above,
   with the token in the credential store.
3. `gh`'s login, which Copilot reads by running `gh auth token`, as
   `copilot-signs-in-through-gh-auth-token-and-without-gh-on-path-has-no-login.md`
   records.

The round's `config.json` is written with mode `0600`. A user `config.json` that
cannot be read, or does not hold a JSON object, fails `confine`. With no
`config.json`, or one naming no login, nothing is written.

## Limits

- **One machine, one `copilot login` login, Copilot 1.0.109.** The evidence is one
  `squiz doctor` run with the two fields copied and one without, not a trace of
  what Copilot read.
- **The order of the three places is the specification's statement**, on
  `origin/spec-requirements-list` at `1681b1f`. Only the `gh` fallback behind a
  made-up `COPILOT_GITHUB_TOKEN` has been observed.
- **The credential store's entry for the token** was not read.
- Linux and Windows were not run.
