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

import { isHerdrWorkspace } from "../sessions/herdr.ts";
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

/** Where the reviewer runs or ran. */
export type ReviewerPlace = {
  readonly backend: Backend;
  /** The Herdr pane or tmux window. A detached reviewer has none. */
  readonly pane?: string;
};

/** The reviewer's session, as the round host started it. */
export type ReviewerSession = ReviewerPlace & {
  readonly process: ProcessIdentity;
  /** When the reviewer's time bound runs out, in whole seconds since the epoch. */
  readonly boundEndsAt: number;
  /** The path of the snapshot the reviewer reads. */
  readonly snapshot: string;
};

/** A round that has started. */
export type StartedRound = {
  /** The `k` that names the round's directory, `rounds/<k>/`, and its reviewer's label, `squiz-<number>-r<k>`. */
  readonly number: number;
};

/**
 * The round that reached a finished record, as `squiz status` prints it.
 *
 * A finished record without one was written before records kept it, and
 * nothing is known of which round reached it, when that round ran, or where
 * its reviewer was.
 */
export type FinishedRound = StartedRound & {
  /** In whole seconds since the epoch, as is `endedAt`. */
  readonly startedAt: number;
  readonly endedAt: number;
  /** Absent where the round failed before a reviewer started. */
  readonly reviewer?: ReviewerPlace;
};

/** A reviewed round always had a reviewer. */
export type ReviewedRound = FinishedRound & { readonly reviewer: ReviewerPlace };

/** A `squiz review` exit status a round can end on. */
export type ReviewedExit = 0 | 2 | 3;

/** What closed an episode with threads still open. */
export type ClosingBound = "round cap" | "token bound";

/**
 * What a reviewed round did beside its result, as `squiz review` prints it.
 * Each is absent on a record written before records kept it.
 */
export type RoundReport = {
  /** How many threads the round's findings opened. */
  readonly newFindings?: number;
  /** The move of `HEAD` the round's comparison found, as "from … to …". */
  readonly moved?: string;
  /** What failed without changing the round's outcome, a line each. */
  readonly problems?: readonly string[];
  /** How many of the findings the round posted GitHub refused, of how many it posted. */
  readonly unposted?: { readonly failed: number; readonly of: number };
  /**
   * The findings of a round that left the episode open that no thread holds, as
   * the summary's Notes line for each. A round that closed the episode put them in
   * its summary instead, and carries none.
   */
  readonly unthreaded?: readonly string[];
};

type Shared = StateKey & {
  /** Absent where no trigger knew it, as for every state `squiz review` queued. */
  readonly owner?: Owner;
  /** The Herdr workspace the trigger ran in, where it ran in one. The reviewer's tab opens there. */
  readonly herdrWorkspace?: string;
};

export type StateRecord = Shared &
  (
    | { readonly status: "queued" }
    | {
        readonly status: "reviewing";
        readonly host: ProcessIdentity;
        /**
         * The round under way, kept from the moment it starts. Absent only on a
         * record written before reviewing records kept it.
         */
        readonly round?: StartedRound;
        /** Absent until the reviewer's session has started. */
        readonly reviewer?: ReviewerSession;
      }
    | ({ readonly status: "reviewed"; readonly round?: ReviewedRound } & RoundReport & (
        | {
            readonly result: "exited";
            readonly exitStatus: ReviewedExit;
            /** The node ids of the reviewer's threads the round left open. */
            readonly openThreads: readonly string[];
            /** The bound that closed the episode with threads open, on a round that exited 3. */
            readonly closedAt?: ClosingBound;
          }
        | {
            // Nothing was left open, and a later state was queued behind this one,
            // so the round reached no close and has no exit status.
            readonly result: "clean, episode open";
          }
      ))
    | {
        readonly status: "failed";
        readonly reason: string;
        readonly ownerNoted: boolean;
        readonly round?: FinishedRound;
        /**
         * What `squiz review` prints on stderr after the reason: what else the
         * round established, and where its failure comment went.
         */
        readonly lines?: readonly string[];
      }
    | {
        readonly status: "not reviewed";
        readonly reason: string;
        /** The state that superseded this one, where one did. `reason` names it for a person, and only by its commit. */
        readonly supersededBy?: StateKey;
        /** The close, on the state the round host took and found the episode's bound spent on. */
        readonly closed?: ClosedBeforeReview;
      }
  );

/**
 * The close of an episode whose round cap or token bound was spent before a
 * round took the state, as `squiz review` prints it.
 */
export type ClosedBeforeReview = {
  /** No round remains after it, so it is never 2. */
  readonly exitStatus: 0 | 3;
  /** The node ids of the reviewer's threads open as the close listed them. */
  readonly openThreads: readonly string[];
  readonly closedAt: ClosingBound;
  /** What failed without changing the close, a line each. */
  readonly problems?: readonly string[];
};

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
  const workspace = entry["herdrWorkspace"];
  if (workspace !== undefined && !(typeof workspace === "string" && isHerdrWorkspace(workspace))) {
    return { problem: `has "herdrWorkspace" as ${render(workspace)} rather than a Herdr workspace id` };
  }
  const shared: Shared = {
    head,
    activity,
    ...(owner.owner === undefined ? {} : { owner: owner.owner }),
    ...(workspace === undefined ? {} : { herdrWorkspace: workspace }),
  };

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
      const round = roundFrom(entry["round"]);
      if ("problem" in round) return round;
      const kept = round.round === undefined ? {} : { round: round.round };
      const lines = entry["lines"];
      if (lines !== undefined && !isLines(lines)) return { problem: `has "lines" as ${render(lines)} rather than an array of lines` };
      return { record: { ...shared, status, reason, ownerNoted: noted, ...kept, ...(lines === undefined ? {} : { lines }) } };
    }
    case "not reviewed": {
      const reason = entry["reason"];
      if (!isText(reason)) return { problem: `has "reason" as ${render(reason)}` };
      if (entry["closed"] !== undefined) {
        const closed = closedFrom(entry["closed"]);
        if ("problem" in closed) return closed;
        return { record: { ...shared, status, reason, closed: closed.closed } };
      }
      const by = entry["supersededBy"];
      if (by === undefined) return { record: { ...shared, status, reason } };
      const byHead = isObject(by) ? by["head"] : undefined;
      const byActivity = isObject(by) ? by["activity"] : undefined;
      if (!isText(byHead) || (byActivity !== null && !isText(byActivity))) {
        return { problem: `has "supersededBy" as ${render(by)} rather than a state's head and activity` };
      }
      return { record: { ...shared, status, reason, supersededBy: { head: byHead, activity: byActivity } } };
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

type ReadRound = { readonly round: FinishedRound | undefined } | { readonly problem: string };

function roundFrom(found: unknown): ReadRound {
  const started = startedRoundFrom(found);
  if ("problem" in started) return started;
  // Narrows `found` as well: a round that read is an object.
  if (started.round === undefined || !isObject(found)) return { round: undefined };
  const { number } = started.round;
  const startedAt = found["startedAt"];
  if (!isWholeSeconds(startedAt)) return { problem: `has "round.startedAt" as ${render(startedAt)}` };
  const endedAt = found["endedAt"];
  if (!isWholeSeconds(endedAt)) return { problem: `has "round.endedAt" as ${render(endedAt)}` };
  if (endedAt < startedAt) {
    return { problem: `has a round that ended at ${endedAt}, before it started at ${startedAt}` };
  }
  if (found["reviewer"] === undefined) return { round: { number, startedAt, endedAt } };
  const reviewer = placeFrom(found["reviewer"], "round.reviewer");
  if ("problem" in reviewer) return reviewer;
  return { round: { number, startedAt, endedAt, reviewer: reviewer.place } };
}

type ReadStartedRound = { readonly round: StartedRound | undefined } | { readonly problem: string };

function startedRoundFrom(found: unknown): ReadStartedRound {
  if (found === undefined) return { round: undefined };
  if (!isObject(found)) return { problem: `has "round" as ${render(found)}` };
  const number = found["number"];
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1) {
    return { problem: `has "round.number" as ${render(number)} rather than a whole number from 1` };
  }
  return { round: { number } };
}

type ReadPlace = { readonly place: ReviewerPlace } | { readonly problem: string };

function placeFrom(found: unknown, field: string): ReadPlace {
  if (!isObject(found)) return { problem: `has "${field}" as ${render(found)}` };
  const backend = found["backend"];
  if (backend !== "herdr" && backend !== "tmux" && backend !== "detached") {
    return { problem: `has "${field}.backend" as ${render(backend)}` };
  }
  const pane = found["pane"];
  // Recovery closes a running reviewer's pane by this name, and status prints a
  // finished one's. A pane-backed reviewer without one is missing what it is read
  // for, and a detached one naming one is a wrong record.
  if (backend === "detached" ? pane !== undefined : !isText(pane)) {
    return { problem: `has "${field}.pane" as ${render(pane)} for a ${backend} reviewer` };
  }
  return { place: { backend, ...(typeof pane === "string" ? { pane } : {}) } };
}

function reviewingFrom(entry: Record<string, unknown>, shared: Shared): ReadRecord {
  const host = identityFrom(entry["host"]);
  if (host === undefined) return { problem: `has "host" as ${render(entry["host"])}` };
  const round = startedRoundFrom(entry["round"]);
  if ("problem" in round) return round;
  const under = { ...shared, status: "reviewing" as const, host, ...(round.round === undefined ? {} : { round: round.round }) };

  const found = entry["reviewer"];
  if (found === undefined) return { record: under };
  if (!isObject(found)) return { problem: `has "reviewer" as ${render(found)}` };
  const place = placeFrom(found, "reviewer");
  if ("problem" in place) return place;
  const started = identityFrom(found["process"]);
  if (started === undefined) return { problem: `has "reviewer.process" as ${render(found["process"])}` };
  const boundEndsAt = found["boundEndsAt"];
  if (!isWholeSeconds(boundEndsAt)) return { problem: `has "reviewer.boundEndsAt" as ${render(boundEndsAt)}` };
  const snapshot = found["snapshot"];
  if (!isText(snapshot)) return { problem: `has "reviewer.snapshot" as ${render(snapshot)}` };

  const reviewer: ReviewerSession = {
    ...place.place,
    process: started,
    boundEndsAt,
    snapshot,
  };
  return { record: { ...under, reviewer } };
}

function reviewedFrom(entry: Record<string, unknown>, shared: Shared): ReadRecord {
  const read = roundFrom(entry["round"]);
  if ("problem" in read) return read;
  const { round } = read;
  let kept: { round?: ReviewedRound } & RoundReport = {};
  if (round !== undefined) {
    const { reviewer } = round;
    if (reviewer === undefined) return { problem: "is reviewed, and has a round with no reviewer" };
    kept = { round: { ...round, reviewer } };
  }
  const report = reportFrom(entry);
  if ("problem" in report) return report;
  kept = { ...kept, ...report.report };
  const result = entry["result"];
  const exitStatus = entry["exitStatus"];
  if (result === "clean, episode open") {
    if (exitStatus !== undefined) {
      return { problem: `is reviewed clean with the episode open, which has no exit status, and has "exitStatus" as ${render(exitStatus)}` };
    }
    return { record: { ...shared, status: "reviewed", result, ...kept } };
  }
  if (result !== "exited") return { problem: `has "result" as ${render(result)}` };

  if (exitStatus !== 0 && exitStatus !== 2 && exitStatus !== 3) {
    return { problem: `has "exitStatus" as ${render(exitStatus)} rather than 0, 2 or 3` };
  }
  const openThreads = entry["openThreads"];
  if (!Array.isArray(openThreads) || !openThreads.every(isText)) {
    return { problem: `has "openThreads" as ${render(openThreads)} rather than an array of thread ids` };
  }
  const closedAt = entry["closedAt"];
  if (closedAt !== undefined && closedAt !== "round cap" && closedAt !== "token bound") {
    return { problem: `has "closedAt" as ${render(closedAt)} rather than "round cap" or "token bound"` };
  }
  const bound: { closedAt?: ClosingBound } = closedAt === undefined ? {} : { closedAt };
  return { record: { ...shared, status: "reviewed", result, exitStatus, openThreads, ...bound, ...kept } };
}

function closedFrom(found: unknown): { readonly closed: ClosedBeforeReview } | { readonly problem: string } {
  if (!isObject(found)) return { problem: `has "closed" as ${render(found)}` };
  const exitStatus = found["exitStatus"];
  if (exitStatus !== 0 && exitStatus !== 3) {
    return { problem: `has "closed.exitStatus" as ${render(exitStatus)} rather than 0 or 3` };
  }
  const openThreads = found["openThreads"];
  if (!Array.isArray(openThreads) || !openThreads.every(isText)) {
    return { problem: `has "closed.openThreads" as ${render(openThreads)} rather than an array of thread ids` };
  }
  const closedAt = found["closedAt"];
  if (closedAt !== "round cap" && closedAt !== "token bound") {
    return { problem: `has "closed.closedAt" as ${render(closedAt)} rather than "round cap" or "token bound"` };
  }
  const problems = found["problems"];
  if (problems !== undefined && !isLines(problems)) {
    return { problem: `has "closed.problems" as ${render(problems)} rather than an array of lines` };
  }
  return { closed: { exitStatus, openThreads, closedAt, ...(problems === undefined ? {} : { problems }) } };
}

type ReadReport = { readonly report: RoundReport } | { readonly problem: string };

function reportFrom(entry: Record<string, unknown>): ReadReport {
  const newFindings = entry["newFindings"];
  if (newFindings !== undefined && !(typeof newFindings === "number" && Number.isInteger(newFindings) && newFindings >= 0)) {
    return { problem: `has "newFindings" as ${render(newFindings)} rather than a whole number` };
  }
  const moved = entry["moved"];
  if (moved !== undefined && !isText(moved)) return { problem: `has "moved" as ${render(moved)}` };
  const problems = entry["problems"];
  if (problems !== undefined && !isLines(problems)) {
    return { problem: `has "problems" as ${render(problems)} rather than an array of lines` };
  }
  const unthreaded = entry["unthreaded"];
  if (unthreaded !== undefined && !isLines(unthreaded)) {
    return { problem: `has "unthreaded" as ${render(unthreaded)} rather than an array of lines` };
  }
  const unposted = entry["unposted"];
  let unpostedRead: { failed: number; of: number } | undefined;
  if (unposted !== undefined) {
    const failed = isObject(unposted) ? unposted["failed"] : undefined;
    const of = isObject(unposted) ? unposted["of"] : undefined;
    if (!isWholeSeconds(failed) || !isWholeSeconds(of) || failed > of) {
      return { problem: `has "unposted" as ${render(unposted)} rather than how many failed of how many` };
    }
    unpostedRead = { failed, of };
  }
  return {
    report: {
      ...(unpostedRead === undefined ? {} : { unposted: unpostedRead }),
      ...(newFindings === undefined ? {} : { newFindings }),
      ...(moved === undefined ? {} : { moved }),
      ...(problems === undefined ? {} : { problems }),
      ...(unthreaded === undefined ? {} : { unthreaded }),
    },
  };
}

function isLines(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isText);
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
