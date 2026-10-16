# Review Harness Specification: A Local Review Loop That Lives on the Pull Request

**Version:** 1.30 (draft)
**Status:** For review
**Owner:** TBD

---

## 1. Purpose

**Squiz is a local harness that automates code review between a coding agent and
a reviewing agent backed by different models, in a GitHub pull request.**

Agents write code faster than any person can read it, which breaks review in
two directions at once:

1. **It does not scale.** A person who reviews every change an agent produces is
   the constraint on the whole workflow.
2. **It becomes a rubber stamp.** A person who cannot keep up approves what they
   have skimmed, which is the same failure arriving quietly.

A reviewing agent reads the change and leaves its findings on the pull request,
and the two agents work through them there. A person opens a pull request that
has already been reviewed.

## Contents

Each section is a file of its own. Read the files a change touches, and follow
their links into the others.

| § | File | What it sets out |
|---|---|---|
| 1 | This file | Why squiz exists. |
| 2 | [dependencies.md](dependencies.md) | What must be installed, the GitHub access the harness uses, and the markers that identify its comments. |
| 3 | [loop.md](loop.md) | How a round starts, runs and ends: the state file, the round cap, the round host, the hooks, and the report that wakes the session. |
| 4 | [reviewer.md](reviewer.md) | The reviewer session: what it is handed, its snapshot, its tools and confinement, its charter, and how its findings become threads. |
| 4 | [adapters.md](adapters.md) | How each reviewer CLI is driven: the `pi` adapter and the Copilot adapter. Read it only for a change to one of them. |
| 5 | [summary.md](summary.md) | The comment posted when an episode closes, and its format. |
| 6 | [commands.md](commands.md) | Every `squiz` subcommand, what it prints, and its exit status. `squiz doctor`'s setup check is here. |
| 7 | [failure-modes.md](failure-modes.md) | Every failure and where it is reported: the failure comment, the command's stderr, and the review budget. |
| 8 | [project.md](project.md) | The language rules, the `src/` layout, and what ships. |
| 9 | [adoption.md](adoption.md) | Installing, getting started, and the configuration file. |
