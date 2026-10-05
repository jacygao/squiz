/**
 * `squiz status`: every review recorded in any worktree of the repository, one
 * line per pull request state.
 *
 * It reads state files, asks `ps` whether a round host is still running, and
 * runs `git worktree list`. It starts nothing and asks nothing of GitHub, so a
 * coordinator can run it as often as it likes.
 *
 * One worktree that cannot be read never hides another. What could not be read
 * goes to stderr, a line each, and the table on stdout holds everything that
 * could.
 */

import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import { failureLine } from "../hook/report.ts";
import { deadlineIn } from "../reviewers/deadline.ts";
import { episodeNamed, type Episode } from "../loop/episode.ts";
import { readState } from "../loop/episode-state.ts";
import type { ReviewerPlace, StateRecord } from "../loop/state-record.ts";
import { stillRunning, type Presence, type ProcessIdentity } from "../sessions/process.ts";
import { runGit } from "../worktree/git.ts";

// Long enough for a loaded machine, short enough that a status over many
// records still returns promptly.
const PS_BOUND_MS = 2_000;
const GIT_BOUND_MS = 10_000;

/** Where to look, and how to tell what is running, for `collectStatus`. */
export type StatusOptions = {
  /** The main worktree. Every other worktree's path is printed relative to it. */
  readonly main: string;
  readonly presence: (identity: ProcessIdentity) => Presence;
  /** Whole seconds since the epoch. */
  readonly now: number;
};

/** One line of the table, every cell as printed. */
type Row = readonly [string, string, string, string, string, string, string, string, string, string];

/** The lines of one episode, newest first, and what orders it among the others. */
type EpisodeLines = {
  readonly rows: readonly Row[];
  /** A review waits or runs in it. */
  readonly active: boolean;
  /** The latest time any of its records carries, or `undefined` where none carries one. */
  readonly latest: number | undefined;
  readonly pullRequest: number;
  readonly worktree: string;
};

export type Collected = {
  readonly episodes: readonly EpisodeLines[];
  /** One line each, for what could not be read. */
  readonly problems: readonly string[];
};

const HEADER: Row = ["PR", "Commit", "Replies", "State", "Started", "Elapsed", "Result", "Session", "Worktree", "Resume"];
const NONE = "—";

/**
 * List every review recorded in the worktrees of the repository holding
 * `directory`. Never throws.
 */
export function squizStatus(directory: string): { readonly stdout: string; readonly stderr: string } {
  const listed = runGit(directory, ["worktree", "list", "--porcelain"], {
    until: deadlineIn(GIT_BOUND_MS),
  });
  if (!listed.ran) {
    return { stdout: "", stderr: failureLine(`no reviews listed: the worktrees could not be listed: ${listed.reason}`) };
  }
  const worktrees = worktreesIn(listed.stdout);
  const collected = collectStatus(worktrees, {
    // git lists the main worktree first.
    main: worktrees[0] ?? directory,
    presence: (identity) => stillRunning(identity, PS_BOUND_MS),
    now: Math.floor(Date.now() / 1_000),
  });
  return composeStatus(collected);
}

/** The worktree paths in `git worktree list --porcelain` output, the main one first. */
export function worktreesIn(porcelain: string): string[] {
  const paths: string[] = [];
  for (const stanza of porcelain.split(/\n\n+/u)) {
    const lines = stanza.split("\n");
    const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    // A bare repository has no files checked out, so no episode can live in it.
    if (path === undefined || path === "" || lines.includes("bare")) continue;
    paths.push(path);
  }
  return paths;
}

/** Read every episode in `worktrees` into lines. */
export function collectStatus(worktrees: readonly string[], options: StatusOptions): Collected {
  const episodes: EpisodeLines[] = [];
  const problems: string[] = [];
  for (const worktree of worktrees) {
    let names: string[];
    try {
      names = readdirSync(join(worktree, ".squiz"));
    } catch (cause) {
      // A worktree removed from disk that git still lists has taken its records
      // with it, as has one no review ever ran in. Neither hides anything.
      if (codeOf(cause) === "ENOENT" || codeOf(cause) === "ENOTDIR") continue;
      problems.push(`the reviews in ${worktree} could not be read: ${messageOf(cause)}`);
      continue;
    }
    for (const name of names) {
      const episode = episodeNamed(worktree, name);
      if (episode === undefined) continue;
      const read = readState(episode);
      if (read.outcome === "absent") continue;
      if (read.outcome === "unreadable") {
        problems.push(`the reviews of #${episode.id} in ${worktree} could not be read: ${read.reason}`);
        continue;
      }
      const records = read.state.records ?? [];
      if (records.length === 0) continue;
      episodes.push(linesOf(episode, records, options, problems));
    }
  }
  return { episodes, problems };
}

/**
 * The table and the problem lines for what `collectStatus` read.
 *
 * Episodes are ordered newest first by what their records carry:
 *
 * - an episode with a state queued or under review comes first, because a
 *   queued record carries no time and is newer than anything started;
 * - then the latest start or end any of its records carries;
 * - then the episode none of whose records carries a time, highest pull
 *   request number first.
 *
 * Within an episode, the state file keeps records in the order their states
 * were first queued, and they are printed in the reverse of it.
 */
export function composeStatus(collected: Collected): { readonly stdout: string; readonly stderr: string } {
  const stderr = collected.problems.map(failureLine).join("");
  const ordered = [...collected.episodes].sort(newestFirst);
  const rows = ordered.flatMap((episode) => episode.rows);
  if (rows.length === 0) {
    return { stdout: "No review is recorded in any worktree of this repository.\n", stderr };
  }
  return { stdout: table([HEADER, ...rows]), stderr };
}

function newestFirst(one: EpisodeLines, other: EpisodeLines): number {
  if (one.active !== other.active) return one.active ? -1 : 1;
  const latest = (other.latest ?? -1) - (one.latest ?? -1);
  if (latest !== 0) return latest;
  if (one.pullRequest !== other.pullRequest) return other.pullRequest - one.pullRequest;
  return one.worktree < other.worktree ? -1 : one.worktree > other.worktree ? 1 : 0;
}

function linesOf(
  episode: Episode,
  records: readonly StateRecord[],
  options: StatusOptions,
  problems: string[],
): EpisodeLines {
  const pullRequest = Number(episode.id);
  const place = worktreeShown(episode.worktree, options.main);
  let active = false;
  let latest: number | undefined;
  const rows: Row[] = [];
  for (const record of [...records].reverse()) {
    const line = lineOf(episode, record, options, problems);
    if (record.status === "queued" || record.status === "reviewing") active = true;
    for (const time of line.times) latest = latest === undefined ? time : Math.max(latest, time);
    rows.push([
      `#${episode.id}`,
      record.head.slice(0, 7),
      record.activity === null ? NONE : record.activity.slice(-6),
      line.state,
      line.started === undefined ? NONE : startedShown(line.started, options.now),
      line.elapsed === undefined ? NONE : duration(line.elapsed),
      line.result,
      line.session,
      place,
      line.resume,
    ]);
  }
  return { rows, active, latest, pullRequest, worktree: episode.worktree };
}

type Line = {
  readonly state: string;
  readonly started: number | undefined;
  readonly elapsed: number | undefined;
  readonly result: string;
  readonly session: string;
  readonly resume: string;
  /** Every time the record carries, for ordering. */
  readonly times: readonly number[];
};

function lineOf(episode: Episode, record: StateRecord, options: StatusOptions, problems: string[]): Line {
  switch (record.status) {
    case "queued":
      return { state: "queued", started: undefined, elapsed: undefined, result: NONE, session: NONE, resume: NONE, times: [] };
    case "not reviewed":
      return { state: "not reviewed", started: undefined, elapsed: undefined, result: record.reason, session: NONE, resume: NONE, times: [] };
    case "reviewing": {
      // The reviewer's start is the round's. Before the reviewer starts, the
      // host's start is the only time the record carries.
      const started = record.reviewer?.process.startedAt ?? record.host.startedAt;
      const { reviewer } = record;
      const session =
        reviewer === undefined ? NONE : sessionOf(reviewer, episode, roundOfSnapshot(reviewer.snapshot));
      const presence = options.presence(record.host);
      const times = [record.host.startedAt, started];
      if (presence.outcome === "gone") {
        // Nothing is running it, so no time is passing on it.
        return { state: "killed", started, elapsed: undefined, result: NONE, session, resume: NONE, times };
      }
      // A host nobody can say is gone may still be running the round, so the
      // line says what a running one says, and why that is not certain.
      const result = presence.outcome === "unknown" ? `the round host could not be checked: ${presence.reason}` : NONE;
      return { state: "reviewing", started, elapsed: options.now - started, result, session, resume: NONE, times };
    }
    case "reviewed":
    case "failed": {
      const result = record.status === "failed" ? record.reason : reviewedResult(record);
      const { round } = record;
      if (round === undefined) {
        return { state: record.status, started: undefined, elapsed: undefined, result, session: NONE, resume: NONE, times: [] };
      }
      return {
        state: record.status,
        started: round.startedAt,
        elapsed: round.endedAt - round.startedAt,
        result,
        session: round.reviewer === undefined ? NONE : sessionOf(round.reviewer, episode, round.number),
        resume: resumeOf(episode, round.number, problems),
        times: [round.startedAt, round.endedAt],
      };
    }
  }
}

function reviewedResult(record: StateRecord & { readonly status: "reviewed" }): string {
  if (record.result === "clean, episode open") return "nothing open, episode open";
  const count = record.openThreads.length;
  const open = count === 0 ? "nothing open" : `${count} thread${count === 1 ? "" : "s"} open`;
  // Exit 2 is a round that asked for another. 0 and 3 closed the episode.
  return record.exitStatus === 2 ? open : `${open}, review closed`;
}

/**
 * The backend and the label its pane or window was opened under,
 * `squiz-<number>-r<k>`. A person finds it by that label, never by the
 * backend's own id. Where the round is not known, the backend alone.
 */
function sessionOf(place: ReviewerPlace, episode: Episode, round: number | undefined): string {
  if (place.backend === "detached" || round === undefined) return place.backend;
  return `${place.backend} squiz-${episode.id}-r${round}`;
}

/** The `k` of a running round, which its snapshot's path names as `rounds/<k>/tree`. */
function roundOfSnapshot(snapshot: string): number | undefined {
  const named = /(?:^|\/)rounds\/([1-9][0-9]*)\/tree\/?$/u.exec(snapshot);
  return named === null ? undefined : Number(named[1]);
}

/**
 * The command in the round's `resume.txt`, or `—` where it has none.
 *
 * A file that is there and will not be read is a problem line as well, so `—`
 * is not taken for a session the round never kept.
 */
function resumeOf(episode: Episode, round: number, problems: string[]): string {
  const path = join(episode.directory, "rounds", String(round), "resume.txt");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    if (codeOf(cause) !== "ENOENT") problems.push(`${path} could not be read: ${messageOf(cause)}`);
    return NONE;
  }
  const line = text.split("\n", 1)[0]?.trim() ?? "";
  return line === "" ? NONE : line;
}

function worktreeShown(worktree: string, main: string): string {
  const path = relative(main, worktree);
  if (path === "") return ".";
  if (path.startsWith("..") || isAbsolute(path)) return worktree;
  return path;
}

/** The local time of day on the local day of `now`, and the date and minute on any other. */
function startedShown(seconds: number, now: number): string {
  const at = new Date(seconds * 1_000);
  const today = new Date(now * 1_000);
  const sameDay =
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate();
  if (sameDay) return [at.getHours(), at.getMinutes(), at.getSeconds()].map(twoDigits).join(":");
  const date = `${at.getFullYear()}-${twoDigits(at.getMonth() + 1)}-${twoDigits(at.getDate())}`;
  return `${date} ${twoDigits(at.getHours())}:${twoDigits(at.getMinutes())}`;
}

function duration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 60) return `${whole}s`;
  if (whole < 3_600) return `${Math.floor(whole / 60)}m ${twoDigits(whole % 60)}s`;
  return `${Math.floor(whole / 3_600)}h ${twoDigits(Math.floor(whole / 60) % 60)}m`;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

/** Each column as wide as its widest cell, two spaces apart, the last unpadded. */
function table(rows: readonly Row[]): string {
  const widths = HEADER.map((_, column) => Math.max(...rows.map((row) => [...row[column]!].length)));
  return rows
    .map((row) =>
      row
        .map((cell, column) => (column === row.length - 1 ? cell : cell + " ".repeat(widths[column]! - [...cell].length)))
        .join("  ")
        .trimEnd(),
    )
    .map((line) => `${line}\n`)
    .join("");
}

function codeOf(cause: unknown): unknown {
  return typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
