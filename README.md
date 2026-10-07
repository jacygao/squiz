# Squiz

Squiz has a second agent review your coding agent's work, on the pull request.
When the coding agent stops, a reviewer running a different model reads the
change and posts its findings as review threads. The coding agent is woken with
the result, fixes or answers each thread, and the reviewer looks again. By the
time you read the pull request, it has already been reviewed.

Squiz is a plugin for Claude Code and for the GitHub Copilot CLI. Its Copilot
support is experimental, because waking a Copilot session needs Copilot's
experimental features.

## What you need

- `git`, and a repository with a GitHub remote.
- `gh`, signed in (`gh auth login`).
- Node 24 or later.
- Claude Code or the Copilot CLI, to run the coding agent.
- A reviewer: [`pi`](https://github.com/earendil-works/pi#readme), the default,
  or the Copilot CLI. It must run a different model from your coding agent.
- Optionally tmux or Herdr. Under either, each review runs in a pane you can
  watch. Without them, it runs in the background and writes a log.

## Install into Claude Code

From a shell:

```sh
claude plugin marketplace add jacygao/squiz
claude plugin install squiz@squiz
```

Or, inside a Claude Code session, `/plugin marketplace add jacygao/squiz` and
then `/plugin install squiz@squiz`.

Claude Code puts `squiz` on the `PATH` of its own shell, which its Bash tool
and the commands you type after `!` both use. Your terminal outside Claude Code
does not have it. To run `squiz` there as well, type this once in a Claude Code
session:

```
! squiz init
```

It links `~/.local/bin/squiz`, or `~/bin/squiz`, to the squiz Claude Code runs.

After updating squiz in Claude Code, start a new session and type
`! squiz init` again. Each version has a directory of its own, and the link
still runs the old one until you do. Claude Code deletes the old directory
the first time it starts 14 days or more after the update, and from then on
`squiz` outside Claude Code is `command not found`. `! squiz doctor` warns
about the link until it is moved.

## Install into Copilot

```sh
copilot plugin marketplace add jacygao/squiz
copilot plugin install squiz@squiz
```

Copilot does not put `squiz` on its shell's `PATH`, so link it once on each
machine. Where Claude Code also has squiz, type `! squiz init` in a Claude Code
session, as above, so both run the same squiz. Where only Copilot has it, run it
from Copilot's copy:

```sh
~/.copilot/installed-plugins/squiz/squiz/bin/squiz init
```

Use your own `COPILOT_HOME` in place of `~/.copilot` if you set one.

Then turn on Copilot's experimental features, once. Without them a Copilot
session is never woken when its review ends. Start Copilot once with:

```sh
copilot --experimental
```

or type `/experimental on` in a session. Every later session starts with them
on.

## Set up a project

In the repository you want reviewed:

1. Keep squiz's working files out of git:

   ```sh
   echo '.squiz/' >> .gitignore
   ```

2. In Claude Code, allow `squiz` so the coding agent is not asked each time it
   starts a review or answers a thread. In `.claude/settings.json`:

   ```json
   {
     "permissions": {
       "allow": ["Bash(squiz *)"]
     }
   }
   ```

   In Copilot, start the session with `squiz` allowed:

   ```sh
   copilot --allow-tool='shell(squiz:*)'
   ```

   Without it, Copilot asks before it runs `squiz`, and a session run with
   `-p --no-ask-user` is refused it.

3. Optionally, add a `.squiz.json` at the root. Every setting has a default,
   so a project without one still runs. This one reviews with Copilot on a
   chosen model:

   ```json
   {
     "reviewer": "copilot",
     "model": "gpt-5-mini"
   }
   ```

   The settings are `reviewer`, `model`, `rounds`, `timeout`, `tokens` and
   `thinking`. The specification gives each one's range and default.

   Where Copilot writes your code and reviews it too, set `model` to one your
   coding sessions do not use. Without it the reviewer runs on Copilot's
   default, which is also the model a session started without `--model` runs
   on. Nothing checks that the two differ.

   Where Claude Code writes your code and Copilot reviews it, compare the
   model on `squiz doctor`'s `Reviewer` line with the one Claude Code runs.
   Copilot's default has been a Claude model as well as a GPT one, so set
   `model` where the two are the same.

Nothing goes in `AGENTS.md`, and the coding agent needs no instruction. A review
starts each time it finishes its work on a branch with an open pull request.

## Check the setup

Run `squiz doctor`. In Claude Code, type it after `!`:

```
! squiz doctor
```

Elsewhere, run `squiz doctor` in a shell once `squiz init` has linked it. Run
it in the repository you want reviewed, because the last line reads that
repository's `.squiz.json`. It prints a line per dependency and exits 1 where a
required one is missing, unusable or signed out. In a project whose
`.squiz.json` names Copilot, it printed:

```
git 2.54.0
gh 2.97.0, signed in as jacygao
Claude Code 2.1.292
Node 24.15.0
tmux 3.7b
Herdr 0.9.3
squiz link: none on PATH. Not required in Claude Code, whose own shell runs squiz; for another coding agent, run squiz init
Reviewer copilot 1.0.93, model gpt-6-astra, Copilot's default. Signed in; the check spent one request on gpt-5-mini
```

The last line names the reviewer, its version and the model it will run on. It
fails where that reviewer is not installed or `.squiz.json` is refused. For
Copilot it sends one prompt to `gpt-5-mini`, which costs about 0.35 AI credits
and 13 seconds, and fails where Copilot is not signed in:

```
Reviewer copilot 1.0.93, model gpt-6-astra, Copilot's default. Its sign-in check failed: copilot exited 1: Error: No authentication information found.
```

Where no model is named by
`.squiz.json`, by `COPILOT_MODEL` or by Copilot's own settings, the line says
the model is unknown, and still passes:

```
Reviewer copilot 1.0.93, model unknown: neither .squiz.json nor Copilot's settings name one. Signed in; the check spent one request on gpt-5-mini
```

Where the Copilot CLI is installed, a line after Claude Code's gives its
version and says whether its experimental features are on:

```
copilot 1.0.92, experimental features on
```

Off is a warning, which leaves the exit status alone:

```
warning: copilot 1.0.92 has experimental features off. If Copilot writes your code, it is never woken when a review finishes. Run /experimental on in Copilot, or start it once with copilot --experimental
```

Either Claude Code or Copilot can be the coding agent, so Claude Code missing
fails the check only where Copilot is missing too.

## What you see

Each finding is a review thread on the line it is about, or on the whole file
where no one line is. The coding agent answers in the thread, and a later round
resolves it. A finding about the change as a whole goes into the summary comment
instead. A thread from this
repository's own pull request #672, trimmed:

> **Squiz reviewer · low — A link to a newer version of the same install is reported as "an earlier version of this install"**
>
> - `pathLink` takes the `earlier` classification at face value and prints `... an earlier version of this install ...`, but the classification behind it does not check version order.
> - So running `squiz doctor` from an older checkout while a link points at a newer version of the same install prints that the newer version is an earlier one.
>
> **Suggested fix:** Either compare the linked version to the running version before using the word "earlier", or word the line as "another version of this install" so it is true for both older and newer links.

> **Squiz coding agent**
>
> Agreed. squizzesOnPath does not order versions, so the doctor line now says "another version of this install", in the code, its test and the § 6 table.

When the review ends, squiz posts one summary comment on the pull request. Here
is one from a scratch project that Copilot reviewed. A Copilot review is
counted in AI credits, and one by `pi` in dollars:

> **Squiz review — 2 rounds, 1 finding**
>
> Fixed 1 · Withdrawn 0 · Open 0 · Disputed 0
> 115,302 tokens over 2 rounds: 61,172, 54,130 · 35.86 AI credits
> Reviewed by `copilot` on `gpt-6-astra`
>
> **Needs a person**
>
> Nothing needs a person.
>
> **Rounds**
>
> - Round 1 at 4c25208: raised 1 finding
> - Round 2 at 01a2f0f: raised nothing, and ruled 1 fixed

Every thread still open or disputed when the review ends is listed under "Needs a person". Those are the ones for you.

`squiz status` lists the reviews running and finished in every worktree of the
repository.

## The design

[`docs/specs/review-harness-spec.md`](docs/specs/review-harness-spec.md) is
where the design is: how a review starts and ends, what the reviewer may do,
every setting, and what each command prints. Where this README and the
specification disagree, the specification is right.
