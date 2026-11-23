---
settles: "§ 2: that no dependency has a minimum version; § 7: what the setup check reports of a version"
issue: 485
recorded: 2026-10-06
versions: { git: 2.50.1, gh: 2.97.0, pi: 0.84.2, copilot: 1.0.91, claude-code: "2.1.261, 2.1.288" }
recheck-when: a behaviour a note records stops holding on a later version, or the setup check starts checking versions
---

# No dependency version is a minimum

## Intent

- Whether any version a behaviour was seen on is a requirement, such as a
  minimum the setup check enforces.
- How to tell whether a behaviour still holds after a dependency is upgraded.

## Decisions

- **Treat no dependency's version as a minimum, except Node's.** § 2 requires
  `git`, `gh` signed in, a runtime and a reviewer, and states no version for
  any of them. `squiz doctor` reports what is missing, unusable or
  unauthenticated, and prints each version without judging it. Node is the
  exception: § 9 requires Node 24 or later, and the setup check fails an older
  one.
- **Re-check a behaviour on the new version before relying on it after an
  upgrade.** The version in a note's `versions` is the one the behaviour was
  seen on, and nothing tests it again on its own. The note's `recheck-when`
  names the upgrade that calls for it.

## Needs your input

Nothing.

## Reference

The setup check's Node row on a Node older than 24, as `src/review/doctor.ts`
writes it (unverified: not seen in output):

```
Node <version>: too old. Squiz needs Node 24 or later
```

## Limits

- **Only the versions recorded were run.** A later version that changes a
  behaviour is not ruled out.
