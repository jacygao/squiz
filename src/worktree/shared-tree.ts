/**
 * Whether another episode is live in this worktree.
 *
 * A shared tree makes the tracked-file comparison meaningless. A reading taken
 * around one reviewer, in a tree a second episode is also writing, names that
 * episode's work as this reviewer's. So a round asks this, and where the answer
 * is yes, or cannot be had, it says so and does not compare.
 *
 * **An episode is live until it reports its close.** The unit is the episode and
 * not the round, because the writing does not stop between rounds: a round exits
 * 2, the coding agent resumes editing the tree to address the findings, and the
 * episode has no process of its own for the whole of that interval. A reviewer
 * that ran then, in that tree, would have those edits read back as its own.
 *
 * **What is on disk is read toward live rather than away from it.** An episode
 * abandoned mid-flight, whose hook the runtime killed, is indistinguishable from
 * one whose coding agent is working, and the two answers cost differently: read
 * as live, an abandoned episode disables a comparison, and read as gone, a live
 * one yields a clean reading that is false. One worktree holds one episode, so a
 * second episode's state in a tree is already something the design does not
 * produce, and erring toward live only fires there.
 *
 * **A round in flight is named as well, by a marker naming its process.** It is
 * what says which round is in flight rather than whether the episode is, and it
 * is the whole of the answer during an episode's first round, because nothing
 * reaches the state file until a round has something to record. It can only make
 * an episode live, never leave one for dead.
 *
 * **A pid is not an identity, so the marker carries the process's start time as
 * the system words it.** Pids are reused. A marker outlives its round whenever
 * the runtime kills the hook, because none of the round's own cleanup runs then,
 * and a marker that has sat for hours can name a pid that now belongs to
 * something else. The start time is read with the locale and the time zone
 * pinned, because it is compared as the system wrote it: two sessions in one tree
 * carry two environments, and the same process words itself differently in each.
 *
 * **A round the runtime killed leaves a marker naming a process that has gone,
 * and the next round reads that as no round of that episode in flight.** The
 * episode is still live, on its state file, until something reports its close.
 * Removing the marker is hygiene rather than correctness: a marker whose process
 * has exited already reads as no round running.
 *
 * Two toplevels are compared as directories rather than as strings. Symlinks and
 * a case-insensitive filesystem give one directory several spellings, and two
 * spellings of the shared tree must not read as two trees.
 *
 * Nothing here throws. Every answer, git's failure included, is a value the
 * caller reads, because a round that cannot tell must not claim the comparison
 * is valid.
 */

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { dirname, join } from "node:path";

import { readState } from "../loop/episode-state.ts";
import { episodeAt, type Episode } from "../loop/episode.ts";
import { worktreeToplevel } from "./toplevel.ts";

/** An episode of this worktree that has not reported its close. */
export type LiveEpisode = {
  /** The episode key, as the directory holding its state spells it. */
  readonly id: string;
  /**
   * The process running a round of it, or `null` where no round of it is in
   * flight, which is every moment between two of its rounds.
   */
  readonly pid: number | null;
};

/**
 * What asking about the other episodes in this worktree established.
 *
 * `alone` is a tree this round has to itself. `unknown` is a tree nothing could
 * be established about, and it is not `alone`: a round that read it as one would
 * claim a comparison is valid without having found out.
 */
export type OtherEpisodes =
  | { readonly outcome: "shared"; readonly episodes: readonly LiveEpisode[] }
  | { readonly outcome: "alone" }
  | { readonly outcome: "unknown"; readonly reason: string };

/** `failed` means no other round learns which round is in flight, and why. */
export type MarkWrite =
  | { readonly outcome: "written" }
  | { readonly outcome: "failed"; readonly reason: string };

const markerName = "running.json";

/**
 * The live episodes of the worktree holding `directory`, other than the one
 * `agentId` keys.
 *
 * Never throws. The episode asking is never among them, whatever its state file
 * and its marker say.
 */
export function otherLiveEpisodes(directory: string, agentId: string): OtherEpisodes {
  const toplevel = worktreeToplevel(directory);
  if (toplevel.outcome === "failed") {
    return { outcome: "unknown", reason: `the worktree could not be resolved: ${toplevel.reason}` };
  }

  let mine: Episode;
  try {
    mine = episodeAt(toplevel.path, agentId);
  } catch (cause) {
    // Without our own directory name there is no leaving ourselves out, and an
    // episode that counted itself would call every tree it ran in shared.
    return { outcome: "unknown", reason: reasonFor(cause) };
  }

  // The episode module owns the layout inside a worktree, so where the episodes
  // sit is taken from one of them rather than spelled again here.
  const episodes = dirname(mine.directory);

  let entries: readonly Dirent[];
  try {
    entries = readdirSync(episodes, { withFileTypes: true });
  } catch (cause) {
    // No episode has ever written here, so none is live here either.
    if (isMissing(cause)) return { outcome: "alone" };
    return { outcome: "unknown", reason: `${episodes} could not be read: ${reasonFor(cause)}` };
  }

  const here = identityOf(toplevel.path);
  if ("problem" in here) return { outcome: "unknown", reason: here.problem };

  const live: LiveEpisode[] = [];
  const untold: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === mine.id) continue;
    const episode = episodeNamed(toplevel.path, entry.name);
    // A directory no episode key could have produced holds nobody's episode.
    if (episode === undefined) continue;

    const liveness = livenessOf(episode, here.identity);
    if (liveness.state === "live") live.push({ id: episode.id, pid: liveness.pid });
    else if (liveness.state === "unknown") untold.push(liveness.reason);
  }

  // A tree with a live episode in it is shared whatever else could not be read.
  // The comparison is off either way, and naming fewer episodes than are in
  // flight is the smaller wrong.
  if (live.length > 0) return { outcome: "shared", episodes: live.sort(byId) };
  if (untold.length > 0) return { outcome: "unknown", reason: untold.join("; ") };
  return { outcome: "alone" };
}

/**
 * Mark a round of `episode` as running, so that a round in another episode can
 * name it, creating the episode's directory where it is not there yet.
 *
 * Never throws. `failed` costs the naming of this round, and in an episode's
 * first round it costs the whole of the answer: nothing reaches the state file
 * until a round has something to record, so until then the marker is all there is
 * to find.
 */
export function markRoundRunning(episode: Episode): MarkWrite {
  const path = markerFor(episode);

  const started = startTimeOf(process.pid);
  // A marker that cannot be told from a reused pid is worse than no marker,
  // because it outlives the round: every later round in this tree would read a
  // pid it cannot judge, and none of them could name what is in flight.
  if (started.outcome === "failed") {
    return { outcome: "failed", reason: `${path} was not written: ${started.reason}` };
  }
  if (started.outcome === "gone") {
    return { outcome: "failed", reason: `${path} was not written: ps did not list this process` };
  }

  const marker: Marker = {
    pid: process.pid,
    startedAt: started.startedAt,
    toplevel: episode.worktree,
  };
  // A half-written marker cannot be read, and a marker that cannot be read is a
  // round nothing can judge, so the new marker is renamed over any old one.
  const partial = `${path}.${process.pid}.writing`;
  try {
    mkdirSync(episode.directory, { recursive: true });
    writeFileSync(partial, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
    renameSync(partial, path);
    return { outcome: "written" };
  } catch (cause) {
    discard(partial);
    return { outcome: "failed", reason: `${path} could not be written: ${reasonFor(cause)}` };
  }
}

/** Say the round has ended. Never throws, and a removal that fails is not a failure. */
export function clearRoundRunning(episode: Episode): void {
  try {
    unlinkSync(markerFor(episode));
  } catch {
    // What is left behind names a process that is about to exit, and a marker
    // whose process has gone already reads as no round running.
  }
}

/**
 * Whether one episode is live, and which of its rounds is in flight.
 *
 * `ended` is an episode that reported its close, and an episode that has
 * recorded nothing and is running no round.
 */
type Liveness =
  | { readonly state: "live"; readonly pid: number | null }
  | { readonly state: "ended" }
  | { readonly state: "unknown"; readonly reason: string };

function livenessOf(episode: Episode, here: DirectoryIdentity): Liveness {
  const round = roundIn(episode, here);
  if (round.state === "running") return { state: "live", pid: round.pid };

  const recorded = readState(episode);
  if (recorded.outcome === "read") {
    // A close is the only thing that ends an episode. Between its rounds it has
    // no process, and its coding agent is working in this tree.
    const closed = recorded.state.closeReported === true;
    return closed ? { state: "ended" } : { state: "live", pid: null };
  }
  // A state file that will not read cannot be shown to have closed.
  if (recorded.outcome === "unreadable") return { state: "unknown", reason: recorded.reason };

  // Nothing is recorded during an episode's first round, so a marker that could
  // not be read here may be the only round there is.
  if (round.state === "unknown") return { state: "unknown", reason: round.reason };
  return { state: "ended" };
}

/** What one episode's marker claims. Every field is required of it. */
type Marker = {
  readonly pid: number;
  /** The system's own words for when `pid` started, compared as it wrote them. */
  readonly startedAt: string;
  /** The worktree that round resolved, compared as a directory and not as text. */
  readonly toplevel: string;
};

type MarkerRead =
  | { readonly outcome: "read"; readonly marker: Marker }
  | { readonly outcome: "absent" }
  | { readonly outcome: "unreadable"; readonly reason: string };

/**
 * Whether a round of `episode` is running in the worktree `here` identifies.
 *
 * `none` covers every way that is untrue: no marker at all, a marker whose
 * process has gone, a marker whose pid now belongs to something else, and a
 * marker naming another worktree.
 */
type Round =
  | { readonly state: "running"; readonly pid: number }
  | { readonly state: "none" }
  | { readonly state: "unknown"; readonly reason: string };

function roundIn(episode: Episode, here: DirectoryIdentity): Round {
  const read = markerIn(episode);
  if (read.outcome === "absent") return { state: "none" };
  if (read.outcome === "unreadable") return { state: "unknown", reason: read.reason };
  const marker = read.marker;

  const there = identityOf(marker.toplevel);
  if ("problem" in there) return { state: "unknown", reason: there.problem };
  // A round in another worktree shares nothing with this one, whichever
  // directory its marker turned up in.
  if (!sameDirectory(here, there.identity)) return { state: "none" };

  const present = processIsThere(marker.pid);
  if (present.outcome === "failed") return { state: "unknown", reason: present.reason };
  // The round was killed before it could clear its marker, or it ended and the
  // removal did not take.
  if (!present.there) return { state: "none" };

  const started = startTimeOf(marker.pid);
  if (started.outcome === "failed") return { state: "unknown", reason: started.reason };
  if (started.outcome === "gone") return { state: "none" };
  // The pid was reused: what holds it now is not the round that wrote this.
  if (started.startedAt !== marker.startedAt) return { state: "none" };

  return { state: "running", pid: marker.pid };
}

function markerIn(episode: Episode): MarkerRead {
  const path = markerFor(episode);

  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (cause) {
    if (isMissing(cause)) return { outcome: "absent" };
    return { outcome: "unreadable", reason: `${path} could not be read: ${reasonFor(cause)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    return { outcome: "unreadable", reason: `${path} is not valid JSON: ${reasonFor(cause)}` };
  }

  if (!isRecord(parsed)) {
    return { outcome: "unreadable", reason: `${path} holds no JSON object` };
  }

  const pid = parsed["pid"];
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1) {
    return { outcome: "unreadable", reason: `${path}: "pid" is no process id` };
  }

  const startedAt = parsed["startedAt"];
  if (typeof startedAt !== "string" || startedAt.trim() === "") {
    return { outcome: "unreadable", reason: `${path}: "startedAt" is no start time` };
  }

  const toplevel = parsed["toplevel"];
  if (typeof toplevel !== "string" || toplevel.trim() === "") {
    return { outcome: "unreadable", reason: `${path}: "toplevel" is no worktree` };
  }

  return { outcome: "read", marker: { pid, startedAt, toplevel } };
}

/**
 * The episode whose state the directory named `name` holds, or nothing where no
 * episode key could have produced that name.
 *
 * A name that is not what the key would have been stripped to is nobody's
 * episode, and reading it would read at paths no episode owns.
 */
function episodeNamed(worktree: string, name: string): Episode | undefined {
  try {
    const episode = episodeAt(worktree, name);
    return episode.id === name ? episode : undefined;
  } catch {
    return undefined;
  }
}

type Presence =
  | { readonly outcome: "asked"; readonly there: boolean }
  | { readonly outcome: "failed"; readonly reason: string };

/** Ask the system about a process without signalling it. */
function processIsThere(pid: number): Presence {
  try {
    process.kill(pid, 0);
    return { outcome: "asked", there: true };
  } catch (cause) {
    const code = codeOf(cause);
    if (code === "ESRCH") return { outcome: "asked", there: false };
    // The process is there and is somebody else's, which is what a shared tree
    // on a shared machine looks like.
    if (code === "EPERM") return { outcome: "asked", there: true };
    return {
      outcome: "failed",
      reason: `process ${pid} could not be asked about: ${reasonFor(cause)}`,
    };
  }
}

type StartTime =
  | { readonly outcome: "read"; readonly startedAt: string }
  | { readonly outcome: "gone" }
  | { readonly outcome: "failed"; readonly reason: string };

/**
 * When `pid` started, in the system's own words.
 *
 * `gone` is `ps`'s own answer for a process that is not there, which is an exit
 * of its own with nothing on either stream. Every other end is `failed`: an
 * inspection that was interrupted establishes nothing, and read as a process
 * that has gone it would answer that a live round had ended.
 *
 * The words are never parsed, only compared, so the locale and the time zone are
 * pinned to keep one process from wording itself differently in two sessions.
 */
function startTimeOf(pid: number): StartTime {
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });

  if (result.error !== undefined) {
    return { outcome: "failed", reason: `ps could not be run: ${result.error.message}` };
  }
  if (result.status === null) {
    return {
      outcome: "failed",
      reason: `ps was killed by ${result.signal ?? "a signal"} before it answered`,
    };
  }

  const said = firstLine(result.stdout);
  if (result.status === 0) {
    if (said !== "") return { outcome: "read", startedAt: said };
    return { outcome: "failed", reason: `ps exited 0 without saying when ${pid} started` };
  }

  const complaint = firstLine(result.stderr);
  if (said === "" && complaint === "") return { outcome: "gone" };
  return {
    outcome: "failed",
    reason: `ps exited ${result.status}: ${complaint === "" ? said : complaint}`,
  };
}

/**
 * What tells one directory from another: the filesystem's own identity for it.
 *
 * A path is not it. `/tmp` and `/private/tmp` on macOS, a symlinked worktree,
 * a trailing slash and two casings of one name are all several spellings of one
 * directory, and a shared tree spelled two ways has to compare equal.
 */
type DirectoryIdentity = { readonly device: number; readonly inode: number };

type IdentityRead = { readonly identity: DirectoryIdentity } | { readonly problem: string };

function identityOf(path: string): IdentityRead {
  try {
    const stats = statSync(path);
    return { identity: { device: stats.dev, inode: stats.ino } };
  } catch (cause) {
    return { problem: `${path} could not be identified: ${reasonFor(cause)}` };
  }
}

function sameDirectory(one: DirectoryIdentity, other: DirectoryIdentity): boolean {
  return one.device === other.device && one.inode === other.inode;
}

function markerFor(episode: Episode): string {
  return join(episode.directory, markerName);
}

function byId(one: LiveEpisode, other: LiveEpisode): number {
  if (one.id === other.id) return 0;
  return one.id < other.id ? -1 : 1;
}

function discard(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // The write has already failed and is already being reported. A file left
    // behind is not worth a second failure over.
  }
}

function firstLine(output: string): string {
  return output.split("\n", 1)[0]?.trim() ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return codeOf(error) === "ENOENT";
}

function codeOf(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function reasonFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
