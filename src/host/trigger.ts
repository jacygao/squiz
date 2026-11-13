/**
 * The one trigger `squiz review` and the hooks both call: read the change's
 * state from the venue, decide from its record, queue it, and start a round host.
 *
 * Three things here fail silently when wrong:
 *
 * - A threads listing that failed, read as no activity, keys the state wrongly,
 *   and the review on record is taken to cover replies it never saw.
 * - Two triggers for one state that each queued it would have it reviewed
 *   twice. The queue is written under the state lock, and only where the record
 *   is still what the decision was made from.
 * - A host started as the trigger's child dies with it. It is started detached.
 *
 * Nothing is written before the venue finds the change, so a trigger with no
 * change to review, or one the venue holds back, leaves no `.squiz` behind. This
 * neither waits for the round nor recovers one: it returns what it did, and the
 * caller prints or waits.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { latestActivity } from "../findings/activity.ts";
import { episodeOver, readState, type EpisodeState } from "../loop/episode-state.ts";
import { episodeAt, type Episode } from "../loop/episode.ts";
import { makeEpisodeDirectory } from "../loop/state-directory.ts";
import { recordFor, sameState, type Owner, type StateKey, type StateRecord } from "../loop/state-record.ts";
import { updateState } from "../loop/state-update.ts";
import { decideTrigger, type TriggerDecision, type TriggerKind } from "../loop/trigger-decision.ts";
import type { Deadline } from "../reviewers/deadline.ts";
import { startDetached, type Detached } from "../sessions/detach.ts";
import { isHerdrWorkspace } from "../sessions/herdr.ts";
import { lockHolder } from "../sessions/lock-file.ts";
import { stillRunning, type Presence, type ProcessIdentity } from "../sessions/process.ts";
import { venueAt, type Change, type ReviewThread, type Venue } from "../venues/venue.ts";
import { worktreeToplevel } from "../worktree/toplevel.ts";

const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));

// A state already queued has nobody to take it unless the host starts, so a
// deadline spent by then still leaves time to start one and read its identity.
const START_FLOOR_MS = 2_000;

export type HostCommand = { readonly command: string; readonly args: readonly string[] };

export type TriggerRequest = {
  /** Where the work is: the payload's `cwd` for a hook. The worktree and its branch are resolved from it. */
  readonly directory: string;
  readonly trigger: TriggerKind;
  /** The key `squiz review` was given. A hook gives none, and reviews the change the venue finds. */
  readonly key?: string;
  /** The venue the main worktree's `.squiz.json` names where not given. */
  readonly venue?: Venue;
  /** The session that owns the work, where the caller knows it. */
  readonly owner?: Owner;
  /** Read for `HERDR_WORKSPACE_ID`. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly until: Deadline;
  /** Whether a host is still running, asked within `boundMs`. `stillRunning` where not given. */
  readonly presence?: (identity: ProcessIdentity, boundMs: number) => Presence;
  /** What runs as the round host. `squiz host <key>` where not given. */
  readonly host?: (key: string) => HostCommand;
  /**
   * Return a change the worktree pushed past the head the venue reports as
   * `unreported`, rather than decide on that head. `squiz review` asks for it
   * and waits for the venue to catch up. A hook does not, and returns at once.
   */
  readonly holdUnreported?: boolean;
  /** The earlier deadline the venue's lookup of the change runs on, where it has one. `until` where not given. */
  readonly lookUpBy?: Deadline;
};

export type HostStart = { readonly outcome: "not started" } | Detached;

export type Triggered =
  /** The venue has no change to review here. Nothing was written. */
  | { readonly outcome: "no review"; readonly reason: string }
  /**
   * The venue holds the change back, as the GitHub venue holds a draft until it
   * is marked ready. Nothing was written. Not a failure, so a caller says nothing
   * of one where it says nothing of a state it chose not to queue.
   */
  | { readonly outcome: "held"; readonly line: string }
  /** The venue, or what the decision needs, could not be read, or the queue could not be written. Nothing was queued. */
  | { readonly outcome: "failed"; readonly reason: string }
  /** The venue does not yet report the commit the worktree pushed. Nothing was listed or written. */
  | { readonly outcome: "unreported"; readonly change: Change & { readonly unreported: string } }
  | {
      readonly outcome: "decided";
      readonly change: Change;
      readonly episode: Episode;
      readonly state: StateKey;
      /** Every thread on the change as it stands now. */
      readonly threads: readonly ReviewThread[];
      /** A `recover` decision is returned as it is, with nothing recovered. */
      readonly decision: TriggerDecision;
      /**
       * The state file the decision was made from, where there was one. A
       * close is printed from it, because a new head can archive that episode
       * before the caller reads the file again.
       */
      readonly read?: EpisodeState;
      /** False where another trigger queued the state first. */
      readonly queued: boolean;
      /** A host that exited at once found another holding the lock, which is no failure. */
      readonly host: HostStart;
    };

/** Never throws, whatever git, `gh`, `ps` or the filesystem does. */
export function trigger(request: TriggerRequest): Triggered {
  const { directory, until } = request;
  const toplevel = worktreeToplevel(directory, until);
  if (toplevel.outcome === "failed") return failed(`the worktree could not be resolved: ${toplevel.reason}`);

  let venue = request.venue;
  if (venue === undefined) {
    const chosen = venueAt(toplevel.path, until);
    if (chosen.outcome === "failed") return failed(chosen.reason);
    venue = chosen.venue;
  }
  const lookup = venue.readChange(directory, request.key ?? null, request.lookUpBy ?? until);
  switch (lookup.outcome) {
    case "found":
      break;
    case "held":
      return lookup;
    case "none":
      return noReview(lookup.reason);
    case "failed":
      return failed(lookup.reason);
  }
  const { change } = lookup;
  if (request.holdUnreported === true && change.unreported !== undefined) {
    return { outcome: "unreported", change: { ...change, unreported: change.unreported } };
  }

  const listed = venue.listThreads(change, until);
  if (listed.outcome !== "listed") {
    return failed(`the threads on ${change.name} could not all be listed: ${listed.reason}`);
  }
  const state: StateKey = { head: change.head, activity: latestActivity(listed.threads) };

  const named = episodeAt(venue, toplevel.path, change.key);
  if (named.outcome === "failed") return failed(named.reason);
  const { episode } = named;
  const read = readState(episode);
  if (read.outcome === "unreadable") return failed(read.reason);
  const found = read.outcome === "read" ? read.state : undefined;
  const record = recordFor(found?.records ?? [], state);

  const decision = decideTrigger({
    closed: found !== undefined && episodeOver(found, state),
    record,
    host: hostPresence(episode, record, request),
    trigger: request.trigger,
  });

  let queued = false;
  if (decision.outcome === "queue") {
    const workspace = request.environment["HERDR_WORKSPACE_ID"];
    const fresh: StateRecord = {
      ...state,
      ...(request.owner === undefined ? {} : { owner: request.owner }),
      // Any other value would leave the record unreadable to every later trigger.
      ...(workspace !== undefined && isHerdrWorkspace(workspace) ? { herdrWorkspace: workspace } : {}),
      status: "queued",
    };
    const updated = updateState(
      episode,
      (current) => {
        const now = recordFor(current.records ?? [], state);
        // A record or a close written since the read came from another trigger or
        // a host, and the decision no longer applies.
        if (episodeOver(current, state) || now?.status !== record?.status) return current;
        queued = true;
        // A failed state queued again goes on the end, as any state queued now
        // does, because the records' order is the order the rounds take them in.
        // After a clean close this is never one of the closed episode's records,
        // which no trigger queues, so they keep their places.
        const others = (current.records ?? []).filter((held) => !sameState(held, state));
        return { ...current, records: [...others, fresh] };
      },
      { until },
    );
    if (updated.outcome === "failed") return failed(updated.reason);
  }

  // A host seen running before the queue was written can have found its queue
  // empty and exited since, so the lock is read again once the state is there.
  // A host started beside a live one exits at once on the lock.
  const needsHost =
    decision.outcome === "start-host" ||
    (decision.outcome === "queue" && (decision.startHost || hostPresence(episode, undefined, request).outcome !== "running"));
  const host = needsHost ? startHost(request, episode) : ({ outcome: "not started" } as const);
  return { outcome: "decided", change, episode, state, threads: listed.threads, decision, ...(found === undefined ? {} : { read: found }), queued, host };
}

/**
 * The host the state depends on: the one a reviewing record names, and
 * otherwise the one holding the host lock. With no lock, it is gone.
 */
function hostPresence(episode: Episode, record: StateRecord | undefined, request: TriggerRequest): Presence {
  const boundMs = Math.max(1, request.until.remaining());
  const ask = request.presence ?? stillRunning;
  if (record?.status === "reviewing") return ask(record.host, boundMs);
  const holder = lockHolder(episode.directory, "host.lock");
  if (holder.outcome === "absent") return { outcome: "gone" };
  if (holder.outcome === "unknown") return holder;
  return ask(holder.holder, boundMs);
}

function startHost(request: TriggerRequest, episode: Episode): Detached {
  const { command, args } = request.host?.(episode.key) ?? { command: process.execPath, args: [cli, "host", episode.key] };
  try {
    makeEpisodeDirectory(episode);
  } catch (error) {
    return { outcome: "failed", reason: `${episode.directory} could not be made: ${error instanceof Error ? error.message : String(error)}` };
  }
  return startDetached(
    { command, args, cwd: episode.worktree, logPath: join(episode.directory, "host.log") },
    Math.max(START_FLOOR_MS, request.until.remaining()),
  );
}

type Failed = Extract<Triggered, { readonly outcome: "failed" }>;
type NoReview = Extract<Triggered, { readonly outcome: "no review" }>;

function failed(reason: string): Failed {
  return { outcome: "failed", reason };
}

function noReview(reason: string): NoReview {
  return { outcome: "no review", reason };
}
