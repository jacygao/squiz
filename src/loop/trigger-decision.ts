/**
 * What a trigger does with the pull request's state, decided from the episode
 * and the record the state file holds for that state.
 *
 * Two outcomes here fail silently when wrong. A state queued with no host to
 * take it is never reviewed, and nothing says so. A failed state queued again by
 * a hook comes back on every turn the coding agent spends reading its failure
 * note, and that is a loop.
 *
 * This decides and performs nothing. It neither recovers a round nor starts a
 * host, and leaves waiting, printing and exit codes to the caller.
 */

import type { Presence } from "../sessions/process.ts";
import type { StateRecord } from "./state-record.ts";

/** A Claude Code hook, which returns at once, or a run of `squiz review`, which waits. */
export type TriggerKind = "hook" | "review";

export type TriggerSituation = {
  /** Whether the episode has reported its close. */
  readonly closed: boolean;
  /** The record for the pull request's state as it stands now, or none. */
  readonly record: StateRecord | undefined;
  /**
   * The round host the state depends on: the one a reviewing record names, and
   * otherwise the one holding the episode's lock. With no lock, it is gone.
   */
  readonly host: Presence;
  readonly trigger: TriggerKind;
};

export type TriggerDecision =
  /** The episode is over. Nothing is queued, and `squiz review` prints the close. */
  | { readonly outcome: "closed" }
  | { readonly outcome: "queue"; readonly startHost: boolean }
  /** The state is queued already, and no live host will take it. */
  | { readonly outcome: "start-host" }
  /** A live host has the state queued or under review. Nothing is queued. */
  | { readonly outcome: "in-hand" }
  /** A hook found the state failed. Only `squiz review` retries it. */
  | { readonly outcome: "left-failed" }
  /**
   * The round's host has gone. Recover it, which records it failed, then do
   * `afterwards`. A recovery that cannot confirm the reviewer gone does neither.
   */
  | { readonly outcome: "recover"; readonly afterwards: TriggerDecision }
  /**
   * The state is under review by a host nobody can say is running or gone.
   * Nothing is recovered, queued or started, and the next trigger asks again.
   */
  | { readonly outcome: "host-unknown"; readonly reason: string }
  /** The state has a result, which `squiz review` returns. Nothing is queued. */
  | { readonly outcome: "result" };

/**
 * Decide what the trigger does.
 *
 * The close is read before the record, because an episode that is over stays
 * over whatever its records say, and queues nothing even for a state it never
 * saw.
 */
export function decideTrigger(situation: TriggerSituation): TriggerDecision {
  if (situation.closed) return { outcome: "closed" };

  const { record, host, trigger } = situation;
  // A host that cannot be told running is started all the same. One already
  // running holds the lock and the new one exits at once, while one not started
  // leaves the state with nobody to take it.
  const startHost = host.outcome !== "running";

  if (record === undefined) return { outcome: "queue", startHost };

  switch (record.status) {
    case "queued":
      return startHost ? { outcome: "start-host" } : { outcome: "in-hand" };
    case "reviewing":
      if (host.outcome === "running") return { outcome: "in-hand" };
      // Recovery stops the reviewer and removes its snapshot, so it runs only on
      // a host known to have gone. Queuing again would review the state twice.
      if (host.outcome === "unknown") return { outcome: "host-unknown", reason: host.reason };
      return { outcome: "recover", afterwards: afterFailure(trigger, true) };
    case "failed":
      return afterFailure(trigger, startHost);
    case "reviewed":
    case "not reviewed":
      return { outcome: "result" };
  }
}

/** Running `squiz review` is the request to retry a failed state. A hook is not. */
function afterFailure(trigger: TriggerKind, startHost: boolean): TriggerDecision {
  return trigger === "review" ? { outcome: "queue", startHost } : { outcome: "left-failed" };
}
