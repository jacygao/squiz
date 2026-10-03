/**
 * The process groups of the shells the reviewer starts, recorded by the shells
 * themselves, and how a round reaches them when it ends.
 *
 * A reviewer CLI that starts each shell tool detached makes that shell a group
 * leader, so the round's own signal to the reviewer's group never reaches it.
 * The shell is told to write its own group identifier before it runs the command
 * it was given, which reaches a tool started in the last instant before the
 * reviewer exits: the line is written whatever happens next.
 *
 * **A recorded identifier is not an identity.** The shell that wrote it exits
 * first and is reaped, and the number is then free for anything to hold. The
 * space of numbers turns over in well under one round, so a number left unheld
 * does not merely risk naming something else: it is expected to.
 *
 * So every shell leaves a process of this round's own in its group, under a name
 * no other round uses. The number cannot be handed out while that keeper holds
 * it, and the name is what the reading recognises. A group is signalled where it
 * holds a keeper of this round and where the system says nothing in it predates
 * the round; a group that holds neither is left alone, because a stranger's
 * process killed over a number it was handed is worse than a tool left running.
 *
 * **The reading taken before `SIGKILL` rests on the processes the first reading
 * saw, not on the keeper.** A group's number cannot be handed out while anything
 * is still in it, so a group that still holds one of those processes never
 * emptied and is the group that was signalled. That is what the escalation needs,
 * and the keeper cannot supply it: the keeper is in the group the `SIGTERM` went
 * to, and a keeper that answered it is gone by the second reading.
 *
 * The guard is against a stale number and against a record the reviewer garbled,
 * not against a reviewer that sets out to forge one. It cannot be: the record's
 * path is in the reviewer's own environment, and at the depth that grants a shell
 * the reviewer can write whatever it likes there.
 *
 * Nothing here throws. Every outcome is a value the caller reads, because this
 * runs inside a hook that may fail in any way except by preventing the coding
 * agent from finishing.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readSync, rmSync } from "node:fs";
import { join } from "node:path";

import { deadlineIn, type Deadline } from "./deadline.ts";

/**
 * The variable naming the record, read by the prefix inside the shell.
 *
 * The harness puts it on the reviewer's environment and every shell the reviewer
 * starts inherits it, so the prefix below carries no path of its own and is the
 * same text every round.
 */
export const RECORD_VARIABLE = "SQUIZ_GROUPS";

/**
 * The variable naming this round's keeper, read by the prefix inside the shell.
 *
 * It holds a name no other round uses, so a group holding a process under it is
 * this round's and not a later round's.
 */
export const KEEPER_VARIABLE = "SQUIZ_KEEPER";

/**
 * How many seconds a keeper holds its group's number.
 *
 * Longer than any round can last, so the number is still held when the round
 * reads it at shutdown, and short enough that a round killed before it could
 * signal anything leaves nothing behind for more than this.
 *
 * It has nothing to do with how long the keeper has to survive a signal, which
 * is not at all: the keeper holds the number until the round's first reading, and
 * the reading before `SIGKILL` rests on what that one saw.
 */
const KEEPER_SECONDS = 900;

/**
 * The lines every shell runs before the command it was given.
 *
 * `$$` is the shell's own identifier, and a shell started detached leads the
 * group that identifier names, so the first line records the group that holds
 * everything the command goes on to start.
 *
 * **The second line is what makes the record mean anything later.** A group's
 * number is free the moment the group empties, and the shell is reaped seconds
 * after it exits, so a number recorded and then left unheld comes to name
 * whatever the system hands it to next. A process of this round's own left in the
 * group holds the number until the round signals it, and carries a name only this
 * round uses where `ps` prints it for every program.
 *
 * The keeper is an ordinary sleep and answers `SIGTERM` like anything else. It
 * has only to be there when the round first reads the group, because the reading
 * before `SIGKILL` rests on the processes that first one saw.
 *
 * `exec -a` is a bash feature, and a shell without it starts no keeper. That
 * leaves the group unclaimable rather than wrongly claimed: the round refuses it
 * and a detached tool is left running, which is the safe direction. Nothing
 * reports that refusal yet, so such a round is silent about what it did not
 * reach.
 *
 * **The keeper leaves the shell's job table.** A backgrounded job stays in it, and
 * a bare `wait` in the command waits for every job there — so without `disown` a
 * command that joins its own parallel work would wait out the keeper's whole sleep
 * instead of returning. `disown` drops the job without touching its process group,
 * so the number stays held.
 *
 * Each line exits 0 whatever happens and says nothing on either stream. A command
 * that is a comment or is empty leaves these as the last thing the shell ran, so
 * a non-zero status here would be reported as that command's, and a complaint
 * here would arrive in the reviewer's tool output as though the command had made
 * it. The keeper's own streams go to `/dev/null` so that it holds neither of the
 * shell's pipes open.
 *
 * The redirection of stderr comes first, because a record that cannot be opened
 * is the shell's own complaint rather than `printf`'s, and it is made before the
 * command that would have silenced it runs.
 */
export const shellPrefix = [
  `printf '%s\\n' "$$" 2>/dev/null >> "\${${RECORD_VARIABLE}:-/dev/null}" || :`,
  `{ [ -n "\${${KEEPER_VARIABLE}:-}" ] && exec -a "\${${KEEPER_VARIABLE}}" sleep ${KEEPER_SECONDS} >/dev/null 2>&1 & } 2>/dev/null || :`,
].join("\n");

/** What one round owns on disk while it runs. */
export type RoundSpace = {
  /**
   * The round's own directory, which nothing outside the round reads. The
   * adapter writes whatever its CLI has to be handed as a file here.
   *
   * It is named for this round alone, so what a killed round left behind is
   * never taken for a later round's, and it goes when the round ends.
   */
  readonly directory: string;
  /** The file every shell the reviewer starts records the group it leads in. */
  readonly shellRecord: string;
  /**
   * What this round's keepers are called, which no other round uses.
   *
   * A recorded group holding a process under this name is this round's own. That
   * is what the record cannot say by itself: a number is free the moment its
   * group empties, so one recorded and left unheld comes to name whatever the
   * system hands it to next.
   */
  readonly keeperName: string;
  /**
   * When the space was made, which is before the reviewer started. Nothing the
   * round started can be older than this, and that is what tells a group of this
   * round from whatever else holds the number now.
   */
  readonly startedAt: number;
};

export type SpaceMade =
  | { readonly outcome: "made"; readonly space: RoundSpace }
  | { readonly outcome: "failed"; readonly reason: string };

/**
 * Make one round's own space inside `directory`.
 *
 * The record is created empty rather than left to the first shell, so that a
 * record holding nothing is a round whose shells recorded nothing rather than a
 * round that never had a record at all.
 */
export function makeRoundSpace(directory: string): SpaceMade {
  const round = randomUUID();
  const mine = join(directory, `round.${round}`);
  const shellRecord = join(mine, "groups");
  // Short enough to read in a process listing, and carrying enough of the round's
  // own identifier that no other round's keeper answers to it.
  const keeperName = `squiz-${round.slice(0, 8)}`;
  try {
    mkdirSync(mine, { recursive: true });
    closeSync(openSync(shellRecord, "w"));
  } catch (cause) {
    return { outcome: "failed", reason: `${mine} could not be made: ${reasonFor(cause)}` };
  }
  return {
    outcome: "made",
    space: { directory: mine, shellRecord, keeperName, startedAt: Date.now() },
  };
}

/** Remove the space. Never throws, and a removal that fails is not a failure. */
export function discardRoundSpace(space: RoundSpace): void {
  try {
    rmSync(space.directory, { recursive: true, force: true });
  } catch {
    // The round is over and nothing reads this directory again: its name is the
    // round's own, so no later round can take what is in it for its own.
  }
}

/**
 * As much of the record as is read.
 *
 * More than this is more identifiers than a system has process slots, so a file
 * longer than it was written by something other than the shells of one round.
 * The bound is what keeps a record the reviewer filled from being read into
 * memory whole.
 */
const RECORD_LIMIT = 1024 * 1024;

/**
 * The process groups the record names, each once, in the order they were written.
 *
 * A line that is not a process group identifier is dropped. Identifiers below 2
 * are dropped before anything else reaches them: `kill` sends to every process
 * the caller may signal for -1 and to the caller's own group for 0, so a record
 * holding either would have the round stop the machine or itself.
 *
 * Never throws. A record that cannot be read names no groups.
 */
export function recordedGroups(space: RoundSpace): readonly number[] {
  const groups = new Set<number>();
  for (const line of linesOf(space.shellRecord).split("\n")) {
    const group = Number(line.trim());
    if (!Number.isInteger(group) || group < 2) continue;
    groups.add(group);
  }
  return [...groups];
}

function linesOf(path: string): string {
  let file: number;
  try {
    file = openSync(path, "r");
  } catch {
    return "";
  }
  try {
    const buffer = Buffer.allocUnsafe(RECORD_LIMIT);
    const read = readSync(file, buffer, 0, RECORD_LIMIT, 0);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    closeSync(file);
  }
}

/** A group the round left alone, and what the system said about it. */
export type Refusal = {
  readonly group: number;
  readonly reason: string;
};

/** What the round did with the groups its shells recorded. */
export type GroupsStopped = {
  /** The groups the round signalled, whether or not anything was left in them. */
  readonly signalled: readonly number[];
  /** The recorded groups nothing was sent to, each with why. */
  readonly refused: readonly Refusal[];
};

/**
 * Stop everything left in the groups the round's shells recorded, and do not
 * return while any of it might still be running.
 *
 * `SIGTERM` first, then `SIGKILL` to whatever is left after the grace, and each
 * wait is bounded, so a tool that answers neither signal cannot hold the round
 * open. Identity is established again before the escalation, because a `SIGKILL`
 * cannot be taken back.
 *
 * A group nothing could be established about is refused rather than signalled,
 * so a machine with no `ps` leaves a detached tool running instead of risking a
 * stranger.
 *
 * **`until` bounds every reading, both of them and each batch within them.** The
 * grace bounds the signals and nothing else, so a `ps` that will not answer would
 * otherwise hold the round open with no bound at all — past the ceiling the
 * runtime kills the hook at, with the review's own spend unrecorded and nothing
 * posted. A reading cut short at it establishes nothing, which refuses every
 * group it covered rather than signalling any, and the round goes on to its
 * accounting and its posting.
 */
export async function stopRecordedGroups(
  space: RoundSpace,
  graceMs: number,
  until: Deadline,
): Promise<GroupsStopped> {
  const recorded = recordedGroups(space);
  if (recorded.length === 0) return { signalled: [], refused: [] };

  const judged = judge(recorded, space.startedAt, { by: "keeper", named: space.keeperName }, until);
  for (const group of judged.mine) signal(group, "SIGTERM");
  const left = await remaining(judged.mine, graceMs);
  if (left.length > 0) {
    // The grace has passed, so a group that has gone may have taken its number
    // with it. What is killed outright is only what still answers for itself.
    const again = judge(left, space.startedAt, { by: "continuity", pids: judged.pids }, until);
    for (const group of again.mine) signal(group, "SIGKILL");
    await remaining(again.mine, graceMs);
    return { signalled: judged.mine, refused: [...judged.refused, ...again.refused] };
  }
  return { signalled: judged.mine, refused: judged.refused };
}

/** What a reading asks the system for: the keeper before the signal, continuity after. */
type Identity =
  | { readonly by: "keeper"; readonly named: string }
  | { readonly by: "continuity"; readonly pids: ReadonlySet<number> };

type Judged = {
  /** The groups the system says hold only processes this round started. */
  readonly mine: readonly number[];
  readonly refused: readonly Refusal[];
  /** Every process the reading found in the groups it judged the round's own. */
  readonly pids: ReadonlySet<number>;
};

/**
 * Which of the recorded groups are still the groups the round recorded.
 *
 * A group with nothing left in it is neither signalled nor refused: there is
 * nothing to send to and nothing was mistaken for anything.
 */
function judge(
  groups: readonly number[],
  startedAt: number,
  identity: Identity,
  until: Deadline,
): Judged {
  const reading = membersOf(groups, until);
  if ("problem" in reading) {
    return {
      mine: [],
      refused: groups.map((group) => ({ group, reason: reading.problem })),
      pids: new Set(),
    };
  }

  // Every process of a group this round started began after the record was made.
  // A reading that says otherwise is a number that has come to name something
  // else, whether by reuse or because the record never named a shell of this
  // round at all.
  const roundSeconds = (Date.now() - startedAt) / 1_000 + CLOCK_SLACK_SECONDS;
  const mine: number[] = [];
  const refused: Refusal[] = [];
  const pids = new Set<number>();
  for (const group of groups) {
    const members = reading.members.get(group);
    if (members === undefined) continue;
    const older = members.find((member) => member.seconds === undefined);
    if (older !== undefined) {
      refused.push({ group, reason: `ps gave process ${older.pid} no elapsed time` });
      continue;
    }
    const before = members.find((member) => (member.seconds ?? 0) > roundSeconds);
    if (before !== undefined) {
      refused.push({
        group,
        reason: `process ${before.pid} in it has run for ${before.seconds ?? 0}s, longer than the round`,
      });
      continue;
    }
    if (!holds(members, identity)) {
      refused.push({ group, reason: missing(identity) });
      continue;
    }
    mine.push(group);
    for (const member of members) pids.add(member.pid);
  }
  return { mine, refused, pids };
}

/** Whether the group's processes are what the identity asks for. */
function holds(members: readonly Member[], identity: Identity): boolean {
  if (identity.by === "keeper") return members.some((member) => member.named === identity.named);
  return members.some((member) => identity.pids.has(member.pid));
}

/** Why the group was left alone, worded for the reading that left it. */
function missing(identity: Identity): string {
  if (identity.by === "keeper") {
    return `nothing in it is a keeper of this round, ${identity.named}`;
  }
  return "nothing in it was there when the round signalled it";
}

/**
 * How much older than the round a process may be and still be one of its own.
 *
 * `ps` counts elapsed time in whole seconds and the round's own clock is read in
 * milliseconds, so a shell started in the same second as the record was made can
 * report a second more than the round has run.
 */
const CLOCK_SLACK_SECONDS = 2;

/** One process of a recorded group, and how long it has been running. */
type Member = {
  readonly pid: number;
  /** `undefined` where `ps` gave an elapsed time that could not be read. */
  readonly seconds: number | undefined;
  /** `argv[0]`, which is the name a keeper of this round was started under. */
  readonly named: string;
};

type Membership =
  | { readonly members: ReadonlyMap<number, readonly Member[]> }
  | { readonly problem: string };

/**
 * How many groups one `ps` is asked about.
 *
 * A round's shells number in the tens, so the batching is for a record that
 * holds more identifiers than an argument list can carry rather than for an
 * ordinary round.
 */
const BATCH = 128;

/**
 * What is running in each of the groups named, asked of the system once.
 *
 * `-g` selects a process group on macOS and a session on Linux, and a shell
 * started detached leads both under one identifier, so a row belongs to a
 * recorded group where its own group is that identifier. A row of any other
 * group is another process of the same session and is not what `kill` to the
 * group would reach.
 */
function membersOf(groups: readonly number[], until: Deadline): Membership {
  const members = new Map<number, Member[]>();
  const wanted = new Set(groups);
  for (let at = 0; at < groups.length; at += BATCH) {
    const batch = groups.slice(at, at + BATCH);
    const read = ask(batch, until);
    if ("problem" in read) return read;
    for (const row of read.rows.split("\n")) {
      // The pid, the group and the elapsed time hold no space between them, and
      // the command holds as many as it likes, so only the first three are split
      // off and the rest of the row is the command.
      const [pid, group, elapsed, ...rest] = row.trim().split(/\s+/u);
      if (pid === undefined || group === undefined || elapsed === undefined) continue;
      const of = Number(group);
      if (!wanted.has(of)) continue;
      const held = members.get(of) ?? [];
      // `argv[0]`, which is what a keeper was given its name as.
      held.push({ pid: Number(pid), seconds: elapsedSeconds(elapsed), named: rest[0] ?? "" });
      members.set(of, held);
    }
  }
  return { members };
}

type Rows = { readonly rows: string } | { readonly problem: string };

function ask(groups: readonly number[], until: Deadline): Rows {
  const result = spawnSync("ps", ["-o", "pid=,pgid=,etime=,command=", "-g", groups.join(",")], {
    encoding: "utf8",
    // The elapsed time is parsed, so nothing about it may be worded by a locale.
    env: { ...process.env, LC_ALL: "C" },
    // Never zero, which `spawnSync` reads as no timeout at all, so a bound with
    // nothing left on it still cuts the call off rather than letting it run.
    timeout: Math.max(1, until.remaining()),
  });

  if (result.error !== undefined) {
    if (ranOut(result.error)) return { problem: PS_RAN_OUT };
    return { problem: `ps could not be run: ${result.error.message}` };
  }
  if (result.status === null) {
    return { problem: `ps was killed by ${result.signal ?? "a signal"} before it answered` };
  }
  const said = result.stdout.trim();
  const complaint = result.stderr.split("\n", 1)[0]?.trim() ?? "";
  // `ps` exits 1 where none of the groups it was asked about exists, which is an
  // answer rather than a failure, and says nothing on either stream.
  if (result.status !== 0 && !(said === "" && complaint === "")) {
    return { problem: `ps exited ${result.status}: ${complaint === "" ? said : complaint}` };
  }
  return { rows: said };
}

/**
 * What a `ps` the shutdown's bound cut short says, which is never a group that
 * could be signalled.
 *
 * A reading that was interrupted establishes nothing, and a round that read it as
 * an empty group would signal a number it knows nothing about.
 */
const PS_RAN_OUT = "ps ran out of the time the shutdown was given";

function ranOut(error: Error): boolean {
  return "code" in error && error.code === "ETIMEDOUT";
}

/**
 * `ps`'s elapsed time as a number of seconds, or nothing where it is not one.
 *
 * It arrives as `[[dd-]hh:]mm:ss`, so a process running for days is read as well
 * as one running for seconds.
 */
function elapsedSeconds(elapsed: string): number | undefined {
  const [days, clock] = elapsed.includes("-") ? elapsed.split("-", 2) : [undefined, elapsed];
  if (clock === undefined) return undefined;
  const parts = clock.split(":").map((part) => Number(part));
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isInteger(part))) {
    return undefined;
  }
  if (days !== undefined && !Number.isInteger(Number(days))) return undefined;
  const [first, second, third] = parts;
  const hours = parts.length === 3 ? (first ?? 0) : 0;
  const minutes = parts.length === 3 ? (second ?? 0) : (first ?? 0);
  const seconds = parts.length === 3 ? (third ?? 0) : (second ?? 0);
  return Number(days ?? 0) * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}

/** How often a group is asked whether anything of it is left. */
const POLL_MS = 25;

/** Which of the groups still hold something, waited for rather than assumed. */
async function remaining(groups: readonly number[], milliseconds: number): Promise<number[]> {
  if (groups.length === 0) return [];
  const bound = deadlineIn(milliseconds);
  for (;;) {
    const left = groups.filter(groupRuns);
    if (left.length === 0) return [];
    if (bound.passed()) return left;
    await pause(POLL_MS);
  }
}

/** Whether anything is still running in the group. */
function groupRuns(group: number): boolean {
  try {
    // Signal 0 asks whether the group could be signalled, and sends nothing.
    process.kill(-group, 0);
    return true;
  } catch (cause) {
    // Refused rather than absent means it is there and not ours to signal.
    return codeOf(cause) === "EPERM";
  }
}

/** Send the signal to the group, and carry on where the system refuses it. */
function signal(group: number, sent: NodeJS.Signals): void {
  try {
    // A negative identifier is the group rather than one process, so what the
    // shell started is reached whether or not the shell is still there.
    process.kill(-group, sent);
  } catch {
    // Nothing left in it, or nothing of it this process may signal. The wait
    // that follows is what bounds this either way.
  }
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((settle) => {
    setTimeout(settle, milliseconds);
  });
}

function codeOf(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function reasonFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
