/**
 * The record the state file keeps for one state of a pull request: its head
 * commit and the latest activity on the reviewer's threads, and where its review
 * has got to.
 *
 * A record that will not read never reads as no record. No record is a state a
 * trigger queues, so a record dropped on reading is a review run twice, or a
 * queued state no round host ever takes, with nothing saying so.
 *
 * Nothing here touches the filesystem or decides anything from a record.
 */

import type { ProcessIdentity } from "../sessions/process.ts";

/**
 * One state of a pull request.
 *
 * `activity` is the node id of the newest reply on the reviewer's threads, or
 * `null` where there is none. It is written even when `null`, so a file that
 * lost the field does not read as the state with no activity.
 */
export type StateKey = {
  readonly head: string;
  readonly activity: string | null;
};

/** The session that owns the work under review, as the trigger that queued it knew it. */
export type Owner = {
  readonly sessionId: string;
  /** Present only where a subagent did the work. */
  readonly subagent?: string;
  /** Present only where the hook found one. */
  readonly messagingSocket?: string;
};

export type Backend = "herdr" | "tmux" | "detached";

/** The reviewer's session, as the round host started it. */
export type ReviewerSession = {
  readonly backend: Backend;
  /** The Herdr pane or tmux window. A detached reviewer has none. */
  readonly pane?: string;
  readonly process: ProcessIdentity;
  /** When the reviewer's time bound runs out, in whole seconds since the epoch. */
  readonly boundEndsAt: number;
  /** The path of the snapshot the reviewer reads. */
  readonly snapshot: string;
};

/** A `squiz review` exit status a round can end on. */
export type ReviewedExit = 0 | 2 | 3;

type Shared = StateKey & {
  /** Absent where no trigger knew it, as for every state `squiz review` queued. */
  readonly owner?: Owner;
};

export type StateRecord = Shared &
  (
    | { readonly status: "queued" }
    | {
        readonly status: "reviewing";
        readonly host: ProcessIdentity;
        /** Absent until the reviewer's session has started. */
        readonly reviewer?: ReviewerSession;
      }
    | {
        readonly status: "reviewed";
        readonly result: "exited";
        readonly exitStatus: ReviewedExit;
        /** The node ids of the reviewer's threads the round left open. */
        readonly openThreads: readonly string[];
      }
    | {
        // Nothing was left open, and a later state was queued behind this one,
        // so the round reached no close and has no exit status.
        readonly status: "reviewed";
        readonly result: "clean, episode open";
      }
    | {
        readonly status: "failed";
        readonly reason: string;
        readonly ownerNoted: boolean;
      }
    | {
        readonly status: "not reviewed";
        readonly reason: string;
      }
  );

export type ReadRecord = { readonly record: StateRecord } | { readonly problem: string };

/**
 * Whether two keys name the same state: the same head commit and the same latest
 * activity, where no activity matches only no activity.
 */
export function sameState(one: StateKey, other: StateKey): boolean {
  return one.head === other.head && one.activity === other.activity;
}

export function recordFor(records: readonly StateRecord[], key: StateKey): StateRecord | undefined {
  return records.find((record) => sameState(record, key));
}

/**
 * The records with `record` in place of the one for its state, or on the end
 * where its state has none. Order is kept, so the records stay oldest first.
 */
export function putRecord(records: readonly StateRecord[], record: StateRecord): StateRecord[] {
  const at = records.findIndex((held) => sameState(held, record));
  if (at < 0) return [...records, record];
  return records.map((held, index) => (index === at ? record : held));
}

/**
 * One entry of the file's records, or what is wrong with it.
 *
 * A field this reader has no name for is ignored, so a file a later version
 * wrote still reads. A field it does name that cannot be read is a problem.
 */
export function recordFrom(entry: unknown): ReadRecord {
  if (!isObject(entry)) return { problem: `is ${render(entry)} rather than a JSON object` };

  const head = entry["head"];
  if (!isText(head)) return { problem: `has "head" as ${render(head)}` };
  const activity = entry["activity"];
  if (activity !== null && !isText(activity)) {
    return { problem: `has "activity" as ${render(activity)} rather than null or an identifier` };
  }

  const owner = ownerFrom(entry["owner"]);
  if ("problem" in owner) return owner;
  const shared: Shared = { head, activity, ...(owner.owner === undefined ? {} : { owner: owner.owner }) };

  const status = entry["status"];
  switch (status) {
    case "queued":
      return { record: { ...shared, status } };
    case "reviewing":
      return reviewingFrom(entry, shared);
    case "reviewed":
      return reviewedFrom(entry, shared);
    case "failed": {
      const reason = entry["reason"];
      if (!isText(reason)) return { problem: `has "reason" as ${render(reason)}` };
      const noted = entry["ownerNoted"];
      if (typeof noted !== "boolean") return { problem: `has "ownerNoted" as ${render(noted)}` };
      return { record: { ...shared, status, reason, ownerNoted: noted } };
    }
    case "not reviewed": {
      const reason = entry["reason"];
      if (!isText(reason)) return { problem: `has "reason" as ${render(reason)}` };
      return { record: { ...shared, status, reason } };
    }
    default:
      return { problem: `has "status" as ${render(status)}, which is none of the five a record can be in` };
  }
}

type ReadOwner = { readonly owner: Owner | undefined } | { readonly problem: string };

function ownerFrom(found: unknown): ReadOwner {
  if (found === undefined) return { owner: undefined };
  if (!isObject(found)) return { problem: `has "owner" as ${render(found)}` };
  const sessionId = found["sessionId"];
  if (!isText(sessionId)) return { problem: `has "owner.sessionId" as ${render(sessionId)}` };
  const subagent = found["subagent"];
  if (subagent !== undefined && !isText(subagent)) {
    return { problem: `has "owner.subagent" as ${render(subagent)}` };
  }
  const socket = found["messagingSocket"];
  if (socket !== undefined && !isText(socket)) {
    return { problem: `has "owner.messagingSocket" as ${render(socket)}` };
  }
  return {
    owner: {
      sessionId,
      ...(subagent === undefined ? {} : { subagent }),
      ...(socket === undefined ? {} : { messagingSocket: socket }),
    },
  };
}

function reviewingFrom(entry: Record<string, unknown>, shared: Shared): ReadRecord {
  const host = identityFrom(entry["host"]);
  if (host === undefined) return { problem: `has "host" as ${render(entry["host"])}` };

  const found = entry["reviewer"];
  if (found === undefined) return { record: { ...shared, status: "reviewing", host } };
  if (!isObject(found)) return { problem: `has "reviewer" as ${render(found)}` };

  const backend = found["backend"];
  if (backend !== "herdr" && backend !== "tmux" && backend !== "detached") {
    return { problem: `has "reviewer.backend" as ${render(backend)}` };
  }
  const pane = found["pane"];
  // Recovery closes the pane by this name, so a pane-backed reviewer without one
  // could not be confirmed gone, and a detached one naming one is a wrong record.
  if (backend === "detached" ? pane !== undefined : !isText(pane)) {
    return { problem: `has "reviewer.pane" as ${render(pane)} for a ${backend} reviewer` };
  }
  const started = identityFrom(found["process"]);
  if (started === undefined) return { problem: `has "reviewer.process" as ${render(found["process"])}` };
  const boundEndsAt = found["boundEndsAt"];
  if (!isWholeSeconds(boundEndsAt)) return { problem: `has "reviewer.boundEndsAt" as ${render(boundEndsAt)}` };
  const snapshot = found["snapshot"];
  if (!isText(snapshot)) return { problem: `has "reviewer.snapshot" as ${render(snapshot)}` };

  const reviewer: ReviewerSession = {
    backend,
    ...(typeof pane === "string" ? { pane } : {}),
    process: started,
    boundEndsAt,
    snapshot,
  };
  return { record: { ...shared, status: "reviewing", host, reviewer } };
}

function reviewedFrom(entry: Record<string, unknown>, shared: Shared): ReadRecord {
  const result = entry["result"];
  const exitStatus = entry["exitStatus"];
  if (result === "clean, episode open") {
    if (exitStatus !== undefined) {
      return { problem: `is reviewed clean with the episode open, which has no exit status, and has "exitStatus" as ${render(exitStatus)}` };
    }
    return { record: { ...shared, status: "reviewed", result } };
  }
  if (result !== "exited") return { problem: `has "result" as ${render(result)}` };

  if (exitStatus !== 0 && exitStatus !== 2 && exitStatus !== 3) {
    return { problem: `has "exitStatus" as ${render(exitStatus)} rather than 0, 2 or 3` };
  }
  const openThreads = entry["openThreads"];
  if (!Array.isArray(openThreads) || !openThreads.every(isText)) {
    return { problem: `has "openThreads" as ${render(openThreads)} rather than an array of thread ids` };
  }
  return { record: { ...shared, status: "reviewed", result, exitStatus, openThreads } };
}

function identityFrom(found: unknown): ProcessIdentity | undefined {
  if (!isObject(found)) return undefined;
  const pid = found["pid"];
  const startedAt = found["startedAt"];
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1) return undefined;
  if (!isWholeSeconds(startedAt)) return undefined;
  return { pid, startedAt };
}

function isWholeSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Shows the value as it was written, so a string is quoted and a number is not. */
function render(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}
