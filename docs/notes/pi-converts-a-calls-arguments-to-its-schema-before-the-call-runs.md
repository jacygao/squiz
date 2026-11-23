---
settles: "§ 5: what a reporting call under `pi` receives, and what the extension records and answers"
issue: [11, 165]
recorded: 2026-09-25
versions: { pi: "0.84.2, 0.85.1", node: 24.15.0 }
recheck-when: pi upgrades, or pi changes how it validates a call or what a call's execute receives
---

# `pi` converts a call's arguments to its schema before the call runs

## Intent

- Whether a call the provider validates can omit a required field or carry the
  wrong shape.
- Whether what the model sent and what the call received are the same value,
  and which one the report is.
- What a call answers with, and how it refuses.

## Decisions

- **Record the value the call received, not the arguments the model sent.** `pi`
  converts an argument to the type the schema declares before the call runs, so
  a `line` of `"128"` reaches the call as `128` and is accepted. The arguments in
  `tool_execution_start` are what the model sent, and reading them drops a
  finding the reviewer was told had landed. The extension appends what `execute`
  accepted to the round's report file.
- **Answer with a short line and carry the report in `details`.** `pi` sends
  `content` to the model and keeps `details` out of the request, so the report
  is not paid for a second time in the reviewer's context.
- **Refuse a report by throwing from `execute`.** The message becomes the call's
  answer, `tool_execution_end` carries `"isError": true`, and the model reads it.
  A tool cannot mark its own answer as an error by returning a flag.

## Needs your input

Nothing.

## Reference

What validation does, measured against the shipped schema:

| Arguments | |
|---|---|
| A missing required property | Refused, naming the property |
| A value outside an `enum` | Refused |
| An array property given as a string | Refused |
| A number property given as a string of digits | **Accepted**, converted to the number before `execute` |
| A property the schema does not declare | **Accepted**, and passed through |

## Limits

- **No model was run.** The results come from `pi` started with an extension
  that writes what it was given, and from calling `pi`'s argument validator
  directly. How often a reviewer gets a finding's shape wrong is not known.
- **The argument conversion is a `pi` internal,** not part of its documented
  interface.
