/**
 * The lock that keeps an episode to one round host: `host.lock` in the episode's
 * directory, naming the pid and start time of the host that holds it.
 *
 * **A lock file only ever appears whole.** Its text is written to a file of the
 * writer's own and fsynced, then linked to the lock's name. A link fails where
 * the name exists, so of hosts racing for a lock no one holds exactly one links
 * it, and no reader can catch a lock half-written. A lock that does not read as
 * a pid and a start time was therefore made by something else, and nothing says
 * its maker has gone, so it is left alone and reported as unknown.
 *
 * **A lock naming a dead holder is replaced under a claim.** Two hosts can each
 * find the same holder gone, and the slower must not remove the lock the faster
 * has just put in its place. So a file naming a holder is removed only by the
 * host that has linked `host.lock.<pid>-<startedAt>.claim` for that holder, and
 * only after reading the file again under the claim and finding it still names
 * that holder. A dead holder writes nothing more, so the file cannot change
 * between that read and the removal. The taker then links its own lock as any
 * host does, and loses to any host that linked first.
 *
 * A claim names its taker, and one left by a taker that died is removed by the
 * same rule, under a claim for that taker.
 *
 * **"Unknown" is never "gone".** A holder `ps` could not tell running or gone
 * keeps its lock, and the caller reports it.
 *
 * Nothing here throws. Every answer is a value the caller reads.
 */

import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

import { identityOf, stillRunning, type Presence, type ProcessIdentity } from "../sessions/process.ts";

const LOCK_NAME = "host.lock";

// A claim left by a taker that died is removed under a claim of its own, and so
// on. A chain this deep means takers keep dying mid-takeover, which no retry
// mends, so it is reported instead of followed.
const CLAIM_DEPTH = 3;

// Each pass either takes the lock or finds it changed under it. Only a lock that
// keeps changing as fast as it is read uses them all up.
const ATTEMPTS = 8;

export type HostLockOptions = {
  /** Bounds each `ps` run to tell whether a holder is still running. */
  readonly boundMs: number;
  /** The identity the lock names. Read from `ps` where not given. */
  readonly self?: ProcessIdentity;
  /** Whether a holder is still running. `stillRunning` where not given. */
  readonly presence?: (identity: ProcessIdentity) => Presence;
};

export type Release =
  | { readonly outcome: "released" }
  /** The lock no longer names this host, so it was left as it is. */
  | { readonly outcome: "lost" }
  | { readonly outcome: "failed"; readonly reason: string };

export type HostLock = {
  readonly path: string;
  readonly holder: ProcessIdentity;
  /** Remove the lock if it still names this host. */
  release(): Release;
};

export type Taking =
  | { readonly outcome: "taken"; readonly lock: HostLock }
  /** A running host holds the lock, or is replacing a dead holder's. */
  | { readonly outcome: "held"; readonly holder: ProcessIdentity }
  | { readonly outcome: "unknown"; readonly reason: string };

/**
 * Take the host lock in `directory`, creating the directory where it is missing.
 *
 * A lock taken is released when the process exits, and before then by `release`.
 * A process killed outright leaves it, naming a holder that has gone, and the
 * next host takes it over.
 */
export function takeHostLock(directory: string, options: HostLockOptions): Taking {
  const self = options.self ?? ownIdentity(options.boundMs);
  if ("reason" in self) return { outcome: "unknown", reason: self.reason };
  try {
    mkdirSync(directory, { recursive: true });
  } catch (error) {
    return { outcome: "unknown", reason: `${directory} could not be made: ${messageOf(error)}` };
  }

  const path = join(directory, LOCK_NAME);
  const contender: Contender = {
    directory,
    self,
    presence: options.presence ?? ((identity) => stillRunning(identity, options.boundMs)),
  };
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const found = acquire(contender, path, 0);
    if (found.outcome === "changed") continue;
    if (found.outcome !== "acquired") return found;
    return { outcome: "taken", lock: holding(path, self) };
  }
  return { outcome: "unknown", reason: `${path} changed every time it was read, ${ATTEMPTS} times` };
}

type Contender = {
  readonly directory: string;
  readonly self: ProcessIdentity;
  readonly presence: (identity: ProcessIdentity) => Presence;
};

type Acquiring =
  | { readonly outcome: "acquired" }
  /** What stood in the way has gone, so trying again may succeed. */
  | { readonly outcome: "changed" }
  | { readonly outcome: "held"; readonly holder: ProcessIdentity }
  | { readonly outcome: "unknown"; readonly reason: string };

/**
 * Link `path` naming this host, or say why not.
 *
 * Where `path` names a holder that has gone, it is removed and "changed" comes
 * back. The caller tries again, and may then lose to a host that linked first.
 */
function acquire(contender: Contender, path: string, depth: number): Acquiring {
  const placed = place(path, contender.self);
  if (placed.outcome !== "exists") return placed;

  const found = holderOf(path);
  if (found.outcome === "absent") return { outcome: "changed" };
  if (found.outcome === "unknown") return found;
  const presence = contender.presence(found.holder);
  if (presence.outcome === "running") return { outcome: "held", holder: found.holder };
  if (presence.outcome === "unknown") {
    return { outcome: "unknown", reason: `whether ${describe(found.holder)}, named by ${path}, is running: ${presence.reason}` };
  }
  return removeStale(contender, path, found.holder, depth);
}

/** Remove `path` if it still names `holder`, which has gone, under a claim for that holder. */
function removeStale(contender: Contender, path: string, holder: ProcessIdentity, depth: number): Acquiring {
  if (depth >= CLAIM_DEPTH) {
    return { outcome: "unknown", reason: `${path} names ${describe(holder)}, and ${depth} takers in turn died taking it over` };
  }
  const claim = join(contender.directory, `${LOCK_NAME}.${holder.pid}-${holder.startedAt}.claim`);
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const claimed = acquire(contender, claim, depth + 1);
    if (claimed.outcome === "changed") continue;
    if (claimed.outcome !== "acquired") return claimed;
    try {
      const found = holderOf(path);
      if (found.outcome === "unknown") return found;
      if (found.outcome === "named" && sameIdentity(found.holder, holder)) unlinkSync(path);
      return { outcome: "changed" };
    } catch (error) {
      if (codeOf(error) === "ENOENT") return { outcome: "changed" };
      return { outcome: "unknown", reason: `${path} could not be removed: ${messageOf(error)}` };
    } finally {
      try {
        unlinkSync(claim);
      } catch {
        // A claim left behind names this host, and is removed as stale once it exits.
      }
    }
  }
  return { outcome: "unknown", reason: `${claim} changed every time it was read, ${ATTEMPTS} times` };
}

type Placing =
  | { readonly outcome: "acquired" }
  | { readonly outcome: "exists" }
  | { readonly outcome: "unknown"; readonly reason: string };

/** Link `path` into being, whole, naming `identity`, unless something already has that name. */
function place(path: string, identity: ProcessIdentity): Placing {
  const draft = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const descriptor = openSync(draft, "wx");
    try {
      writeSync(descriptor, `${JSON.stringify({ pid: identity.pid, startedAt: identity.startedAt })}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    removeQuietly(draft);
    return { outcome: "unknown", reason: `${draft} could not be written: ${messageOf(error)}` };
  }
  try {
    linkSync(draft, path);
    return { outcome: "acquired" };
  } catch (error) {
    if (codeOf(error) === "EEXIST") return { outcome: "exists" };
    return { outcome: "unknown", reason: `${path} could not be linked: ${messageOf(error)}` };
  } finally {
    removeQuietly(draft);
  }
}

type Holder =
  | { readonly outcome: "named"; readonly holder: ProcessIdentity }
  | { readonly outcome: "absent" }
  | { readonly outcome: "unknown"; readonly reason: string };

/** The identity `path` names. */
function holderOf(path: string): Holder {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (codeOf(error) === "ENOENT") return { outcome: "absent" };
    return { outcome: "unknown", reason: `${path} could not be read: ${messageOf(error)}` };
  }
  const holder = identityIn(text);
  if (holder === undefined) {
    return { outcome: "unknown", reason: `${path} names no pid and start time: ${JSON.stringify(text)}` };
  }
  return { outcome: "named", holder };
}

function identityIn(text: string): ProcessIdentity | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { pid, startedAt } = parsed as Record<string, unknown>;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1) return undefined;
  if (typeof startedAt !== "number" || !Number.isInteger(startedAt)) return undefined;
  return { pid, startedAt };
}

function holding(path: string, self: ProcessIdentity): HostLock {
  const release = (): Release => {
    process.off("exit", release);
    const found = holderOf(path);
    if (found.outcome === "unknown") return { outcome: "failed", reason: found.reason };
    if (found.outcome === "absent" || !sameIdentity(found.holder, self)) return { outcome: "lost" };
    // Only a host that found this one gone changes this lock, and this one is running.
    try {
      unlinkSync(path);
      return { outcome: "released" };
    } catch (error) {
      if (codeOf(error) === "ENOENT") return { outcome: "lost" };
      return { outcome: "failed", reason: `${path} could not be removed: ${messageOf(error)}` };
    }
  };
  process.once("exit", release);
  return { path, holder: self, release };
}

function ownIdentity(boundMs: number): ProcessIdentity | { readonly reason: string } {
  const read = identityOf(process.pid, boundMs);
  if (read.outcome === "read") return read.identity;
  return { reason: `this host's own start time could not be read: ${read.outcome === "unknown" ? read.reason : "ps says it is gone"}` };
}

function sameIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return left.pid === right.pid && left.startedAt === right.startedAt;
}

function describe(identity: ProcessIdentity): string {
  return `process ${identity.pid}, started at ${identity.startedAt}`;
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Nothing reads a draft by its name, so one left behind is litter and no more.
  }
}

function codeOf(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
