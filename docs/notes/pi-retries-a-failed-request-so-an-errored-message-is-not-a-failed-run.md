---
settles: "§ 5: how the `pi` adapter reads an errored message, and why it starts no second run for a run that completed no message"
recorded: 2026-11-22
versions: { squiz: 7c16142 }
recheck-when: pi upgrades, or changes how it retries a failed model request
---

# `pi` retries a failed request itself, so an errored message is not a failed run

## Intent

- Whether an assistant message with a `stopReason` of `error` means the run
  failed.
- Whether the adapter should retry a run whose request failed.

## Decisions

- **Read an errored message as a retry, not as the end of the run.** A round
  that completed a review carried twenty-two errored messages among its working
  ones.
- **Call a run one that completed no message only where no assistant message
  carries `stop` and no finish was recorded.** The round's reason is the errored
  message's `errorMessage`. `pi` exits 0 and writes nothing to stderr either
  way, so the report file is the only place that tells them apart.
- **Start no second run for it.** `pi` has already retried the request.

## Needs your input

Nothing.

## Reference

An errored message carries zero usage, so summing cost over every assistant
message stays correct with the retries in it. One as the extension writes it to
the report file *(unverified: the fixture in `src/reviewers/pi/extension.test.ts`,
not an observed message)*:

```json
{"stopReason":"error","errorMessage":"429 Too Many Requests","content":[],"usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}}
```

## Limits

- **The evidence is the specification at commit `7c16142`.** It records the
  twenty-two errored messages and says `pi` retried the request three times. It
  does not record the `pi` version, the provider, or what failed.
- **How many times `pi` retries, and after what delay, was not measured.**
