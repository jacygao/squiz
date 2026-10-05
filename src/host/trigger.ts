/**
 * The one trigger `squiz review` and the hooks both call: read the pull
 * request's state, decide from its record, queue it, and start a round host.
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
 * Nothing is written before the gate passes, so a trigger on a branch with no
 * pull request leaves no `.squiz` behind. This neither waits for the round nor
 * recovers one: it returns what it did, and the caller prints or waits.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { latestActivity } from "../findings/activity.ts";
import { findPullRequestForBranch, type PullRequest } from "../github/pull-request.ts";
import { listReviewThreads, type ReviewThread } from "../github/threads.ts";
import { currentBranch } from "../hook/branch.ts";
import { readState } from "../loop/episode-state.ts";
import { episodeAt, type Episode } from "../loop/episode.ts";
import { putRecord, recordFor, type Owner, type StateKey, type StateRecord } from "../loop/state-record.ts";
import { updateState } from "../loop/state-update.ts";
import { decideTrigger, type TriggerDecision, type TriggerKind } from "../loop/trigger-decision.ts";
import type { Deadline } from "../reviewers/deadline.ts";
import { startDetached, type Detached } from "../sessions/detach.ts";
import { isHerdrWorkspace } from "../sessions/herdr.ts";
import { lockHolder } from "../sessions/lock-file.ts";
import { stillRunning, type Presence, type ProcessIdentity } from "../sessions/process.ts";
import { worktreeToplevel } from "../worktree/toplevel.ts";

const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));

// A state already queued has nobody to take it unless the host starts, so a
// deadline spent by then still leaves time to start one and read its identity.
const START_FLOOR_MS = 2_000;

export type HostCommand = { readonly command: string; readonly args: readonly string[] };

export type TriggerRequest = {
  /** Where the trigger ran. The worktree and its branch are resolved from it. */
  readonly directory: string;
  readonly trigger: TriggerKind;
  /** The number `squiz review` was given. A hook gives none, and reviews the branch's pull request. */
  readonly pullRequest?: number;
  /** The session that owns the work, where the caller knows it. */
  readonly owner?: Owner;
  /** Read for `HERDR_WORKSPACE_ID`. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly until: Deadline;
  /** Whether a host is still running, asked within `boundMs`. `stillRunning` where not given. */
  readonly presence?: (identity: ProcessIdentity, boundMs: number) => Presence;
  /** What runs as the round host. `squiz host <number>` where not given. */
  readonly host?: (pullRequest: number) => HostCommand;
};

export type HostStart = { readonly outcome: "not started" } | Detached;

export type Triggered =
  /** The gate stopped it: no open pull request, another branch, or a detached HEAD. Nothing was written. */
  | { readonly outcome: "no review"; readonly reason: string }
  /** What the decision needs could not be read, or the queue could not be written. Nothing was queued. */
  | { readonly outcome: "failed"; readonly reason: string }
  | {
      readonly outcome: "decided";
      readonly pullRequest: PullRequest;
      readonly episode: Episode;
      readonly state: StateKey;
      /** Every thread on the pull request as it stands now. */
      readonly threads: readonly ReviewThread[];
      /** A `recover` decision is returned as it is, with nothing recovered. */
      readonly decision: TriggerDecision;
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

  const gate = gatePullRequest(request);
  if (gate.outcome !== "found") return gate;
  const pullRequest = gate.pullRequest;
  const call = { directory, until };

  const listed = listReviewThreads(pullRequest.nodeId, call);
  if (listed.outcome !== "listed") {
    return failed(`the threads on PR #${pullRequest.number} could not all be listed: ${listed.reason}`);
  }
  const state: StateKey = { head: pullRequest.headSha, activity: latestActivity(listed.threads) };

  const episode = episodeAt(toplevel.path, pullRequest.number);
  const read = readState(episode);
  if (read.outcome === "unreadable") return failed(read.reason);
  const found = read.outcome === "read" ? read.state : undefined;
  const record = recordFor(found?.records ?? [], state);

  const decision = decideTrigger({
    closed: found?.closeReported === true,
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
        if (current.closeReported === true || now?.status !== record?.status) return current;
        queued = true;
        return { ...current, records: putRecord(current.records ?? [], fresh) };
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
  const host = needsHost ? startHost(request, episode, pullRequest.number) : ({ outcome: "not started" } as const);
  return { outcome: "decided", pullRequest, episode, state, threads: listed.threads, decision, queued, host };
}

type Gate = { readonly outcome: "found"; readonly pullRequest: PullRequest } | Failed | NoReview;

/** The open pull request whose head is the branch checked out, and the one asked for where a number was given. */
function gatePullRequest(request: TriggerRequest): Gate {
  const { directory, until } = request;
  const where = JSON.stringify(directory);
  const branch = currentBranch(directory, until);
  if (branch.outcome === "failed") return failed(`the current branch could not be resolved: ${branch.reason}`);
  if (branch.outcome === "detached") {
    return noReview(`HEAD is detached in ${where}, so no pull request has it as its head`);
  }

  const named = JSON.stringify(branch.name);
  const found = findPullRequestForBranch(branch.name, { directory, until });
  if (found.outcome === "failed") return failed(`the pull request for ${named} could not be looked up: ${found.reason}`);
  if (found.outcome === "none") return noReview(`no open pull request has ${named} as its head, in ${where}`);
  if (request.pullRequest !== undefined && found.number !== request.pullRequest) {
    return noReview(
      `PR #${request.pullRequest} is not the open pull request whose head is ${named}, which ${where} has checked out: that is PR #${found.number}`,
    );
  }
  const { outcome: _, ...pullRequest } = found;
  return { outcome: "found", pullRequest };
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

function startHost(request: TriggerRequest, episode: Episode, number: number): Detached {
  const { command, args } = request.host?.(number) ?? { command: process.execPath, args: [cli, "host", String(number)] };
  try {
    mkdirSync(episode.directory, { recursive: true });
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
