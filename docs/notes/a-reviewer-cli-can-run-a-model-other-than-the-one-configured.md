---
settles: "§ 5: how each adapter hands its CLI the configured model, and how `pi`'s is checked before a round; § 6: which model the summary's reviewer line names"
recorded: 2026-11-22
versions: { squiz: 645dacd }
recheck-when: pi changes how --model matches a name, or Copilot changes what it does with a model it does not offer
---

# A reviewer CLI can run a model other than the one configured

## Intent

- Whether a configured model can be handed to each CLI and trusted to be the
  one that runs.
- Which model a round's summary should name.

## Decisions

- **Configure a `pi` model as `provider/id`, and check it against
  `pi --list-models` before the round.** `pi --model` matches a bare name
  against any model whose name contains it, and sends an id it does not know to
  the provider as it is. `confine` runs
  `pi --no-approve --no-extensions --list-models` in the snapshot and prepares
  the round only where the configured model is listed exactly. A bare id listed
  under one provider is refused, with its full name in the reason. Listing makes
  no model request, and lists only the models whose provider has a credential.
- **Hand Copilot its model on `--model`, never through `COPILOT_MODEL` alone.**
  `--model` refuses a model Copilot does not offer before any request. Set
  through `COPILOT_MODEL` alone to such a model, Copilot runs the round on
  another one and exits 0. The user's default, carried on `COPILOT_MODEL`, goes
  on `--model` too.
- **Name the model the run reported, never the configured one.** A round whose
  run reported no model reads "an unknown model".

## Needs your input

Nothing.

## Limits

- **Read from the code and the specification, not from a run.** The CLI
  versions it was seen on, the names tried, and how often, were not recorded.
- **What `pi` sends for a bare name that matches several models** was not
  recorded.
