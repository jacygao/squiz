/**
 * `stopped.json`: what a headless run's caller waits on, beside `closed.json`,
 * where its episode stops short of its close.
 *
 * It says the episode has stopped only once nothing more happens without
 * someone acting: no close, no state queued or under review, and no fixer
 * running. One written before that would tell the caller to stop waiting on an
 * episode that goes on. A trigger removes it in the update that queues the
 * next state, so it never stands beside a round that runs.
 */

import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EpisodeState } from "../loop/episode-state.ts";
import type { Episode } from "../loop/episode.ts";
import { handsBack } from "./handoff.ts";

export const STOP_FILE = "stopped.json";

// Why a round that handed its threads back started no fixer, where it got no handoff to start one on.
export const NO_HANDOFF = "no handoff was written";

export type StopCase =
  | "round failed"
  | "fixer did not start"
  | "fixer queued nothing"
  | "earlier fixer queued nothing"
  | "fixer outlived its bound";

/** What `stopped.json` holds: the head the episode stopped on, which case stopped it, and why. */
export type Stop = { readonly head: string; readonly stopped: StopCase; readonly reason: string };

export type Stopping =
  | { readonly outcome: "stopped"; readonly stop: Stop }
  /** The episode closed, has more to run, or may: `quiet` where that is ordinary, and not worth a line. */
  | { readonly outcome: "not stopped"; readonly reason: string; readonly quiet: boolean };

/**
 * Where the episode `state` holds has stopped short of its close, and why.
 *
 * The caller has seen every fixer the records name as started exit, or gives
 * `outlived`, the stop of one it waited on out to its bound. Otherwise a fixer
 * whose start could not be told may still be running, so while one is on
 * record the episode has not stopped.
 */
export function stopOf(state: EpisodeState, outlived?: Stop): Stopping {
  const records = state.records ?? [];
  if (state.closeReported === true) return { outcome: "not stopped", reason: "the episode has closed", quiet: true };
  if (records.some((record) => record.status === "queued" || record.status === "reviewing")) {
    return { outcome: "not stopped", reason: "a state is queued or under review", quiet: true };
  }
  if (outlived !== undefined) return { outcome: "stopped", stop: outlived };
  for (const record of records) {
    if (record.status === "reviewed" && record.result === "exited" && record.fixer?.outcome === "unknown") {
      return { outcome: "not stopped", reason: `whether the fixer round ${record.round.number} started could not be told, so it may still be running`, quiet: false };
    }
  }
  const last = records.at(-1);
  if (last?.status === "failed") return { outcome: "stopped", stop: { head: last.head, stopped: "round failed", reason: last.reason } };
  if (last === undefined || !handsBack(last)) {
    return { outcome: "not stopped", reason: `the last state recorded is ${last?.status ?? "none"}, which names no stop`, quiet: false };
  }

  const stopped = (stopped: StopCase, reason: string): Stopping => ({ outcome: "stopped", stop: { head: last.head, stopped, reason } });
  const round = last.round.number;
  const fixer = last.fixer;
  switch (fixer?.outcome) {
    case undefined:
      return stopped("fixer did not start", "no start of a fixer was recorded");
    case "failed":
      return stopped("fixer did not start", fixer.reason);
    case "started":
      return stopped("fixer queued nothing", `the fixer round ${round} started, process ${fixer.process.pid}, exited, and its run queued nothing`);
    case "exited":
      return stopped("fixer queued nothing", `the fixer round ${round} started, process ${fixer.pid}, exited, and its run queued nothing`);
    case "unknown":
      // Ruled out above, with every other fixer that could not be told.
      return { outcome: "not stopped", reason: "the fixer's start could not be told", quiet: false };
    case "not started": {
      if (fixer.reason === NO_HANDOFF) return stopped("fixer did not start", fixer.reason);
      const earlier = records.findLast((record) => record !== last && handsBack(record) && (record.fixer?.outcome === "started" || record.fixer?.outcome === "exited"));
      const by = earlier !== undefined && handsBack(earlier) ? `the one round ${earlier.round.number} started` : "an earlier one";
      return stopped("earlier fixer queued nothing", `round ${round} started no fixer while ${by} ran, and that one's last stop queued nothing`);
    }
  }
}

/**
 * Write `value` as JSON to `path`, whole or not at all, so a caller waiting on
 * the file never reads half of it. Throws what the filesystem throws.
 */
export function writeWhole(path: string, value: unknown): void {
  const beside = `${path}.${process.pid}`;
  writeFileSync(beside, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(beside, path);
}

/** Remove the episode's `stopped.json` where it has one. Never throws: says why it could not, or nothing. */
export function clearStop(episode: Episode): string | undefined {
  const path = join(episode.directory, STOP_FILE);
  try {
    rmSync(path, { force: true });
    return undefined;
  } catch (cause) {
    return `${path} could not be removed: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
}
