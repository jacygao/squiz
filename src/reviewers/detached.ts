/**
 * The tools a reviewer CLI starts outside the reviewer's own process group.
 *
 * Signalling the reviewer's group reaches every tool that stayed in it. A tool
 * the CLI spawns detached is not one of those: it leads a group of its own, and
 * no identifier of the reviewer's group names it. Its parent is the reviewer for
 * as long as the reviewer is alive, so such a tool is found by walking the
 * process table back to the reviewer, and only while the reviewer is still there
 * to be walked back to. That is why the table is read as the round runs rather
 * than once at the end: a reviewer that exits on its own leaves its detached
 * tools parented to the system, where nothing says whose they were.
 *
 * Nothing here signals what it cannot prove is what it recorded. Identifiers are
 * reused, and killing a stranger's process over a reused one is worse than the
 * tool this exists to stop. A group is signalled only where the process holding
 * its identifier still leads that group and still started at the moment it was
 * recorded starting.
 *
 * Nothing throws. Every path here runs while a round is already ending, and the
 * round returns a value whatever this does.
 */

import { execFile } from "node:child_process";

/**
 * How often the process table is read while the reviewer runs.
 *
 * It bounds how much of a reviewer's life goes unwatched: a tool started within
 * one interval of a reviewer exiting on its own is never attributed to it. A
 * reviewer the round signals has no such gap, because the reading before the
 * signal is taken while the reviewer is still there.
 */
export const LOOK_MS = 250;

/** How long one reading of the process table may take before it is abandoned. */
const TABLE_TIMEOUT_MS = 2_000;

/** Room for a whole table on a busy machine, well above what one round needs. */
const TABLE_LIMIT_BYTES = 8 * 1_024 * 1_024;

/** The longest chain of parents walked, so a table read mid-change cannot loop. */
const ANCESTRY_LIMIT = 64;

/** The tools of one round that sit outside the reviewer's process group. */
export type Detached = {
  /**
   * The groups to signal: recorded, still running, and each still led by the
   * process that was recorded leading it.
   *
   * It reads the process table, so it also finds groups not recorded yet. A
   * caller about to signal the reviewer asks for it first, because the reviewer
   * is what the ancestry leads back to.
   */
  readonly groups: () => Promise<readonly number[]>;
  /**
   * Whether anything recorded might still be running. It sends nothing and reads
   * no table, so a wait may ask it as often as it likes.
   */
  readonly left: () => boolean;
  /** Stop reading the table. The round has stopped waiting for what is in it. */
  readonly stopLooking: () => void;
};

/** A round with nothing outside its group to look for, which costs nothing. */
export const nothingDetached: Detached = Object.freeze({
  groups: (): Promise<readonly number[]> => Promise.resolve([]),
  left: (): boolean => false,
  stopLooking: (): void => {},
});

/** One process: what ancestry needs, and what identity rests on. */
export type Process = {
  readonly pid: number;
  readonly parent: number;
  readonly group: number;
  /**
   * When it started, as the system reports it, to the second. It is what tells
   * the process that was recorded from the next one to hold its identifier.
   */
  readonly started: string;
};

/** A reading of the process table. Empty where it could not be read. */
export type Table = () => Promise<readonly Process[]>;

/**
 * Start watching for tools the reviewer puts outside its own group.
 *
 * `reviewer` is the reviewer's identifier, which is also its group's, and
 * `table` is how the process table is read. A test passes its own to put a
 * reused identifier in front of this.
 */
export function watchDetached(reviewer: number, table: Table = processTable): Detached {
  /** Each group found, against the start time of the leader found holding it. */
  const recorded = new Map<number, string>();
  let looking = true;

  const groups = async (): Promise<readonly number[]> => {
    const listed = await table();
    const by = new Map(listed.map((one) => [one.pid, one]));
    // The reviewer leads its own group, so its identifier names that group even
    // once the reviewer is gone from the table.
    const own = by.get(reviewer)?.group ?? reviewer;
    for (const one of listed) {
      // Only a leader's identifier names a group, and only a group outside the
      // reviewer's own needs a signal of its own.
      if (one.group === own || one.pid !== one.group) continue;
      if (descends(one, reviewer, by)) recorded.set(one.group, one.started);
    }
    return confirmed(recorded, by);
  };

  const left = (): boolean => {
    for (const group of recorded.keys()) {
      try {
        // Signal 0 asks whether the group could be signalled, and sends nothing.
        process.kill(-group, 0);
        return true;
      } catch {
        // Nothing left of it, or what holds the identifier now is not ours. A
        // wait has nothing to wait for either way, and it is the confirmation
        // before a signal that keeps a stranger's group from being sent one.
      }
    }
    return false;
  };

  const keepLooking = async (): Promise<void> => {
    while (looking) {
      await pause(LOOK_MS);
      if (!looking) return;
      try {
        await groups();
      } catch {
        // A reading that failed is one fewer reading. What has to find anything
        // is the reading the caller takes before it signals.
      }
    }
  };
  void keepLooking();

  return {
    groups,
    left,
    stopLooking: (): void => {
      looking = false;
    },
  };
}

/**
 * The groups still worth signalling, and the record pruned of what is not.
 *
 * A leader absent from the table is gone, or has exited leaving its group with
 * members. Those two cannot be told apart from here and neither is a group this
 * is entitled to signal, so the record keeps it and nothing is sent to it.
 */
function confirmed(
  recorded: Map<number, string>,
  by: Map<number, Process>,
): readonly number[] {
  const live: number[] = [];
  for (const [group, started] of recorded) {
    const leader = by.get(group);
    if (leader === undefined) continue;
    if (leader.group !== group || leader.started !== started) {
      // Another process holds the identifier, so this group never will be ours.
      recorded.delete(group);
      continue;
    }
    live.push(group);
  }
  return live;
}

/** Whether the process is below the ancestor, by its chain of parents. */
function descends(one: Process, ancestor: number, by: Map<number, Process>): boolean {
  let at: Process | undefined = one;
  for (let steps = 0; steps < ANCESTRY_LIMIT; steps += 1) {
    if (at === undefined) return false;
    if (at.parent === ancestor) return true;
    at = by.get(at.parent);
  }
  return false;
}

/**
 * The process table, from `ps`.
 *
 * Node has no reading of its own, and `ps` is what the platforms the harness
 * runs on have. A reading that failed comes back empty: a round that could not
 * look signals nothing, rather than being a round that failed.
 */
function processTable(): Promise<readonly Process[]> {
  return new Promise((settle) => {
    execFile(
      "ps",
      ["-A", "-o", "pid=,ppid=,pgid=,lstart="],
      { encoding: "utf8", timeout: TABLE_TIMEOUT_MS, maxBuffer: TABLE_LIMIT_BYTES },
      (failed, listed) => settle(failed === null ? read(listed) : []),
    );
  });
}

/** One process a line: the three identifiers, and then the start time. */
const LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*?)\s*$/u;

/** Read what `ps` wrote, keeping the lines that are a process and no others. */
export function read(listed: string): readonly Process[] {
  const table: Process[] = [];
  for (const line of listed.split("\n")) {
    const fields = LINE.exec(line);
    if (fields === null) continue;
    const [, pid, parent, group, started] = fields;
    if (pid === undefined || parent === undefined || group === undefined) continue;
    if (started === undefined) continue;
    table.push({
      pid: Number(pid),
      parent: Number(parent),
      group: Number(group),
      started,
    });
  }
  return table;
}

/** A wait that cannot hold the process open, so a look left running cannot either. */
function pause(milliseconds: number): Promise<void> {
  return new Promise((settle) => {
    setTimeout(settle, milliseconds).unref();
  });
}
